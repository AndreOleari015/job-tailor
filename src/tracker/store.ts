import Database from "better-sqlite3";
import {mkdirSync, readFileSync} from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {identityKey, normaliseUrl} from "../core/dedupe.js";
import {detectLanguage} from "../sources/language.js";

export const DEFAULT_DATABASE_PATH = "data/tracker.db";

/* ------------------------------------------------------------------ */
/* State machine                                                        */
/* ------------------------------------------------------------------ */

export const STATUSES = [
    "lead",
    "new",
    "generating",
    "generated",
    "failed",
    "applied",
    "dismissed",
    "closed",
] as const;

export type Status = (typeof STATUSES)[number];

export const OUTCOMES = ["no_response", "rejected", "interview", "offer"] as const;
export type Outcome = (typeof OUTCOMES)[number];

/**
 * The only moves allowed. Enforced here rather than by a CHECK constraint so an
 * illegal move fails with a sentence a human can act on.
 */
const TRANSITIONS: Record<Status, readonly Status[]> = {
    // A lead is a sighting from an email alert: company, title and a link, but
    // no description yet. Pasting the description promotes it to `new`; there is
    // nothing to generate from until then.
    lead: ["new", "dismissed"],
    new: ["generating", "dismissed"],
    generating: ["generated", "failed"],
    failed: ["generating", "dismissed"],
    // Regenerating a generated posting is deliberate: a better prompt or a
    // corrected profile is a reason to run it again.
    generated: ["applied", "dismissed", "generating"],
    // applied -> generated undoes a click made too soon; applied -> closed
    // wraps it up. "Applied" is a fact about the outside world, and the outside
    // world is correctable.
    applied: ["closed", "generated"],
    dismissed: ["new"],
    // Closed is no longer terminal: an answer can arrive after you had written
    // a posting off, so it reopens to applied or back to generated.
    closed: ["applied", "generated"],
};

/**
 * The steps of one generation, in order. This is a detail of the `generating`
 * status, not a status: the state machine above is unchanged, and nothing
 * transitions on a stage.
 */
export const STAGES = ["queued", "extracting", "tailoring", "rendering"] as const;
export type Stage = (typeof STAGES)[number];

export function isStage(value: string): value is Stage {
    return (STAGES as readonly string[]).includes(value);
}

/** An outcome describes something that happened after applying. */
const OUTCOME_STATUSES: readonly Status[] = ["applied", "closed"];

export class TrackerError extends Error {
    override readonly name = "TrackerError";
}

export function isStatus(value: string): value is Status {
    return (STATUSES as readonly string[]).includes(value);
}

export function isOutcome(value: string): value is Outcome {
    return (OUTCOMES as readonly string[]).includes(value);
}

export function canTransition(from: Status, to: Status): boolean {
    return TRANSITIONS[from].includes(to);
}

/* ------------------------------------------------------------------ */
/* Records                                                              */
/* ------------------------------------------------------------------ */

export interface PostingRecord {
    sourceId: string;
    source: string | null;
    company: string | null;
    title: string | null;
    location: string | null;
    country: string | null;
    url: string | null;
    postedAt: string | null;
    fetchedAt: string | null;
    preScore: number | null;
    rawText: string | null;
    language: string | null;
    /** Set when the posting came from an email alert rather than a job source. */
    leadSource: string | null;
    emailId: string | null;
    emailDate: string | null;
    snippet: string | null;
    status: Status;
    /** The step a running generation is on. Null unless status is 'generating'. */
    stage: Stage | null;
    stageStartedAt: string | null;
    outDir: string | null;
    matchScore: number | null;
    flags: string[];
    gaps: string[];
    appliedAt: string | null;
    outcome: Outcome | null;
    notes: string | null;
    lastError: string | null;
    updatedAt: string;
}

/** A posting as the sources layer produces it, plus its ordering hint. */
export interface UpsertPosting {
    sourceId: string;
    source: string;
    company: string | null;
    title: string;
    location: string | null;
    country?: string | null;
    url: string;
    postedAt: string | null;
    fetchedAt: string;
    text: string;
    preScore?: number | null;
    language?: string | null;
}

/** A lead parsed from an email alert: a sighting, with no description yet. */
export interface UpsertLead {
    sourceId: string;
    source: string;
    company: string | null;
    title: string;
    location: string | null;
    url: string;
    fetchedAt: string;
    leadSource: string;
    emailId: string;
    emailDate: string | null;
    snippet: string | null;
}

export interface GenerationResult {
    outDir: string;
    matchScore: number;
    flags: readonly string[];
    gaps: readonly string[];
    /** Only `extract` knows the country; the sources layer never does. */
    country?: string | null;
}

export interface ListFilter {
    status?: string;
    country?: string;
    source?: string;
    /** "de" | "en" | "unknown", as detected in the sources layer. */
    language?: string;
    /** Substring match over company and title. */
    q?: string;
}

export interface Stats {
    byStatus: Record<string, number>;
    byOutcome: Record<string, number>;
    topGaps: {gap: string; count: number}[];
    total: number;
}

interface Row {
    source_id: string;
    source: string | null;
    company: string | null;
    title: string | null;
    location: string | null;
    country: string | null;
    url: string | null;
    posted_at: string | null;
    fetched_at: string | null;
    pre_score: number | null;
    raw_text: string | null;
    language: string | null;
    lead_source: string | null;
    email_id: string | null;
    email_date: string | null;
    snippet: string | null;
    status: string;
    stage: string | null;
    stage_started_at: string | null;
    out_dir: string | null;
    match_score: number | null;
    flags: string | null;
    gaps: string | null;
    applied_at: string | null;
    outcome: string | null;
    notes: string | null;
    last_error: string | null;
    updated_at: string;
}

function parseJsonArray(value: string | null): string[] {
    if (!value) return [];
    try {
        const parsed: unknown = JSON.parse(value);
        return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
        return [];
    }
}

function toRecord(row: Row): PostingRecord {
    return {
        sourceId: row.source_id,
        source: row.source,
        company: row.company,
        title: row.title,
        location: row.location,
        country: row.country,
        url: row.url,
        postedAt: row.posted_at,
        fetchedAt: row.fetched_at,
        preScore: row.pre_score,
        rawText: row.raw_text,
        language: row.language,
        leadSource: row.lead_source,
        emailId: row.email_id,
        emailDate: row.email_date,
        snippet: row.snippet,
        status: isStatus(row.status) ? row.status : "new",
        stage: row.stage && isStage(row.stage) ? row.stage : null,
        stageStartedAt: row.stage_started_at,
        outDir: row.out_dir,
        matchScore: row.match_score,
        flags: parseJsonArray(row.flags),
        gaps: parseJsonArray(row.gaps),
        appliedAt: row.applied_at,
        outcome: row.outcome && isOutcome(row.outcome) ? row.outcome : null,
        notes: row.notes,
        lastError: row.last_error,
        updatedAt: row.updated_at,
    };
}

/**
 * Generated first because it is what needs acting on, then new, then leads —
 * an email sighting waiting for a pasted description is live work, so it sits
 * just below new, above the failed/applied/archived tail rather than dead last.
 * Within a bucket the strongest keyword hint leads, and an unscored posting
 * sorts last — null means "nothing recognised", not "scored zero". A lead has
 * no posted_at, so the date sort falls back to the alert's own date.
 */
const ORDER_BY = `
    ORDER BY CASE status
                 WHEN 'generated'  THEN 0
                 WHEN 'generating' THEN 1
                 WHEN 'new'        THEN 2
                 WHEN 'lead'       THEN 3
                 WHEN 'failed'     THEN 4
                 WHEN 'applied'    THEN 5
                 WHEN 'dismissed'  THEN 6
                 WHEN 'closed'     THEN 7
                 ELSE 8
             END,
             CASE WHEN pre_score IS NULL THEN 1 ELSE 0 END,
             pre_score DESC,
             COALESCE(posted_at, email_date, fetched_at) DESC`;

const SCHEMA_PATH = fileURLToPath(new URL("./schema.sql", import.meta.url));

/**
 * Columns added after a database already existed. `CREATE TABLE IF NOT EXISTS`
 * does nothing to a table that is already there, so a new column has to be
 * added by hand or every insert naming it fails on an existing tracker.
 */
const ADDED_COLUMNS: readonly {name: string; ddl: string}[] = [
    {name: "language", ddl: "ALTER TABLE postings ADD COLUMN language TEXT"},
    {name: "stage", ddl: "ALTER TABLE postings ADD COLUMN stage TEXT"},
    {name: "stage_started_at", ddl: "ALTER TABLE postings ADD COLUMN stage_started_at TEXT"},
    {name: "lead_source", ddl: "ALTER TABLE postings ADD COLUMN lead_source TEXT"},
    {name: "email_id", ddl: "ALTER TABLE postings ADD COLUMN email_id TEXT"},
    {name: "email_date", ddl: "ALTER TABLE postings ADD COLUMN email_date TEXT"},
    {name: "snippet", ddl: "ALTER TABLE postings ADD COLUMN snippet TEXT"},
];

function migrate(db: Database.Database): void {
    const present = new Set(
        db
            .prepare("PRAGMA table_info(postings)")
            .all()
            .map((row) => (row as {name: string}).name),
    );
    for (const column of ADDED_COLUMNS) {
        if (!present.has(column.name)) db.exec(column.ddl);
    }
    backfillLanguage(db);
}

/**
 * Rows stored before the language column existed have none, which makes them
 * invisible to a language filter — NULL is not "unknown", it is "never asked".
 * Detection is deterministic and reads text already on disk, so the answer is
 * the same one the sources layer would have given at the time.
 */
function backfillLanguage(db: Database.Database): void {
    const rows = db
        .prepare("SELECT source_id, title, raw_text FROM postings WHERE language IS NULL")
        .all() as {source_id: string; title: string | null; raw_text: string | null}[];
    if (!rows.length) return;

    const update = db.prepare("UPDATE postings SET language = ? WHERE source_id = ?");
    const run = db.transaction(() => {
        for (const row of rows) {
            // Nothing to read is not a language. Leave it null rather than
            // recording a guess drawn from an empty string.
            if (!row.raw_text?.trim()) continue;
            update.run(detectLanguage(row.raw_text, row.title ?? ""), row.source_id);
        }
    });
    run();
}

export class TrackerStore {
    private constructor(private readonly db: Database.Database) {}

    /** Opens the database, creating it and its schema on first use. */
    static open(databasePath: string = DEFAULT_DATABASE_PATH): TrackerStore {
        if (databasePath !== ":memory:") {
            mkdirSync(path.dirname(path.resolve(databasePath)), {recursive: true});
        }

        const db = new Database(databasePath);
        db.pragma("journal_mode = WAL");
        db.exec(readFileSync(SCHEMA_PATH, "utf8"));
        migrate(db);
        return new TrackerStore(db);
    }

    close(): void {
        this.db.close();
    }

    private now(): string {
        return new Date().toISOString();
    }

    private require(sourceId: string): PostingRecord {
        const posting = this.getPosting(sourceId);
        if (!posting) throw new TrackerError(`No posting with id "${sourceId}".`);
        return posting;
    }

    /**
     * Inserts postings that are new and refreshes the volatile fields of ones
     * already known. It never touches status, out_dir or anything the operator
     * has decided — a posting seen twice is still wherever it was put.
     */
    upsertPostings(postings: readonly UpsertPosting[]): {found: number; added: number} {
        const insert = this.db.prepare(`
            INSERT INTO postings (
                source_id, source, company, title, location, country, url,
                posted_at, fetched_at, pre_score, raw_text, language, status, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?)
            ON CONFLICT(source_id) DO UPDATE SET
                fetched_at = excluded.fetched_at,
                pre_score  = excluded.pre_score,
                raw_text   = excluded.raw_text,
                language   = excluded.language,
                updated_at = excluded.updated_at
        `);

        const known = new Set(
            this.db
                .prepare("SELECT source_id FROM postings")
                .all()
                .map((row) => (row as {source_id: string}).source_id),
        );

        const now = this.now();
        let added = 0;

        const run = this.db.transaction((batch: readonly UpsertPosting[]) => {
            for (const posting of batch) {
                if (!known.has(posting.sourceId)) added += 1;
                insert.run(
                    posting.sourceId,
                    posting.source,
                    posting.company,
                    posting.title,
                    posting.location,
                    posting.country ?? null,
                    posting.url,
                    posting.postedAt,
                    posting.fetchedAt,
                    posting.preScore ?? null,
                    posting.text,
                    posting.language ?? null,
                    now,
                );
            }
        });
        run(postings);

        return {found: postings.length, added};
    }

    listPostings(filter: ListFilter = {}): PostingRecord[] {
        const where: string[] = [];
        const params: Record<string, string> = {};

        if (filter.status) {
            where.push("status = @status");
            params["status"] = filter.status;
        }
        if (filter.country) {
            where.push("country = @country");
            params["country"] = filter.country;
        }
        if (filter.source) {
            where.push("source = @source");
            params["source"] = filter.source;
        }
        if (filter.language) {
            // A lead has no body yet, so its language is null — which is "not
            // known", not "not this language". Filtering the inbox by prose
            // language would hide every lead, so a null language always passes;
            // it is decided once the description is pasted.
            where.push("(language = @language OR language IS NULL)");
            params["language"] = filter.language;
        }
        if (filter.q?.trim()) {
            where.push("(company LIKE @q OR title LIKE @q)");
            params["q"] = `%${filter.q.trim()}%`;
        }

        const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
        const rows = this.db
            .prepare(`SELECT * FROM postings ${clause} ${ORDER_BY}`)
            .all(params) as Row[];

        return rows.map(toRecord);
    }

    getPosting(sourceId: string): PostingRecord | undefined {
        const row = this.db.prepare("SELECT * FROM postings WHERE source_id = ?").get(sourceId) as
            | Row
            | undefined;
        return row ? toRecord(row) : undefined;
    }

    /**
     * What already exists, so a fetch does not create a second row for a job it
     * has seen. `urls` and `identities` (company|title|location) are the two
     * ways the same posting arrives twice; `emailIds` is so a message is never
     * re-parsed.
     */
    dedupeIndex(): {urls: Set<string>; identities: Set<string>; emailIds: Set<string>} {
        const urls = new Set<string>();
        const identities = new Set<string>();
        const emailIds = new Set<string>();

        const rows = this.db
            .prepare("SELECT url, company, title, location, email_id FROM postings")
            .all() as Pick<Row, "url" | "company" | "title" | "location" | "email_id">[];

        for (const row of rows) {
            if (row.url) urls.add(normaliseUrl(row.url));
            identities.add(identityKey(row.company, row.title, row.location));
            if (row.email_id) emailIds.add(row.email_id);
        }
        return {urls, identities, emailIds};
    }

    /**
     * Inserts email leads as status 'lead'. A lead has no raw_text — that is
     * exactly what a lead is — so generation is refused until a description is
     * pasted. An id already present is left untouched, never downgraded.
     */
    upsertLeads(leads: readonly UpsertLead[]): {found: number; added: number} {
        const insert = this.db.prepare(`
            INSERT INTO postings (
                source_id, source, company, title, location, url,
                fetched_at, lead_source, email_id, email_date, snippet, status, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'lead', ?)
            ON CONFLICT(source_id) DO NOTHING
        `);

        const known = new Set(
            this.db
                .prepare("SELECT source_id FROM postings")
                .all()
                .map((row) => (row as {source_id: string}).source_id),
        );

        const now = this.now();
        let added = 0;
        const run = this.db.transaction((batch: readonly UpsertLead[]) => {
            for (const lead of batch) {
                if (known.has(lead.sourceId)) continue;
                const info = insert.run(
                    lead.sourceId,
                    lead.source,
                    lead.company,
                    lead.title,
                    lead.location,
                    lead.url,
                    lead.fetchedAt,
                    lead.leadSource,
                    lead.emailId,
                    lead.emailDate,
                    lead.snippet,
                    now,
                );
                if (info.changes) added += 1;
            }
        });
        run(leads);
        return {found: leads.length, added};
    }

    /**
     * Stores the pasted job description and promotes the lead to `new`. This is
     * the step that turns a sighting into something generatable; nothing else
     * writes raw_text onto a lead.
     */
    saveDescription(sourceId: string, text: string): PostingRecord {
        const posting = this.require(sourceId);
        if (!text.trim()) {
            throw new TrackerError(`A pasted description for "${sourceId}" cannot be empty.`);
        }
        if (posting.status !== "lead") {
            throw new TrackerError(
                `"${sourceId}" is ${posting.status}, not a lead. Only a lead takes a pasted ` +
                    "description.",
            );
        }

        this.db
            .prepare(
                "UPDATE postings SET raw_text = ?, language = ?, status = 'new', updated_at = ? " +
                    "WHERE source_id = ?",
            )
            .run(text, detectLanguage(text, posting.title ?? ""), this.now(), sourceId);
        return this.require(sourceId);
    }

    /** Moves a posting through the state machine, refusing an illegal move. */
    setStatus(sourceId: string, status: Status): PostingRecord {
        const posting = this.require(sourceId);
        if (posting.status === status) return posting;

        if (!canTransition(posting.status, status)) {
            const allowed = TRANSITIONS[posting.status];
            throw new TrackerError(
                `Cannot move "${sourceId}" from ${posting.status} to ${status}. ` +
                    (allowed.length
                        ? `From ${posting.status} the only moves are: ${allowed.join(", ")}.`
                        : `${posting.status} is terminal.`),
            );
        }

        // Applying is the moment worth timestamping: it is the one step the
        // tool cannot take for you. Closed keeps that history; un-applying to a
        // status that never applied clears it, along with any outcome — an
        // outcome describes what happened after applying, and a posting that is
        // no longer applied has nothing to describe.
        const keepsHistory = OUTCOME_STATUSES.includes(status);
        const appliedAt = status === "applied" ? this.now() : keepsHistory ? posting.appliedAt : null;
        const outcome = keepsHistory ? posting.outcome : null;

        this.db
            .prepare(
                "UPDATE postings SET status = ?, applied_at = ?, outcome = ?, updated_at = ? " +
                    "WHERE source_id = ?",
            )
            .run(status, appliedAt, outcome, this.now(), sourceId);

        return this.require(sourceId);
    }

    setOutcome(sourceId: string, outcome: Outcome | null): PostingRecord {
        const posting = this.require(sourceId);
        if (outcome !== null && !OUTCOME_STATUSES.includes(posting.status)) {
            throw new TrackerError(
                "An outcome only means something once you have applied. " +
                    `"${sourceId}" is ${posting.status}.`,
            );
        }

        this.db
            .prepare("UPDATE postings SET outcome = ?, updated_at = ? WHERE source_id = ?")
            .run(outcome, this.now(), sourceId);
        return this.require(sourceId);
    }

    setNotes(sourceId: string, notes: string): PostingRecord {
        this.require(sourceId);
        this.db
            .prepare("UPDATE postings SET notes = ?, updated_at = ? WHERE source_id = ?")
            .run(notes, this.now(), sourceId);
        return this.require(sourceId);
    }

    /** Records a successful generation and moves the posting to `generated`. */
    /**
     * Marks which step a running generation is on. Stamped with its own start
     * time so the UI can count up from it — the elapsed time belongs to the
     * stage, not to the whole job, because tailoring dwarfs the others.
     */
    setStage(sourceId: string, stage: Stage): PostingRecord {
        this.require(sourceId);
        this.db
            .prepare(
                "UPDATE postings SET stage = ?, stage_started_at = ?, updated_at = ? WHERE source_id = ?",
            )
            .run(stage, this.now(), this.now(), sourceId);
        return this.require(sourceId);
    }

    /**
     * Resets postings left mid-generation by a server that stopped.
     *
     * The queue is in memory, so a restart forgets what was running while the
     * database still says `generating` — a status whose only exits are taken by
     * the process that died. Without this they would be stranded there forever.
     */
    resetInterruptedGenerations(): number {
        const stranded = this.db
            .prepare("SELECT source_id FROM postings WHERE status = 'generating'")
            .all() as {source_id: string}[];

        for (const row of stranded) {
            this.recordFailure(row.source_id, "interrupted by server restart");
        }
        return stranded.length;
    }

    recordGeneration(sourceId: string, result: GenerationResult): PostingRecord {
        this.require(sourceId);
        this.db
            .prepare(
                `UPDATE postings
                    SET out_dir = ?, match_score = ?, flags = ?, gaps = ?,
                        country = COALESCE(?, country),
                        status = 'generated', last_error = NULL,
                        stage = NULL, stage_started_at = NULL, updated_at = ?
                  WHERE source_id = ?`,
            )
            .run(
                result.outDir,
                Math.round(result.matchScore),
                JSON.stringify([...result.flags]),
                JSON.stringify([...result.gaps]),
                result.country ?? null,
                this.now(),
                sourceId,
            );
        return this.require(sourceId);
    }

    /** Records why a generation failed, without touching the operator's notes. */
    recordFailure(sourceId: string, message: string): PostingRecord {
        this.require(sourceId);
        this.db
            .prepare(
                `UPDATE postings
                    SET status = 'failed', last_error = ?,
                        stage = NULL, stage_started_at = NULL, updated_at = ?
                  WHERE source_id = ?`,
            )
            .run(message, this.now(), sourceId);
        return this.require(sourceId);
    }

    /**
     * Counts by status and outcome, plus the gaps that come up most often —
     * which is the whole reason gaps are kept in the database. A gap repeated
     * across twenty postings is a study plan, not a rejection.
     */
    stats(): Stats {
        const byStatus: Record<string, number> = {};
        for (const row of this.db
            .prepare("SELECT status, COUNT(*) AS count FROM postings GROUP BY status")
            .all() as {status: string; count: number}[]) {
            byStatus[row.status] = row.count;
        }

        const byOutcome: Record<string, number> = {};
        for (const row of this.db
            .prepare(
                "SELECT outcome, COUNT(*) AS count FROM postings WHERE outcome IS NOT NULL GROUP BY outcome",
            )
            .all() as {outcome: string; count: number}[]) {
            byOutcome[row.outcome] = row.count;
        }

        const frequency = new Map<string, number>();
        for (const row of this.db
            .prepare("SELECT gaps FROM postings WHERE gaps IS NOT NULL AND gaps != '[]'")
            .all() as {gaps: string | null}[]) {
            for (const gap of parseJsonArray(row.gaps)) {
                const key = gap.trim();
                if (!key) continue;
                frequency.set(key, (frequency.get(key) ?? 0) + 1);
            }
        }

        const topGaps = [...frequency.entries()]
            .map(([gap, count]) => ({gap, count}))
            .sort((a, b) => b.count - a.count || a.gap.localeCompare(b.gap))
            .slice(0, 10);

        const total =
            (this.db.prepare("SELECT COUNT(*) AS count FROM postings").get() as {count: number})
                .count ?? 0;

        return {byStatus, byOutcome, topGaps, total};
    }
}

/** Opens the tracker database. */
export function openStore(databasePath: string = DEFAULT_DATABASE_PATH): TrackerStore {
    return TrackerStore.open(databasePath);
}
