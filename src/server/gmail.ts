import {createHash} from "node:crypto";
import {normaliseUrl} from "../core/dedupe.js";
import {readGmailLabel} from "../config.js";
import {
    createGmailClient,
    fetchLeads,
    hasToken,
    loadAuth,
    type FetchedLead,
    type FetchResult,
    type GmailClient,
} from "../sources/gmail/index.js";
import type {TrackerStore, UpsertLead} from "../tracker/store.js";

/**
 * A lead's stable id is derived from its cleaned url, so the same posting
 * arriving under two tracking links maps to one row — url dedup for free, via
 * the primary key, on top of the explicit checks in `fetchLeads`.
 */
function leadId(url: string): string {
    return `lead:${createHash("sha1").update(normaliseUrl(url)).digest("hex").slice(0, 16)}`;
}

function toUpsertLead(lead: FetchedLead, fetchedAt: string): UpsertLead {
    return {
        sourceId: leadId(lead.url),
        source: "gmail",
        company: lead.company,
        title: lead.title,
        location: lead.location,
        url: lead.url,
        fetchedAt,
        leadSource: lead.leadSource,
        emailId: lead.emailId,
        emailDate: lead.emailDate,
        snippet: lead.snippet,
    };
}

export interface GmailFetchOptions {
    sinceDays?: number;
    max?: number;
    /** Parse and report without writing anything. */
    dryRun?: boolean;
    /** Injected in tests; the real client is built from the cached token otherwise. */
    client?: GmailClient;
}

export interface GmailFetchOutcome extends FetchResult {
    label: string;
    added: number;
}

/**
 * The whole Gmail-to-leads path in one place, shared by the CLI and the route:
 * gather what the tracker already holds, read the label, and upsert the new
 * leads. A dry run stops before the upsert.
 */
export async function runGmailFetch(
    store: TrackerStore,
    options: GmailFetchOptions = {},
): Promise<GmailFetchOutcome> {
    const client = options.client ?? createGmailClient(await loadAuth());
    const label = readGmailLabel();

    const result = await fetchLeads({
        client,
        label,
        ...(options.sinceDays !== undefined ? {sinceDays: options.sinceDays} : {}),
        ...(options.max !== undefined ? {maxMessages: options.max} : {}),
        seen: store.dedupeIndex(),
    });

    let added = 0;
    if (!options.dryRun) {
        const now = new Date().toISOString();
        added = store.upsertLeads(result.leads.map((lead) => toUpsertLead(lead, now))).added;
    }

    return {...result, label, added};
}

export interface GmailStatus {
    authorised: boolean;
    account: string | null;
    label: string;
    labelExists: boolean;
    labelMessages: number | null;
}

/**
 * What the toolbar's Gmail control needs: whether there is a token, whose
 * account it is, and whether the label exists. Never throws — an unauthorised
 * or misconfigured Gmail is a state to report, not an error.
 */
export async function gmailStatus(options: {client?: GmailClient} = {}): Promise<GmailStatus> {
    const label = readGmailLabel();
    if (!options.client && !(await hasToken())) {
        return {authorised: false, account: null, label, labelExists: false, labelMessages: null};
    }

    try {
        const client = options.client ?? createGmailClient(await loadAuth());
        const [account, resolved] = await Promise.all([
            client.profileEmail(),
            client.resolveLabel(label),
        ]);
        return {
            authorised: true,
            account,
            label,
            labelExists: resolved !== null,
            labelMessages: resolved?.messagesTotal ?? null,
        };
    } catch {
        return {authorised: false, account: null, label, labelExists: false, labelMessages: null};
    }
}
