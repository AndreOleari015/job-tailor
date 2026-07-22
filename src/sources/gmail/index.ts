import {Auth, google} from "googleapis";
import {identityKey, normaliseUrl} from "../../core/dedupe.js";
import {parserFor} from "./parsers/registry.js";
import type {ParsedLead} from "./parsers/types.js";
import {buildQuery} from "./query.js";

export type {ParsedLead} from "./parsers/types.js";
export {buildQuery} from "./query.js";
export {
    runAuthFlow,
    loadAuth,
    revokeToken,
    hasToken,
    GmailAuthError,
    GMAIL_SCOPES,
} from "./auth.js";

/** A message reduced to what a parser needs, MIME already decoded. */
export interface GmailMessage {
    id: string;
    from: string;
    subject: string;
    /** ISO date, or null when neither the header nor internalDate parses. */
    date: string | null;
    html: string;
    text: string;
}

export interface ResolvedLabel {
    id: string;
    messagesTotal: number;
}

/**
 * The slice of Gmail this tool uses, behind one interface so `fetchLeads` runs
 * in tests against a fake and never needs a live mailbox. Every method that
 * lists or reads mail is reached only through a query built by `buildQuery`,
 * which cannot omit the label.
 */
export interface GmailClient {
    profileEmail(): Promise<string>;
    resolveLabel(name: string): Promise<ResolvedLabel | null>;
    listMessageIds(query: string, max: number): Promise<string[]>;
    getMessage(id: string): Promise<GmailMessage>;
}

/** How many leads to allow per invocation, and the query default. */
export const DEFAULT_SINCE_DAYS = 7;
export const DEFAULT_MAX_MESSAGES = 100;
export const MAX_MESSAGES_CAP = 500;

export interface DedupeIndex {
    urls: Set<string>;
    identities: Set<string>;
    emailIds: Set<string>;
}

export interface FetchOptions {
    client: GmailClient;
    label: string;
    sinceDays?: number;
    maxMessages?: number;
    /** What the database already holds, so a fetch does not duplicate it. */
    seen?: DedupeIndex;
}

/** A parsed lead with its provenance, ready to become a tracker row. */
export interface FetchedLead extends ParsedLead {
    leadSource: string;
    emailId: string;
    emailDate: string | null;
}

export interface FetchResult {
    leads: FetchedLead[];
    messagesRead: number;
    /** Messages a named parser claimed but drew nothing from — the silent-break count. */
    unparsed: number;
}

export class GmailLabelError extends Error {
    override readonly name = "GmailLabelError";
}

function warn(message: string): void {
    process.stderr.write(`[job-tailor] ${message}\n`);
}

function emptyIndex(): DedupeIndex {
    return {urls: new Set(), identities: new Set(), emailIds: new Set()};
}

/**
 * Reads the configured label and turns its alert emails into leads.
 *
 * The label is resolved first: if it does not exist the run stops with an error
 * telling the user to create it, rather than quietly searching the whole
 * mailbox — the one thing `gmail.readonly` would otherwise allow. A message
 * whose id is already recorded is never fetched again, and a named parser that
 * claims a message but returns nothing is reported loudly, because a silently
 * broken template is how this feature fails.
 */
export async function fetchLeads(options: FetchOptions): Promise<FetchResult> {
    const {client, label} = options;
    const sinceDays = options.sinceDays ?? DEFAULT_SINCE_DAYS;
    const max = Math.min(options.maxMessages ?? DEFAULT_MAX_MESSAGES, MAX_MESSAGES_CAP);
    const seen = options.seen ?? emptyIndex();

    const resolved = await client.resolveLabel(label);
    if (!resolved) {
        throw new GmailLabelError(
            `No Gmail label "${label}". Create it and add a filter that applies it to your job ` +
                "alerts, so the tool reads only those. It never searches the whole mailbox. See the README.",
        );
    }

    const ids = await client.listMessageIds(buildQuery(label, sinceDays), max);

    // Copies, so the run's own leads dedupe against each other as well as the db.
    const urls = new Set(seen.urls);
    const identities = new Set(seen.identities);

    const leads: FetchedLead[] = [];
    let messagesRead = 0;
    let unparsed = 0;

    for (const id of ids) {
        if (seen.emailIds.has(id)) continue; // recorded already; never re-parsed

        const message = await client.getMessage(id);
        messagesRead += 1;

        const {parser, generic} = parserFor(message.from, message.subject);
        const parsed = parser.parse(message.html, message.text);

        const hadBody = Boolean(message.html.trim() || message.text.trim());
        if (!generic && parsed.length === 0 && hadBody) {
            unparsed += 1;
            warn(
                `${parser.name} matched ${message.from} (message ${id}) but extracted no leads — ` +
                    "the template may have changed. Check src/sources/gmail/parsers.",
            );
        }

        const leadSource = `gmail:${generic ? "generic" : parser.name}`;
        for (const lead of parsed) {
            const url = normaliseUrl(lead.url);
            const identity = identityKey(lead.company, lead.title, lead.location);
            if (urls.has(url) || identities.has(identity)) continue;

            urls.add(url);
            identities.add(identity);
            leads.push({...lead, leadSource, emailId: id, emailDate: message.date});
        }
    }

    return {leads, messagesRead, unparsed};
}

/* ------------------------------------------------------------------ */
/* The real client                                                      */
/* ------------------------------------------------------------------ */

function header(headers: {name?: string | null; value?: string | null}[], name: string): string {
    return headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function decodeBase64Url(data: string): string {
    return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

interface MessagePart {
    mimeType?: string | null;
    body?: {data?: string | null} | null;
    parts?: MessagePart[] | null;
}

/** Collects the text/plain and text/html bodies from a MIME tree. */
function collectBodies(part: MessagePart, into: {html: string; text: string}): void {
    const data = part.body?.data;
    if (data) {
        if (part.mimeType === "text/html") into.html += decodeBase64Url(data);
        else if (part.mimeType === "text/plain") into.text += decodeBase64Url(data);
    }
    for (const child of part.parts ?? []) collectBodies(child, into);
}

/** Builds a real client from an authorised OAuth2 client. */
export function createGmailClient(auth: Auth.OAuth2Client): GmailClient {
    // googleapis-common ships its own nested copy of google-auth-library, so the
    // OAuth2Client type is nominally distinct here though structurally identical.
    // One cast at this single boundary rather than loosening the type everywhere.
    const gmail = google.gmail({version: "v1", auth: auth as never});

    return {
        async profileEmail() {
            const {data} = await gmail.users.getProfile({userId: "me"});
            return data.emailAddress ?? "unknown";
        },

        async resolveLabel(name) {
            const {data} = await gmail.users.labels.list({userId: "me"});
            const match = (data.labels ?? []).find(
                (label) => label.name?.toLowerCase() === name.toLowerCase(),
            );
            if (!match?.id) return null;

            const {data: detail} = await gmail.users.labels.get({userId: "me", id: match.id});
            return {id: match.id, messagesTotal: detail.messagesTotal ?? 0};
        },

        async listMessageIds(query, max) {
            const ids: string[] = [];
            let pageToken: string | undefined;
            do {
                const {data} = await gmail.users.messages.list({
                    userId: "me",
                    q: query,
                    maxResults: Math.min(100, max - ids.length),
                    ...(pageToken ? {pageToken} : {}),
                });
                for (const message of data.messages ?? []) {
                    if (message.id) ids.push(message.id);
                }
                pageToken = data.nextPageToken ?? undefined;
            } while (pageToken && ids.length < max);
            return ids.slice(0, max);
        },

        async getMessage(id) {
            const {data} = await gmail.users.messages.get({userId: "me", id, format: "full"});
            const headers = data.payload?.headers ?? [];
            const bodies = {html: "", text: ""};
            if (data.payload) collectBodies(data.payload, bodies);

            const dateHeader = header(headers, "date");
            const parsedDate = dateHeader ? Date.parse(dateHeader) : NaN;
            const internal = data.internalDate ? Number(data.internalDate) : NaN;
            const millis = Number.isFinite(parsedDate)
                ? parsedDate
                : Number.isFinite(internal)
                  ? internal
                  : NaN;

            return {
                id,
                from: header(headers, "from"),
                subject: header(headers, "subject"),
                date: Number.isFinite(millis) ? new Date(millis).toISOString() : null,
                html: bodies.html,
                text: bodies.text,
            };
        },
    };
}
