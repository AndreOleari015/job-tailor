import {preScore} from "../core/match.js";
import type {JobSpec, Profile} from "../types.js";
import {matchesTerm, tokenSet} from "../core/terms.js";
import {PostingCache} from "./cache.js";
import {
    countryLabel,
    isAmbiguousFor,
    isKnownCountry,
    isRemote,
    isRemoteIn,
    matchesCountry,
} from "./location.js";
import {resolveSources, type RegistryOptions} from "./registry.js";
import {SourceUnavailableError, type JobSource, type RawPosting, type SourceQuery} from "./types.js";

export type {RawPosting, SourceQuery, JobSource} from "./types.js";
export {SourceUnavailableError} from "./types.js";
export {
    PostingCache,
    DiscoveryCache,
    DEFAULT_CACHE_PATH,
    DEFAULT_DISCOVERY_CACHE_PATH,
} from "./cache.js";
export {
    BOARD_NAMES,
    discoverFromCandidates,
    filterCandidates,
    isBoardName,
    createProbeContext,
    probeToken,
    slugCandidates,
    slugsFor,
    ProbeBudget,
    MAX_PROBES_PER_RUN,
    type ProbeResult,
    type DiscoveryResult,
} from "./discover.js";
export {SOURCE_NAMES, isSourceName, buildSources, type SourceName} from "./registry.js";
export {
    loadCompanies,
    appendCompanies,
    DEFAULT_COMPANIES_PATH,
    type CompanyConfig,
    type CompanyAddition,
} from "./companies.js";
export {loadCandidates, candidatesSchema, type Candidate, type CandidatesConfig} from "./candidates.js";
export {createHttp, USER_AGENT, type HttpClient} from "./http.js";
export {htmlToText, withHeader, normaliseWhitespace} from "./text.js";
export {
    countryLabel,
    isAmbiguousFor,
    isKnownCountry,
    isRemote,
    isRemoteIn,
    matchesCountry,
    matchesLocation,
    resolveCountry,
} from "./location.js";
export {
    detectLanguage,
    detectLanguageWithEvidence,
    isPostingLanguage,
    type PostingLanguage,
} from "./language.js";

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
    const inTitle = tokenSet(posting.title);
    const inBody = tokenSet(posting.text);

    // A technology in the title is what the role is; one in the body may be a
    // line of boilerplate. The split maps onto the weights `preScore` already
    // applies — required counts 2, nice-to-have counts 1 — so a title match is
    // worth two body matches without inventing a second scoring rule.
    const required = TECH_VOCABULARY.filter((term) => matchesTerm(inTitle, term));
    const body = TECH_VOCABULARY.filter(
        (term) => !required.includes(term) && matchesTerm(inBody, term),
    );

    return {
        company: posting.company ?? "unknown",
        role: posting.title,
        location: posting.location ?? "",
        country: null,
        remote: "unknown",
        language: "en",
        seniority: "unknown",
        required_stack: required,
        nice_to_have: body,
        salary_min_eur: null,
        salary_currency: null,
        visa_sponsorship: "not_mentioned",
        key_responsibilities: [],
        tone: "corporate",
    };
}

/**
 * The ceiling for a posting whose title names none of the technologies. A
 * posting can mention TypeScript once in a paragraph about the engineering
 * culture and still be an Account Executive role; the body is evidence, but it
 * is not what the job is.
 */
export const BODY_ONLY_SCORE_CAP = 40;

/**
 * The ordering hint for one posting, or null when it names no technology the
 * vocabulary knows — which is a different statement from scoring zero.
 */
export function scorePosting(profile: Profile, posting: RawPosting): number | null {
    const spec = lightweightSpec(posting);
    if (!spec.required_stack.length && !spec.nice_to_have.length) return null;

    const {score} = preScore(profile, spec);
    return spec.required_stack.length ? score : Math.min(score, BODY_ONLY_SCORE_CAP);
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
function dedupe(harvest: readonly Harvest[]): Harvest[] {
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
    return [...byIdentity.values()];
}

/**
 * Whether a posting survives the location filters.
 *
 * The subject of `--country` is the posting's own location, never the company
 * it belongs to: a company headquartered in Germany posts roles in Lisbon,
 * Dublin and San Francisco, and those are different questions.
 *
 * Every source is filtered here, aggregators included. A source's own country
 * parameter is a bandwidth optimisation and never a correctness guarantee —
 * the Bundesagentur's index carries Austrian listings, so trusting it returned
 * a search for German roles that was almost entirely Vienna, Linz and Graz.
 */
function keepByLocation(posting: RawPosting, query: SourceQuery): boolean {
    const {location} = posting;
    const code = query.country?.trim();

    if (code && isKnownCountry(code)) {
        // With --remote, a role open to the whole region counts as reachable
        // from the country; without it, only the country itself does.
        if (!(query.remote
            ? matchesCountry(location, code) || isRemoteIn(location, code)
            : matchesCountry(location, code))) {
            return false;
        }
    } else if (query.remote && !isRemote(location)) {
        return false;
    }

    if (query.languages?.length && !query.languages.includes(posting.language)) return false;
    return true;
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

export interface LocationFilterReport {
    country: string;
    label: string;
    /** Postings whose own location placed them there. */
    matched: number;
    /** Postings the sources returned, before the filter. */
    total: number;
    /**
     * Postings naming this country *and* another, withheld rather than guessed
     * at. Reported so the count is a decision you can see, not a silent drop.
     */
    ambiguous: number;
}

/** How many of the results are in each language, for the hint under the table. */
export interface LanguageReport {
    de: number;
    en: number;
    unknown: number;
}

export interface SearchAllResult {
    postings: ScoredPosting[];
    /** One line per source that could not run. Partial results are the normal case. */
    warnings: string[];
    /** Present when --country was applied, so an empty result is explicable. */
    filter?: LocationFilterReport;
    /** Language breakdown of the returned postings. */
    languages: LanguageReport;
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

    // Everything fetched is cached, including what the filter rejects: the
    // cache records what a source said, not what this run asked for.
    for (const entry of merged) cache.put(entry.posting);
    await cache.save(options.now ?? new Date());

    const code = options.query.country?.trim();
    if (code && !isKnownCountry(code)) {
        warnings.push(
            `${code.toUpperCase()} is not in the location vocabulary, so board postings were ` +
                "not filtered by it. Add it to src/sources/location.ts, or use --location.",
        );
    }

    const kept = merged.filter((entry) => keepByLocation(entry.posting, options.query));
    const ambiguous =
        code && isKnownCountry(code)
            ? merged.filter((entry) => isAmbiguousFor(entry.posting.location, code)).length
            : 0;

    const scored = kept
        .map(({posting}): ScoredPosting => ({...posting, preScore: scorePosting(options.profile, posting)}))
        .sort((a, b) => (b.preScore ?? -1) - (a.preScore ?? -1) || a.title.localeCompare(b.title));

    const postings = scored.slice(0, options.limit ?? 50);
    const languages: LanguageReport = {de: 0, en: 0, unknown: 0};
    for (const posting of postings) languages[posting.language] += 1;

    return {
        postings,
        warnings,
        languages,
        ...(code && isKnownCountry(code)
            ? {
                  filter: {
                      country: code.toUpperCase(),
                      label: countryLabel(code),
                      matched: kept.length,
                      total: merged.length,
                      ambiguous,
                  },
              }
            : {}),
    };
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
