import {preScore} from "../core/match.js";
import type {JobSpec, Profile} from "../types.js";
import {PostingCache} from "./cache.js";
import {containsWholeTerm} from "./filter.js";
import {resolveSources, type RegistryOptions} from "./registry.js";
import {SourceUnavailableError, type JobSource, type RawPosting, type SourceQuery} from "./types.js";

export type {RawPosting, SourceQuery, JobSource} from "./types.js";
export {SourceUnavailableError} from "./types.js";
export {PostingCache, DEFAULT_CACHE_PATH} from "./cache.js";
export {SOURCE_NAMES, isSourceName, buildSources, type SourceName} from "./registry.js";
export {loadCompanies, DEFAULT_COMPANIES_PATH, type CompanyConfig} from "./companies.js";
export {createHttp, USER_AGENT, type HttpClient} from "./http.js";
export {htmlToText, withHeader, normaliseWhitespace} from "./text.js";

/**
 * The vocabulary the ordering hint is built from. Deliberately a fixed list of
 * concrete technologies: a posting's prose is not evidence of a requirement,
 * and inferring one would be the same mistake the tailoring layer exists to
 * prevent.
 */
const TECH_VOCABULARY: readonly string[] = [
    "react native", "react", "typescript", "javascript", "node.js", "node", "expo",
    "firebase", "firestore", "graphql", "rest apis", "rest", "python", "java", "kotlin",
    "swift", "objective-c", "flutter", "dart", "android", "ios", "next.js", "vue",
    "angular", "svelte", "php", "laravel", "ruby", "rails", "go", "rust", "c#", ".net",
    "sql", "mysql", "postgresql", "mongodb", "redis", "aws", "gcp", "azure", "docker",
    "kubernetes", "terraform", "ci/cd", "github actions", "jenkins", "fastlane",
    "cloudflare workers", "redux", "tailwind", "jest", "cypress", "playwright",
    "websockets", "microservices", "kafka", "elasticsearch", "figma", "revenuecat",
];

/**
 * A JobSpec good enough to order a list by, built without a model call: the
 * concrete technologies the posting actually names. It is never written to
 * disk and never reaches `tailor` — `extract` still produces the real JobSpec.
 */
export function lightweightSpec(posting: RawPosting): JobSpec {
    const haystack = `${posting.title}\n${posting.text}`;
    const required = TECH_VOCABULARY.filter((term) => containsWholeTerm(haystack, term));

    return {
        company: posting.company ?? "unknown",
        role: posting.title,
        location: posting.location ?? "",
        country: null,
        remote: "unknown",
        language: "en",
        seniority: "unknown",
        required_stack: required,
        nice_to_have: [],
        salary_min_eur: null,
        visa_sponsorship: "not_mentioned",
        key_responsibilities: [],
        tone: "corporate",
    };
}

export interface ScoredPosting extends RawPosting {
    /**
     * A rough ordering hint from keyword overlap. Not the model's match_score.
     *
     * Null when the posting names no technology this vocabulary knows, which is
     * a different statement from zero: `preScore` answers "no requirements, no
     * basis to reject" with 100, which is right for the pre-filter in `run` and
     * wrong for ordering a list — it would float an unreadable posting to the
     * top next to a perfect match. Unscored postings sort last and print as "—".
     */
    preScore: number | null;
}

/** company + title + location, normalised. The same role on two boards collides here. */
function identityKey(posting: RawPosting): string {
    return [posting.company, posting.title, posting.location]
        .map((part) => (part ?? "").toLowerCase().replace(/\s+/g, " ").trim())
        .join("|");
}

interface Harvest {
    posting: RawPosting;
    kind: "board" | "aggregator";
}

/**
 * One role often appears on both a company board and an aggregator. The board
 * copy wins: aggregators truncate, and a truncated posting would be tailored
 * against requirements it never showed us.
 */
function dedupe(harvest: readonly Harvest[]): RawPosting[] {
    const byId = new Map<string, Harvest>();
    for (const entry of harvest) {
        if (!byId.has(entry.posting.sourceId)) byId.set(entry.posting.sourceId, entry);
    }

    const byIdentity = new Map<string, Harvest>();
    for (const entry of byId.values()) {
        const key = identityKey(entry.posting);
        const existing = byIdentity.get(key);
        if (!existing || (existing.kind === "aggregator" && entry.kind === "board")) {
            byIdentity.set(key, entry);
        }
    }
    return [...byIdentity.values()].map((entry) => entry.posting);
}

export interface SearchAllOptions {
    query: SourceQuery;
    profile: Profile;
    /** Source names to run; empty means every configured source. */
    sources?: readonly string[];
    limit?: number;
    /** Ignore the cache, refetching everything. */
    refresh?: boolean;
    cache?: PostingCache;
    registry?: RegistryOptions;
    now?: Date;
    /** Injected sources, so the merge and dedupe logic is tested without the network. */
    sourcesOverride?: readonly JobSource[];
}

export interface SearchAllResult {
    postings: ScoredPosting[];
    /** One line per source that could not run. Partial results are the normal case. */
    warnings: string[];
}

/**
 * Runs every requested source, tolerating the ones that fail, and returns the
 * merged list ordered by pre-score. Never calls the tailoring model: searching
 * has to be free, or it will not be done often enough to matter.
 */
export async function searchAll(options: SearchAllOptions): Promise<SearchAllResult> {
    const cache = options.cache ?? (await PostingCache.open());
    const sources =
        options.sourcesOverride ??
        (await resolveSources(options.sources ?? [], {
            ...options.registry,
            // Withholding the cache is what makes --refresh refetch.
            ...(options.refresh ? {} : {cache}),
        }));

    const warnings: string[] = [];
    const harvest: Harvest[] = [];

    const runs = await Promise.all(
        sources.map(async (source: JobSource) => {
            try {
                return {source, postings: await source.search(options.query)};
            } catch (error) {
                const reason =
                    error instanceof SourceUnavailableError
                        ? error.message
                        : `${source.name} failed: ${
                              error instanceof Error ? error.message : String(error)
                          }`;
                warnings.push(reason);
                return {source, postings: [] as RawPosting[]};
            }
        }),
    );

    for (const run of runs) {
        for (const posting of run.postings) harvest.push({posting, kind: run.source.kind});
    }

    const merged = dedupe(harvest);
    for (const posting of merged) cache.put(posting);
    await cache.save(options.now ?? new Date());

    const scored = merged
        .map((posting): ScoredPosting => {
            const spec = lightweightSpec(posting);
            return {
                ...posting,
                preScore: spec.required_stack.length
                    ? preScore(options.profile, spec).score
                    : null,
            };
        })
        .sort((a, b) => (b.preScore ?? -1) - (a.preScore ?? -1) || a.title.localeCompare(b.title));

    return {postings: scored.slice(0, options.limit ?? 50), warnings};
}

/**
 * A posting by id: from the cache when it is there, otherwise from the source
 * that owns the id prefix.
 */
export async function fetchPosting(
    sourceId: string,
    options: {cache?: PostingCache; registry?: RegistryOptions} = {},
): Promise<RawPosting> {
    const cache = options.cache ?? (await PostingCache.open());
    const cached = cache.get(sourceId);
    if (cached) return cached;

    const [name] = sourceId.split(":");
    if (!name) throw new Error(`"${sourceId}" is not a source id`);

    const [source] = await resolveSources([name], {...options.registry, cache});
    if (!source) throw new Error(`"${name}" is not a known source`);
    if (!source.fetchOne) {
        throw new Error(
            `${name} cannot fetch a single posting; re-run search to refresh the cache.`,
        );
    }

    const posting = await source.fetchOne(sourceId);
    cache.put(posting);
    await cache.save();
    return posting;
}
