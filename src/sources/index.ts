import type {JobSpec} from "../types.js";

/** Job-board ingestion. Phase 3. */
export type SourceName = "url" | "linkedin" | "indeed" | "stepstone";

export interface SourceQuery {
    source: SourceName;
    keywords: string[];
    location?: string;
    limit?: number;
}

export interface SourceListing {
    source: SourceName;
    url: string;
    fetchedAt: string;
    rawText: string;
    jobSpec?: JobSpec;
}

/** Fetches a single posting and returns its raw text. */
export function fetchListing(_url: string): Promise<SourceListing> {
    throw new Error("NotImplemented: phase 3");
}

/** Searches a job board and returns matching postings. */
export function searchListings(_query: SourceQuery): Promise<SourceListing[]> {
    throw new Error("NotImplemented: phase 3");
}
