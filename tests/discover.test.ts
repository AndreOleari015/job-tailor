import {mkdtemp, readFile, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {afterEach, describe, expect, it, vi} from "vitest";
import {DiscoveryCache} from "../src/sources/cache.js";
import type {Candidate} from "../src/sources/candidates.js";
import {appendCompanies, loadCompanies} from "../src/sources/companies.js";
import {
    createProbeContext,
    discoverFromCandidates,
    filterCandidates,
    probeToken,
    ProbeBudget,
    slugCandidates,
    type ProbeContext,
} from "../src/sources/discover.js";
import {createHttp, type FetchLike} from "../src/sources/http.js";

afterEach(() => {
    vi.restoreAllMocks();
});

async function fixture<T>(name: string): Promise<T> {
    const raw = await readFile(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");
    return JSON.parse(raw) as T;
}

const greenhouse = await fixture<unknown>("greenhouse.json");
const ashby = await fixture<unknown>("ashby.json");

/** A fetch that answers by URL fragment and records every call it received. */
function stubFetch(routes: Record<string, {status?: number; body?: unknown}>): FetchLike & {
    calls: string[];
} {
    const calls: string[] = [];
    const doFetch = (async (url: string) => {
        calls.push(url);
        const match = Object.entries(routes).find(([fragment]) => url.includes(fragment));
        const {status = 200, body = {}} = match?.[1] ?? {status: 404, body: {message: "not found"}};
        return new Response(JSON.stringify(body), {
            status,
            headers: {"content-type": "application/json"},
        });
    }) as FetchLike & {calls: string[]};

    doFetch.calls = calls;
    return doFetch;
}

/** A context with no waiting and no cache, unless the test asks for one. */
function context(
    fetch: FetchLike,
    overrides: Partial<Parameters<typeof createProbeContext>[0]> = {},
): ProbeContext {
    return createProbeContext({
        http: createHttp({fetch, sleep: async () => {}, concurrency: 3}),
        keywords: ["react native", "typescript"],
        sleep: async () => {},
        ...overrides,
    });
}

/* ------------------------------------------------------------------ */
/* Slugs                                                                */
/* ------------------------------------------------------------------ */

describe("slugCandidates", () => {
    it("strips a legal suffix as its own candidate", () => {
        expect(slugCandidates("N26 GmbH")).toEqual(["n26gmbh", "n26", "n26-gmbh"]);
    });

    it("hyphenates a two-word name and keeps the first word", () => {
        expect(slugCandidates("Trade Republic")).toEqual([
            "traderepublic",
            "trade-republic",
            "trade",
        ]);
    });

    it("produces a single candidate for a one-word name", () => {
        // Every rule collapses to the same string, and it is only probed once.
        expect(slugCandidates("GetYourGuide")).toEqual(["getyourguide"]);
    });

    it("handles a three-word name with a suffix", () => {
        expect(slugCandidates("Delivery Hero SE")).toEqual([
            "deliveryherose",
            "deliveryhero",
            "delivery-hero-se",
            "delivery",
        ]);
    });

    it("never returns more than four candidates", () => {
        for (const name of ["N26 GmbH", "Trade Republic", "Delivery Hero SE", "Red Points"]) {
            expect(slugCandidates(name).length).toBeLessThanOrEqual(4);
        }
    });
});

describe("filterCandidates", () => {
    const candidates: Candidate[] = [
        {name: "Trade Republic", country: "DE"},
        {name: "Adyen", country: "NL"},
        {name: "Nory", country: "IE"},
    ];

    it("keeps everything when no country is given", () => {
        expect(filterCandidates(candidates)).toHaveLength(3);
    });

    it("filters by the candidate's country field", () => {
        expect(filterCandidates(candidates, ["NL"]).map((one) => one.name)).toEqual(["Adyen"]);
    });

    it("accepts several countries and is case insensitive", () => {
        const names = filterCandidates(candidates, ["de", "ie"]).map((one) => one.name);
        expect(names).toEqual(["Trade Republic", "Nory"]);
    });
});

/* ------------------------------------------------------------------ */
/* probeToken                                                           */
/* ------------------------------------------------------------------ */

describe("probeToken", () => {
    it("reports a valid board with its counts and samples", async () => {
        const fetch = stubFetch({"boards-api.greenhouse.io": {body: greenhouse}});
        const result = await probeToken("greenhouse", "examplecorp", context(fetch));

        expect(result.valid).toBe(true);
        expect(result.totalJobs).toBeGreaterThan(0);
        expect(result.sampleTitles.length).toBeGreaterThan(0);
        expect(result.sampleTitles.length).toBeLessThanOrEqual(5);
        expect(result.locations.length).toBeLessThanOrEqual(10);
    });

    it("names the employer only when the board reports one", async () => {
        const gh = await probeToken(
            "greenhouse",
            "examplecorp",
            context(stubFetch({"boards-api.greenhouse.io": {body: greenhouse}})),
        );
        // Greenhouse returns company_name; Ashby does not, and the token is not
        // a name anybody reported.
        expect(gh.companyName).toBeTruthy();

        const ash = await probeToken(
            "ashby",
            "nory",
            context(stubFetch({"api.ashbyhq.com": {body: ashby}})),
        );
        expect(ash.valid).toBe(true);
        expect(ash.companyName).toBeNull();
    });

    it("returns valid: false on a 404 without retrying it", async () => {
        const fetch = stubFetch({"boards-api.greenhouse.io": {status: 404, body: {}}});
        const result = await probeToken("greenhouse", "nosuchcompany", context(fetch));

        expect(result.valid).toBe(false);
        expect(result.reason).toMatch(/no greenhouse board/);
        // The retry loop is for 429 and 5xx. A 404 is an answer.
        expect(fetch.calls).toHaveLength(1);
    });

    it("treats an empty payload as invalid", async () => {
        const fetch = stubFetch({"boards-api.greenhouse.io": {body: {jobs: []}}});
        const result = await probeToken("greenhouse", "emptyboard", context(fetch));

        expect(result.valid).toBe(false);
        expect(result.reason).toMatch(/lists no postings/);
    });

    it("counts only the postings that match the keywords", async () => {
        const board = {
            jobs: [
                {id: 1, title: "React Native Engineer", content: "We use TypeScript.", location: {name: "Berlin"}},
                {id: 2, title: "Warehouse Associate", content: "Lifting boxes.", location: {name: "Berlin"}},
                {id: 3, title: "Backend Engineer", content: "Go and Postgres.", location: {name: "Munich"}},
            ],
        };
        const result = await probeToken(
            "greenhouse",
            "examplecorp",
            context(stubFetch({"boards-api.greenhouse.io": {body: board}})),
        );

        expect(result.totalJobs).toBe(3);
        expect(result.matchingJobs).toBe(1);
        // The sample leads with a matching title, since that is what the count
        // is about.
        expect(result.sampleTitles[0]).toBe("React Native Engineer");
        expect(result.locations).toEqual(["Berlin", "Munich"]);
    });

    it("never throws on a transport failure, and reports the reason", async () => {
        vi.spyOn(process.stderr, "write").mockReturnValue(true);
        const failing: FetchLike = async () => {
            throw new Error("ECONNRESET");
        };

        const result = await probeToken("lever", "examplestartup", context(failing));
        expect(result.valid).toBe(false);
        expect(result.reason).toMatch(/ECONNRESET/);
    });

    it("stops probing a board for 60s after a 429", async () => {
        const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
        const fetch = stubFetch({"api.lever.co": {status: 429, body: {}}});
        const shared = context(fetch);

        const first = await probeToken("lever", "one", shared);
        expect(first.valid).toBe(false);

        const attempts = fetch.calls.length;
        const second = await probeToken("lever", "two", shared);

        expect(second.reason).toMatch(/cooling off/);
        // No further request went out for that board.
        expect(fetch.calls).toHaveLength(attempts);
        expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join("")).toContain("60s");
    });

    it("spaces requests to the same board by at least 250ms", async () => {
        const waits: number[] = [];
        const fetch = stubFetch({"boards-api.greenhouse.io": {body: greenhouse}});
        const shared = context(fetch, {
            sleep: async (ms: number) => void waits.push(ms),
            now: () => 1_000,
        });

        await probeToken("greenhouse", "one", shared);
        await probeToken("greenhouse", "two", shared);

        // The first goes straight out; the second waits out the gap.
        expect(waits.filter((ms) => ms > 0)).toEqual([250]);
    });
});

/* ------------------------------------------------------------------ */
/* The cache                                                            */
/* ------------------------------------------------------------------ */

describe("the discovery cache", () => {
    it("stops a dead slug being probed twice", async () => {
        const cache = DiscoveryCache.memory();
        const fetch = stubFetch({"boards-api.greenhouse.io": {status: 404, body: {}}});

        const first = await probeToken("greenhouse", "nosuchcompany", context(fetch, {cache}));
        const second = await probeToken("greenhouse", "nosuchcompany", context(fetch, {cache}));

        expect(first.valid).toBe(false);
        expect(second.valid).toBe(false);
        expect(fetch.calls).toHaveLength(1);
    });

    it("is overridden by --refresh", async () => {
        const cache = DiscoveryCache.memory();
        const fetch = stubFetch({"boards-api.greenhouse.io": {status: 404, body: {}}});

        await probeToken("greenhouse", "nosuchcompany", context(fetch, {cache}));
        await probeToken("greenhouse", "nosuchcompany", context(fetch, {cache, refresh: true}));

        expect(fetch.calls).toHaveLength(2);
    });

    it("does not cache a transport failure, which says nothing about the token", async () => {
        vi.spyOn(process.stderr, "write").mockReturnValue(true);
        const cache = DiscoveryCache.memory();
        const failing: FetchLike = async () => {
            throw new Error("ECONNRESET");
        };

        await probeToken("greenhouse", "realcompany", context(failing, {cache}));
        expect(cache.size).toBe(0);
    });

    it("re-probes a hit when the keywords changed, since the counts would be stale", async () => {
        const cache = DiscoveryCache.memory();
        const fetch = stubFetch({"boards-api.greenhouse.io": {body: greenhouse}});

        await probeToken("greenhouse", "examplecorp", context(fetch, {cache}));
        await probeToken(
            "greenhouse",
            "examplecorp",
            context(fetch, {cache, keywords: ["kotlin"]}),
        );

        expect(fetch.calls).toHaveLength(2);
    });

    it("expires a negative after 30 days and a positive after 7", () => {
        const cache = DiscoveryCache.memory();
        const day = 24 * 60 * 60 * 1000;
        const at = new Date("2026-01-01T00:00:00.000Z");
        const base = at.getTime();

        cache.put({board: "greenhouse", token: "dead", valid: false} as never, [], at);
        cache.put(
            {board: "greenhouse", token: "live", valid: true} as never,
            ["react native"],
            at,
        );

        expect(cache.get("greenhouse:live", ["react native"], base + 6 * day)).toBeDefined();
        expect(cache.get("greenhouse:live", ["react native"], base + 8 * day)).toBeUndefined();
        expect(cache.get("greenhouse:dead", [], base + 29 * day)).toBeDefined();
        expect(cache.get("greenhouse:dead", [], base + 31 * day)).toBeUndefined();
    });
});

/* ------------------------------------------------------------------ */
/* discoverFromCandidates                                               */
/* ------------------------------------------------------------------ */

describe("discoverFromCandidates", () => {
    const keywords = ["react native", "typescript"];

    it("stops probing a company once a board answers", async () => {
        // The first slug hits on greenhouse, so lever and ashby are never asked
        // and the remaining slugs are never tried.
        const fetch = stubFetch({"boards-api.greenhouse.io": {body: greenhouse}});
        const results = await discoverFromCandidates(
            [{name: "Trade Republic", country: "DE"}],
            {keywords, minMatching: 0},
            context(fetch, {keywords}),
        );

        expect(results).toHaveLength(1);
        expect(results[0]?.token).toBe("traderepublic");
        expect(fetch.calls).toHaveLength(1);
    });

    it("carries the candidate's company and country into the result", async () => {
        const fetch = stubFetch({"api.ashbyhq.com": {body: ashby}});
        const [result] = await discoverFromCandidates(
            [{name: "Nory", country: "IE"}],
            {keywords, boards: ["ashby"], minMatching: 0},
            context(fetch, {keywords}),
        );

        expect(result?.company).toBe("Nory");
        expect(result?.country).toBe("IE");
    });

    it("tries the next slug when the first one is dead", async () => {
        const fetch = stubFetch({
            "boards/traderepublic": {status: 404, body: {}},
            "boards/trade-republic": {body: greenhouse},
        });
        const results = await discoverFromCandidates(
            [{name: "Trade Republic", country: "DE"}],
            {keywords, boards: ["greenhouse"], minMatching: 0},
            context(fetch, {keywords}),
        );

        expect(results[0]?.token).toBe("trade-republic");
    });

    it("drops a board below --min-matching without hiding that it exists", async () => {
        const board = {jobs: [{id: 1, title: "Warehouse Associate", content: "Boxes."}]};
        const fetch = stubFetch({"boards-api.greenhouse.io": {body: board}});
        const shared = context(fetch, {keywords});

        const reported = await discoverFromCandidates(
            [{name: "Acme", country: "DE"}],
            {keywords, boards: ["greenhouse"], minMatching: 1},
            shared,
        );
        expect(reported).toHaveLength(0);

        // It was found, and the probe is cached — it is only below the bar.
        const all = await discoverFromCandidates(
            [{name: "Acme", country: "DE"}],
            {keywords, boards: ["greenhouse"], minMatching: 0},
            shared,
        );
        expect(all).toHaveLength(1);
    });

    it("sorts by matching postings, descending", async () => {
        const many = {
            jobs: [
                {id: 1, title: "React Native Engineer", content: "x"},
                {id: 2, title: "TypeScript Engineer", content: "x"},
            ],
        };
        const few = {jobs: [{id: 3, title: "React Native Engineer", content: "x"}]};
        const fetch = stubFetch({"boards/few": {body: few}, "boards/many": {body: many}});

        const results = await discoverFromCandidates(
            [
                {name: "Few", country: "DE", slugs: ["few"]},
                {name: "Many", country: "DE", slugs: ["many"]},
            ],
            {keywords, boards: ["greenhouse"], minMatching: 1},
            context(fetch, {keywords}),
        );

        expect(results.map((one) => one.company)).toEqual(["Many", "Few"]);
    });

    it("halts at the probe cap with a message", async () => {
        const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
        const fetch = stubFetch({"boards-api.greenhouse.io": {status: 404, body: {}}});
        const budget = new ProbeBudget(3);

        const candidates: Candidate[] = [
            {name: "One", country: "DE"},
            {name: "Two", country: "DE"},
            {name: "Three", country: "DE"},
            {name: "Four", country: "DE"},
        ];
        const results = await discoverFromCandidates(
            candidates,
            {keywords, boards: ["greenhouse"], minMatching: 0},
            context(fetch, {keywords, budget}),
        );

        expect(results).toHaveLength(0);
        expect(fetch.calls).toHaveLength(3);
        expect(budget.exhausted).toBe(true);

        const logged = stderr.mock.calls.map(([chunk]) => String(chunk)).join("");
        expect(logged).toContain("cap of 3 probes");
        // Said once, not once per company left in the list.
        expect(logged.match(/cap of 3 probes/g)).toHaveLength(1);
    });
});

/* ------------------------------------------------------------------ */
/* Writing companies.yaml                                               */
/* ------------------------------------------------------------------ */

describe("appendCompanies", () => {
    const original = [
        "# Company boards to watch.",
        "",
        "greenhouse: []",
        "# greenhouse:",
        "#   - token: examplecorp",
        "",
        "lever: []",
        "",
        "ashby:",
        "  - token: nory",
        "    label: Nory",
        "",
    ].join("\n");

    async function withFile(body = original): Promise<string> {
        const dir = await mkdtemp(path.join(tmpdir(), "job-tailor-companies-"));
        const filePath = path.join(dir, "companies.yaml");
        await writeFile(filePath, body, "utf8");
        return filePath;
    }

    it("appends without disturbing existing entries or comments", async () => {
        const filePath = await withFile();
        const added = await appendCompanies(filePath, [
            {board: "greenhouse", token: "n26", label: "N26", country: "DE"},
        ]);

        expect(added).toHaveLength(1);
        const text = await readFile(filePath, "utf8");

        expect(text).toContain("# Company boards to watch.");
        expect(text).toContain("#   - token: examplecorp");
        expect(text).toContain("  - token: nory");
        expect(text).toContain("    label: Nory");
        expect(text).toContain("  - token: n26");

        // The empty list became a block, and the new entry sits under it.
        expect(text).not.toContain("greenhouse: []");
        const lines = text.split("\n");
        expect(lines.indexOf("  - token: n26")).toBe(lines.indexOf("greenhouse:") + 1);
    });

    it("carries the country through into the written entry", async () => {
        const filePath = await withFile();
        await appendCompanies(filePath, [
            {board: "ashby", token: "flipdish", label: "Flipdish", country: "IE"},
        ]);

        const config = await loadCompanies(filePath);
        expect(config.ashby).toContainEqual({
            token: "flipdish",
            label: "Flipdish",
            country: "IE",
        });
        // The entry that was already there is untouched.
        expect(config.ashby[0]).toEqual({token: "nory", label: "Nory"});
    });

    it("skips an entry that is already present", async () => {
        const filePath = await withFile();
        const added = await appendCompanies(filePath, [
            {board: "ashby", token: "nory", label: "Nory"},
        ]);

        expect(added).toHaveLength(0);
        expect(await readFile(filePath, "utf8")).toBe(original);
    });

    it("appends into a block list after its last entry", async () => {
        const filePath = await withFile();
        await appendCompanies(filePath, [{board: "ashby", token: "tines", label: "Tines"}]);

        const lines = (await readFile(filePath, "utf8")).split("\n");
        expect(lines.indexOf("  - token: tines")).toBe(lines.indexOf("    label: Nory") + 1);
    });

    it("keeps the file parseable and writes several boards at once", async () => {
        const filePath = await withFile();
        await appendCompanies(filePath, [
            {board: "greenhouse", token: "n26", label: "N26", country: "DE"},
            {board: "lever", token: "mollie", label: "Mollie", country: "NL"},
            {board: "ashby", token: "tines", label: "Tines", country: "IE"},
        ]);

        const config = await loadCompanies(filePath);
        expect(config.greenhouse.map((one) => one.token)).toEqual(["n26"]);
        expect(config.lever.map((one) => one.token)).toEqual(["mollie"]);
        expect(config.ashby.map((one) => one.token)).toEqual(["nory", "tines"]);
    });

    it("quotes a label that would not survive as a plain scalar", async () => {
        const filePath = await withFile();
        await appendCompanies(filePath, [
            {board: "lever", token: "acme", label: "Acme: the sequel"},
        ]);

        const config = await loadCompanies(filePath);
        expect(config.lever[0]?.label).toBe("Acme: the sequel");
    });

    it("creates the file when it does not exist yet", async () => {
        const dir = await mkdtemp(path.join(tmpdir(), "job-tailor-companies-"));
        const filePath = path.join(dir, "companies.yaml");

        await appendCompanies(filePath, [{board: "lever", token: "mollie", label: "Mollie"}]);
        const config = await loadCompanies(filePath);
        expect(config.lever[0]?.token).toBe("mollie");
    });
});
