import {mkdir, readFile, writeFile} from "node:fs/promises";
import path from "node:path";
import type {RawPosting} from "./types.js";

export const DEFAULT_CACHE_PATH = "data/postings.cache.json";

/** Entries older than this are dropped whenever the cache is written. */
const MAX_AGE_DAYS = 30;
const MAX_AGE_MS = MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

interface CacheFile {
    version: 1;
    postings: Record<string, RawPosting>;
    /** Source ids in the order the last search printed them, so `pull 3` works. */
    lastSearch?: string[];
}

function empty(): CacheFile {
    return {version: 1, postings: {}};
}

/**
 * A flat sourceId -> posting store. Its job is to stop a posting already seen
 * from being fetched a second time, and to let `pull` resolve an id long after
 * the search that produced it.
 */
export class PostingCache {
    private lastSearch: string[];

    private constructor(
        private readonly filePath: string,
        private readonly postings: Map<string, RawPosting>,
        lastSearch: string[],
    ) {
        this.lastSearch = lastSearch;
    }

    static async open(filePath = DEFAULT_CACHE_PATH): Promise<PostingCache> {
        let parsed: CacheFile = empty();
        try {
            const raw = await readFile(filePath, "utf8");
            const candidate = JSON.parse(raw) as CacheFile;
            if (candidate && typeof candidate === "object" && candidate.postings) {
                parsed = candidate;
            }
        } catch {
            // A missing or corrupt cache is not an error: it is an empty one.
        }
        return new PostingCache(
            filePath,
            new Map(Object.entries(parsed.postings)),
            parsed.lastSearch ?? [],
        );
    }

    /** Records the order a search printed, so `pull <index>` can resolve it. */
    rememberSearch(sourceIds: readonly string[]): void {
        this.lastSearch = [...sourceIds];
    }

    /** The sourceId at a 1-based index from the last search, if any. */
    fromLastSearch(index: number): string | undefined {
        return this.lastSearch[index - 1];
    }

    has(sourceId: string): boolean {
        return this.postings.has(sourceId);
    }

    get(sourceId: string): RawPosting | undefined {
        return this.postings.get(sourceId);
    }

    put(posting: RawPosting): void {
        this.postings.set(posting.sourceId, posting);
    }

    all(): RawPosting[] {
        return [...this.postings.values()];
    }

    /** Writes the cache, evicting anything fetched more than 30 days ago. */
    async save(now = new Date()): Promise<void> {
        const cutoff = now.getTime() - MAX_AGE_MS;
        const kept: Record<string, RawPosting> = {};

        for (const [id, posting] of this.postings) {
            const fetchedAt = Date.parse(posting.fetchedAt);
            if (Number.isFinite(fetchedAt) && fetchedAt < cutoff) continue;
            kept[id] = posting;
        }

        this.postings.clear();
        for (const [id, posting] of Object.entries(kept)) this.postings.set(id, posting);

        const resolved = path.resolve(this.filePath);
        await mkdir(path.dirname(resolved), {recursive: true});
        const file: CacheFile = {
            version: 1,
            postings: kept,
            lastSearch: this.lastSearch.filter((id) => id in kept),
        };
        await writeFile(resolved, `${JSON.stringify(file, null, 2)}\n`, "utf8");
    }
}
