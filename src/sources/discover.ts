import pLimit from "p-limit";
import {ashbyAdapter} from "./ashby.js";
import type {BoardAdapter} from "./board.js";
import {DiscoveryCache} from "./cache.js";
import type {Candidate} from "./candidates.js";
import type {BoardName} from "./companies.js";
import {matchesKeywords} from "./filter.js";
import {greenhouseAdapter} from "./greenhouse.js";
import {createHttp, HttpError, type HttpClient} from "./http.js";
import {leverAdapter} from "./lever.js";
import type {RawPosting} from "./types.js";

export const BOARD_NAMES = ["greenhouse", "lever", "ashby"] as const;

export function isBoardName(value: string): value is BoardName {
    return (BOARD_NAMES as readonly string[]).includes(value);
}

const ADAPTERS: Record<BoardName, BoardAdapter> = {
    greenhouse: greenhouseAdapter,
    lever: leverAdapter,
    ashby: ashbyAdapter,
};

/** Minimum gap between two requests to the same board host. */
const MIN_GAP_MS = 250;

/** After a 429, that board is left alone for this long. */
const RATE_LIMIT_COOLDOWN_MS = 60_000;

/** A hard stop, so a long candidate list cannot turn into a crawl. */
export const MAX_PROBES_PER_RUN = 500;

const SAMPLE_TITLE_LIMIT = 5;
const LOCATION_LIMIT = 10;

/** Companies probed at once. Each one's own slugs are tried in sequence. */
const COMPANY_CONCURRENCY = 3;

export interface ProbeResult {
    board: string;
    token: string;
    valid: boolean;
    /** Only Greenhouse names the employer; the other two boards return null. */
    companyName: string | null;
    totalJobs: number;
    matchingJobs: number;
    sampleTitles: string[];
    locations: string[];
    /** Why an invalid probe was invalid. Never a reason to retry it here. */
    reason?: string;
}

export interface DiscoveryResult extends ProbeResult {
    /** The candidate this token was found for, carried through for --write. */
    company: string;
    country: string;
}

function warn(message: string): void {
    process.stderr.write(`[job-tailor] ${message}\n`);
}

/* ------------------------------------------------------------------ */
/* Slugs                                                                */
/* ------------------------------------------------------------------ */

/**
 * Dropped only from the end of a name, and only as whole words: "Adyen" keeps
 * its letters, "Delivery Hero SE" loses its suffix.
 */
const LEGAL_SUFFIXES = new Set([
    "gmbh", "ag", "se", "ug", "kg", "bv", "nv", "inc", "ltd", "limited", "oy", "ab", "as",
]);

function alphanumeric(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function words(name: string): string[] {
    return name.trim().split(/\s+/).filter(Boolean);
}

function withoutLegalSuffixes(name: string): string[] {
    const parts = words(name);
    while (parts.length > 1 && LEGAL_SUFFIXES.has(alphanumeric(parts[parts.length - 1] ?? ""))) {
        parts.pop();
    }
    return parts;
}

/**
 * The tokens a company name could plausibly have on a board, most likely first.
 * There is no directory of these, so the list is a guess — but each guess costs
 * one cheap request that either resolves to a board or does not.
 */
export function slugCandidates(name: string): string[] {
    const parts = words(name);
    const candidates = [
        alphanumeric(name),
        alphanumeric(withoutLegalSuffixes(name).join("")),
        parts.map(alphanumeric).filter(Boolean).join("-"),
        alphanumeric(parts[0] ?? ""),
    ];
    return [...new Set(candidates.filter(Boolean))];
}

/** The slugs to try for a candidate: the ones it pins, or the derived guesses. */
export function slugsFor(candidate: Candidate): string[] {
    const pinned = (candidate.slugs ?? []).map((slug) => slug.trim()).filter(Boolean);
    return pinned.length ? [...new Set(pinned)] : slugCandidates(candidate.name);
}

export function filterCandidates(
    candidates: readonly Candidate[],
    countries: readonly string[] = [],
): Candidate[] {
    if (!countries.length) return [...candidates];
    const wanted = new Set(countries.map((code) => code.trim().toUpperCase()));
    return candidates.filter((candidate) => wanted.has(candidate.country.toUpperCase()));
}

/* ------------------------------------------------------------------ */
/* Etiquette: pacing, cooldown, budget                                  */
/* ------------------------------------------------------------------ */

interface Pacer {
    /** Claims the next slot for a board and returns how long to wait for it. */
    reserve(board: BoardName): number;
}

function createPacer(now: () => number): Pacer {
    const nextAt = new Map<BoardName, number>();
    return {
        reserve(board) {
            const current = now();
            // Read and write without awaiting in between, so concurrent probes
            // queue behind each other instead of all claiming the same slot.
            const at = Math.max(current, nextAt.get(board) ?? 0);
            nextAt.set(board, at + MIN_GAP_MS);
            return at - current;
        },
    };
}

interface Cooldown {
    active(board: BoardName): boolean;
    start(board: BoardName): void;
}

function createCooldown(now: () => number): Cooldown {
    const until = new Map<BoardName, number>();
    return {
        active: (board) => (until.get(board) ?? 0) > now(),
        start: (board) => void until.set(board, now() + RATE_LIMIT_COOLDOWN_MS),
    };
}

export class ProbeBudget {
    #spent = 0;
    #reported = false;

    constructor(readonly limit: number = MAX_PROBES_PER_RUN) {}

    get spent(): number {
        return this.#spent;
    }

    get exhausted(): boolean {
        return this.#spent >= this.limit;
    }

    take(): boolean {
        if (this.exhausted) return false;
        this.#spent += 1;
        return true;
    }

    /** True the first time the cap is hit, so the message is printed once. */
    shouldReport(): boolean {
        if (this.#reported) return false;
        this.#reported = true;
        return true;
    }
}

/* ------------------------------------------------------------------ */
/* Probing                                                              */
/* ------------------------------------------------------------------ */

export interface ProbeContext {
    http: HttpClient;
    keywords: readonly string[];
    cache?: DiscoveryCache;
    refresh: boolean;
    budget: ProbeBudget;
    pacer: Pacer;
    cooldown: Cooldown;
    sleep: (ms: number) => Promise<void>;
}

export interface ProbeContextOptions {
    http?: HttpClient;
    keywords?: readonly string[];
    cache?: DiscoveryCache;
    refresh?: boolean;
    budget?: ProbeBudget;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
}

export function createProbeContext(options: ProbeContextOptions = {}): ProbeContext {
    const now = options.now ?? (() => Date.now());
    return {
        http: options.http ?? createHttp(),
        keywords: options.keywords ?? [],
        ...(options.cache ? {cache: options.cache} : {}),
        refresh: options.refresh ?? false,
        budget: options.budget ?? new ProbeBudget(),
        pacer: createPacer(now),
        cooldown: createCooldown(now),
        sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    };
}

function invalid(board: BoardName, token: string, reason: string): ProbeResult {
    return {
        board,
        token,
        valid: false,
        companyName: null,
        totalJobs: 0,
        matchingJobs: 0,
        sampleTitles: [],
        locations: [],
        reason,
    };
}

function summarise(
    board: BoardName,
    token: string,
    postings: readonly RawPosting[],
    keywords: readonly string[],
): ProbeResult {
    const matching = postings.filter((posting) => matchesKeywords(posting, keywords));

    // A matching title next to a matching count is the useful sample; fall back
    // to the board's own postings when nothing matched.
    const sampleFrom = matching.length ? matching : postings;
    const locations = [
        ...new Set(postings.map((posting) => posting.location?.trim()).filter(Boolean)),
    ] as string[];

    // Only Greenhouse returns the employer name. For the others the adapter
    // falls back to the token, which is not a name anyone reported.
    const reported = postings[0]?.company;

    return {
        board,
        token,
        valid: true,
        companyName: reported && reported !== token ? reported : null,
        totalJobs: postings.length,
        matchingJobs: matching.length,
        sampleTitles: sampleFrom.slice(0, SAMPLE_TITLE_LIMIT).map((posting) => posting.title),
        locations: locations.slice(0, LOCATION_LIMIT),
    };
}

/**
 * Asks one board whether it has a job board under one token.
 *
 * Never throws. A 404 is an answer, not a failure, and is not retried — the
 * HTTP client only retries 429 and 5xx. An empty payload counts as invalid too:
 * a board with no postings is indistinguishable from a wrong token and is worth
 * nothing to `search` either way.
 */
export async function probeToken(
    board: BoardName,
    token: string,
    context: ProbeContext = createProbeContext(),
): Promise<ProbeResult> {
    const key = `${board}:${token}`;

    if (!context.refresh) {
        const cached = context.cache?.get(key, context.keywords);
        if (cached) return cached;
    }

    if (context.cooldown.active(board)) {
        return invalid(board, token, `${board} is cooling off after HTTP 429`);
    }

    if (!context.budget.take()) {
        return invalid(board, token, `probe cap of ${context.budget.limit} reached`);
    }

    const delay = context.pacer.reserve(board);
    if (delay > 0) await context.sleep(delay);

    let payload: unknown;
    try {
        payload = await context.http.getJson<unknown>(ADAPTERS[board].url(token), {label: key});
    } catch (error) {
        if (error instanceof HttpError && (error.status === 404 || error.status === 410)) {
            const result = invalid(board, token, `no ${board} board at "${token}"`);
            context.cache?.put(result, context.keywords);
            return result;
        }

        if (error instanceof HttpError && error.status === 429) {
            context.cooldown.start(board);
            warn(`${key}: rate limited, leaving ${board} alone for 60s`);
            return invalid(board, token, "rate limited");
        }

        // A transport failure says nothing about the token, so it is reported
        // but never cached — one bad moment must not blacklist a real board.
        const reason = error instanceof Error ? error.message : String(error);
        warn(`${key}: ${reason}`);
        return invalid(board, token, reason);
    }

    const postings = ADAPTERS[board].parse(payload, {token}, new Date().toISOString());
    const result = postings.length
        ? summarise(board, token, postings, context.keywords)
        : invalid(board, token, `${board} board "${token}" lists no postings`);

    context.cache?.put(result, context.keywords);
    return result;
}

/* ------------------------------------------------------------------ */
/* Discovery                                                            */
/* ------------------------------------------------------------------ */

export interface DiscoverOptions {
    keywords: readonly string[];
    boards?: readonly string[];
    minMatching?: number;
}

/**
 * Probes every candidate against every requested board until one answers.
 *
 * A company stops as soon as a board is found for it: at most four slugs times
 * three boards, and in practice one to three requests. Companies run three at a
 * time; each one's slugs are tried in order, cheapest guess first.
 */
export async function discoverFromCandidates(
    candidates: readonly Candidate[],
    options: DiscoverOptions,
    context: ProbeContext = createProbeContext({keywords: options.keywords}),
): Promise<DiscoveryResult[]> {
    const boards = (options.boards?.length ? options.boards : BOARD_NAMES).filter(isBoardName);
    const minMatching = options.minMatching ?? 1;
    const limit = pLimit(COMPANY_CONCURRENCY);

    async function probeCompany(candidate: Candidate): Promise<DiscoveryResult | null> {
        for (const token of slugsFor(candidate)) {
            for (const board of boards) {
                if (context.budget.exhausted) {
                    if (context.budget.shouldReport()) {
                        warn(
                            `stopped at the cap of ${context.budget.limit} probes for this run. ` +
                                "Narrow the list with --country or --board, or run again — " +
                                "everything probed so far is cached.",
                        );
                    }
                    return null;
                }

                const result = await probeToken(board, token, context);
                if (result.valid) {
                    return {...result, company: candidate.name, country: candidate.country};
                }
            }
        }
        return null;
    }

    const found = await Promise.all(
        candidates.map((candidate) => limit(() => probeCompany(candidate))),
    );

    return found
        .filter((result): result is DiscoveryResult => result !== null)
        .filter((result) => result.matchingJobs >= minMatching)
        .sort((a, b) => b.matchingJobs - a.matchingJobs || a.company.localeCompare(b.company));
}
