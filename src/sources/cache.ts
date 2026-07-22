import {mkdir, readFile, writeFile} from "node:fs/promises";
import path from "node:path";
import type {ProbeResult} from "./discover.js";
import {detectLanguage} from "./language.js";
import type {RawPosting} from "./types.js";

export const DEFAULT_CACHE_PATH = "data/postings.cache.json";
export const DEFAULT_DISCOVERY_CACHE_PATH = "data/discovery.cache.json";

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
        // Postings cached before `language` existed have none. Detection is
        // deterministic and cheap, so they are backfilled on load rather than
        // being evicted or, worse, flowing on with an undefined field.
        const postings = new Map(
            Object.entries(parsed.postings).map(([id, posting]): [string, RawPosting] => [
                id,
                posting.language
                    ? posting
                    : {...posting, language: detectLanguage(posting.text ?? "", posting.title)},
            ]),
        );

        return new PostingCache(filePath, postings, parsed.lastSearch ?? []);
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

/* ------------------------------------------------------------------ */
/* Discovery cache                                                      */
/* ------------------------------------------------------------------ */

/** A dead slug stays dead. Nothing is gained by asking again next week. */
const NEGATIVE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** A live board's job counts move, so a hit is only trusted for a week. */
const POSITIVE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

interface DiscoveryEntry {
    result: ProbeResult;
    at: string;
    /** Normalised keywords the counts were computed against. */
    keywords: string[];
}

interface DiscoveryCacheFile {
    version: 1;
    probes: Record<string, DiscoveryEntry>;
}

function normaliseKeywords(keywords: readonly string[]): string[] {
    return [...new Set(keywords.map((word) => word.trim().toLowerCase()).filter(Boolean))].sort();
}

function sameKeywords(a: readonly string[], b: readonly string[]): boolean {
    return a.length === b.length && a.every((word, index) => word === b[index]);
}

/**
 * Probe results by "{board}:{token}". Its whole purpose is that re-running
 * discovery does not re-probe hundreds of slugs that were dead the first time.
 *
 * A negative is keyword-independent — a token either names a board or it does
 * not — so it is reused whatever the keywords are. A positive carries counts
 * that only mean anything against the keywords they were computed from, so
 * changing them is a miss rather than a stale answer.
 */
export class DiscoveryCache {
    private constructor(
        private readonly filePath: string,
        private readonly probes: Map<string, DiscoveryEntry>,
    ) {}

    static async open(filePath = DEFAULT_DISCOVERY_CACHE_PATH): Promise<DiscoveryCache> {
        let probes: Record<string, DiscoveryEntry> = {};
        try {
            const parsed = JSON.parse(await readFile(filePath, "utf8")) as DiscoveryCacheFile;
            if (parsed && typeof parsed === "object" && parsed.probes) probes = parsed.probes;
        } catch {
            // A missing or corrupt cache is not an error: it is an empty one.
        }
        return new DiscoveryCache(filePath, new Map(Object.entries(probes)));
    }

    /** An empty cache that is never written. For tests and one-shot probes. */
    static memory(): DiscoveryCache {
        return new DiscoveryCache("", new Map());
    }

    private fresh(entry: DiscoveryEntry, now: number): boolean {
        const at = Date.parse(entry.at);
        if (!Number.isFinite(at)) return false;
        const maxAge = entry.result.valid ? POSITIVE_MAX_AGE_MS : NEGATIVE_MAX_AGE_MS;
        return now - at < maxAge;
    }

    get(key: string, keywords: readonly string[] = [], now = Date.now()): ProbeResult | undefined {
        const entry = this.probes.get(key);
        if (!entry || !this.fresh(entry, now)) return undefined;
        if (entry.result.valid && !sameKeywords(entry.keywords, normaliseKeywords(keywords))) {
            return undefined;
        }
        return entry.result;
    }

    put(result: ProbeResult, keywords: readonly string[] = [], now = new Date()): void {
        this.probes.set(`${result.board}:${result.token}`, {
            result,
            at: now.toISOString(),
            keywords: normaliseKeywords(keywords),
        });
    }

    get size(): number {
        return this.probes.size;
    }

    /** Writes the cache, dropping anything past its age. A no-op in memory. */
    async save(now = Date.now()): Promise<void> {
        if (!this.filePath) return;

        const kept: Record<string, DiscoveryEntry> = {};
        for (const [key, entry] of this.probes) {
            if (this.fresh(entry, now)) kept[key] = entry;
        }

        const resolved = path.resolve(this.filePath);
        await mkdir(path.dirname(resolved), {recursive: true});
        const file: DiscoveryCacheFile = {version: 1, probes: kept};
        await writeFile(resolved, `${JSON.stringify(file, null, 2)}\n`, "utf8");
    }
}
