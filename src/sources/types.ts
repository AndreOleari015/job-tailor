import type {PostingLanguage} from "./language.js";

/**
 * A posting exactly as a source produced it, before any model has seen it.
 * `text` is plain text in the same shape a human would paste in, so an
 * automated posting and a pasted one travel the identical extraction path.
 */
export interface RawPosting {
    /** Stable across runs: "greenhouse:acme:12345". The cache and CLI key on this. */
    sourceId: string;
    source: string;
    company: string | null;
    title: string;
    location: string | null;
    url: string;
    /** ISO date, or null when the source does not publish one. */
    postedAt: string | null;
    /** Full description as plain text, with the Company:/Location: header prepended. */
    text: string;
    /**
     * The language the posting is written in, from a deterministic word-frequency
     * check. It separates the two populations in this market: international
     * companies posting in English, and domestic postings in German that mostly
     * expect fluent German.
     */
    language: PostingLanguage;
    /** ISO timestamp. */
    fetchedAt: string;
    /**
     * True when the source returns a shortened description. Tailoring from a
     * truncated posting reads requirements that are not all there, so the CLI
     * warns rather than letting it pass silently.
     */
    textTruncated?: boolean;
}

export interface SourceQuery {
    keywords: string[];
    location?: string;
    /** ISO 3166-1 alpha-2. */
    country?: string;
    remote?: boolean;
    postedWithinDays?: number;
    /** Keep only postings written in one of these. Empty means every language. */
    languages?: readonly PostingLanguage[];
}

export interface JobSource {
    readonly name: string;
    readonly requiresCredentials: boolean;
    /**
     * A board publishes one company's own postings and carries the complete
     * description; an aggregator indexes many and often truncates. Dedupe
     * prefers the board copy for exactly that reason.
     */
    readonly kind: "board" | "aggregator";
    search(query: SourceQuery): Promise<RawPosting[]>;
    fetchOne?(id: string): Promise<RawPosting>;
}

/** Raised when a source cannot run at all, e.g. missing credentials. */
export class SourceUnavailableError extends Error {
    override readonly name = "SourceUnavailableError";
    readonly source: string;

    constructor(source: string, message: string) {
        super(message);
        this.source = source;
    }
}
