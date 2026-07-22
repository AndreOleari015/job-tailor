import {readFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {afterEach, describe, expect, it, vi} from "vitest";
import {companyFromHeader} from "../src/core/extract.js";
import {loadProfile} from "../src/core/tailor.js";
import {createAdzunaSource} from "../src/sources/adzuna.js";
import {createArbeitsagenturSource} from "../src/sources/arbeitsagentur.js";
import {createAshbySource} from "../src/sources/ashby.js";
import {PostingCache} from "../src/sources/cache.js";
import {createGreenhouseSource} from "../src/sources/greenhouse.js";
import {createHttp, type FetchLike, type HttpClient} from "../src/sources/http.js";
import {createLeverSource} from "../src/sources/lever.js";
import {htmlToText, withHeader} from "../src/sources/text.js";
import {SourceUnavailableError, type JobSource, type RawPosting} from "../src/sources/types.js";
import {searchAll} from "../src/sources/index.js";
import type {Profile} from "../src/types.js";

afterEach(() => {
    vi.restoreAllMocks();
});

const profile: Profile = await loadProfile(
    fileURLToPath(new URL("../data/profile.example.yaml", import.meta.url)),
);

async function fixture<T>(name: string): Promise<T> {
    const raw = await readFile(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");
    return JSON.parse(raw) as T;
}

/** An HttpClient that answers from recorded fixtures and records its calls. */
function stubHttp(routes: Record<string, unknown>): HttpClient & {calls: string[]} {
    const calls: string[] = [];
    return {
        calls,
        async getJson<T>(url: string): Promise<T> {
            calls.push(url);
            const match = Object.entries(routes).find(([fragment]) => url.includes(fragment));
            if (!match) throw new Error(`no fixture for ${url}`);
            return match[1] as T;
        },
    };
}

const emptyQuery = {keywords: [] as string[]};

/* ------------------------------------------------------------------ */
/* Plain-text conversion                                                */
/* ------------------------------------------------------------------ */

describe("htmlToText", () => {
    it("separates paragraphs with a blank line", () => {
        expect(htmlToText("<p>First para.</p><p>Second para.</p>")).toBe(
            "First para.\n\nSecond para.",
        );
    });

    it("renders list items as '- ' lines", () => {
        const text = htmlToText("<ul><li>React Native</li><li>TypeScript</li></ul>");
        expect(text.split("\n").filter(Boolean)).toEqual(["- React Native", "- TypeScript"]);
    });

    it("unescapes HTML that arrives escaped, as Greenhouse sends it", () => {
        expect(htmlToText("&lt;p&gt;Ship &amp; iterate&lt;/p&gt;")).toBe("Ship & iterate");
    });

    it("drops script and style content", () => {
        expect(htmlToText("<p>Keep</p><script>evil()</script><style>a{}</style>")).toBe("Keep");
    });

    it("collapses runs of blank lines and spaces", () => {
        expect(htmlToText("<p>a</p><p></p><p></p><p>b   c</p>")).toBe("a\n\nb c");
    });
});

describe("withHeader", () => {
    it("prepends Company and Location in the shape extract reads", () => {
        const text = withHeader({
            company: "Meridian",
            location: "Berlin",
            description: "We are hiring.",
        });
        expect(text.startsWith("Company: Meridian\nLocation: Berlin\n\n")).toBe(true);
    });

    it("feeds companyFromHeader(), the deterministic override in extract", () => {
        const text = withHeader({company: "Meridian", location: null, description: "Body."});
        expect(companyFromHeader(text)).toBe("Meridian");
    });

    it("omits the header entirely when nothing is known", () => {
        expect(withHeader({company: null, location: null, description: "Body."})).toBe("Body.\n");
    });
});

/* ------------------------------------------------------------------ */
/* Per-source parsing                                                   */
/* ------------------------------------------------------------------ */

function expectWellFormed(posting: RawPosting, source: string): void {
    expect(posting.sourceId.startsWith(`${source}:`)).toBe(true);
    expect(posting.source).toBe(source);
    expect(posting.title.length).toBeGreaterThan(0);
    expect(posting.text.length).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(posting.fetchedAt))).toBe(false);
    if (posting.postedAt) expect(Number.isNaN(Date.parse(posting.postedAt))).toBe(false);
    // No markup survives into the text handed to the extractor.
    expect(posting.text).not.toMatch(/<\/?[a-z][^>]*>/i);
}

describe("greenhouse", () => {
    it("parses its board into well-formed postings", async () => {
        const http = stubHttp({"boards-api.greenhouse.io": await fixture("greenhouse.json")});
        const source = createGreenhouseSource({http, entries: [{token: "stripe"}]});

        const postings = await source.search(emptyQuery);
        expect(postings.length).toBeGreaterThan(0);
        for (const posting of postings) expectWellFormed(posting, "greenhouse");
        // Greenhouse does name the employer, so it wins over the token.
        expect(postings[0]?.company).toBe("Stripe");
        expect(companyFromHeader(postings[0]!.text)).toBe("Stripe");
    });
});

describe("lever", () => {
    it("parses its board and labels the company from config", async () => {
        const http = stubHttp({"api.lever.co": await fixture("lever.json")});
        const source = createLeverSource({
            http,
            entries: [{token: "leverdemo", label: "Lever Demo"}],
        });

        const postings = await source.search(emptyQuery);
        expect(postings.length).toBeGreaterThan(0);
        for (const posting of postings) expectWellFormed(posting, "lever");
        // Lever's payload never names the employer; the label does.
        expect(postings[0]?.company).toBe("Lever Demo");
    });
});

describe("ashby", () => {
    it("parses its board into well-formed postings", async () => {
        const http = stubHttp({"api.ashbyhq.com": await fixture("ashby.json")});
        const source = createAshbySource({http, entries: [{token: "nory", label: "Nory"}]});

        const postings = await source.search(emptyQuery);
        expect(postings.length).toBeGreaterThan(0);
        for (const posting of postings) expectWellFormed(posting, "ashby");
        expect(postings[0]?.company).toBe("Nory");
    });
});

describe("adzuna", () => {
    it("marks its postings as truncated", async () => {
        const http = stubHttp({"api.adzuna.com": await fixture("adzuna.json")});
        const source = createAdzunaSource({
            http,
            credentials: {appId: "id", appKey: "key"},
        });

        const postings = await source.search(emptyQuery);
        expect(postings.length).toBe(2);
        for (const posting of postings) {
            expectWellFormed(posting, "adzuna");
            expect(posting.textTruncated).toBe(true);
        }
    });

    it("is skipped with a readable message when credentials are absent", async () => {
        const http = stubHttp({});
        const source = createAdzunaSource({http, credentials: undefined});

        await expect(source.search(emptyQuery)).rejects.toBeInstanceOf(SourceUnavailableError);
        await expect(source.search(emptyQuery)).rejects.toThrow(/ADZUNA_APP_ID/);
        // It never reached the network to find that out.
        expect(http.calls).toHaveLength(0);
    });
});

describe("arbeitsagentur", () => {
    it("fetches the detail for each search hit", async () => {
        const http = stubHttp({
            "/jobdetails/": await fixture("arbeitsagentur-detail.json"),
            "/jobs?": await fixture("arbeitsagentur-search.json"),
        });
        const source = createArbeitsagenturSource({http, apiKey: "jobboerse-jobsuche"});

        const postings = await source.search(emptyQuery);
        expect(postings.length).toBeGreaterThan(0);
        for (const posting of postings) expectWellFormed(posting, "arbeitsagentur");
        // One search request plus one detail request per hit.
        expect(http.calls.filter((url) => url.includes("/jobdetails/")).length).toBe(
            postings.length,
        );
    });

    it("fails readably when the client key is not configured", async () => {
        const source = createArbeitsagenturSource({http: stubHttp({}), apiKey: undefined});
        await expect(source.search(emptyQuery)).rejects.toThrow(/ARBEITSAGENTUR_API_KEY/);
    });

    it("serves a cached posting instead of refetching its detail", async () => {
        const search = await fixture<{stellenangebote: {refnr: string}[]}>(
            "arbeitsagentur-search.json",
        );
        const http = stubHttp({
            "/jobdetails/": await fixture("arbeitsagentur-detail.json"),
            "/jobs?": search,
        });

        const cache = await PostingCache.open("/dev/null");
        const refnr = search.stellenangebote[0]!.refnr;
        cache.put({
            sourceId: `arbeitsagentur:${refnr}`,
            source: "arbeitsagentur",
            company: "Cached GmbH",
            title: "Cached role",
            location: "Berlin",
            language: "de",
            url: "https://example.invalid",
            postedAt: null,
            text: "Company: Cached GmbH\n\nCached body.\n",
            fetchedAt: new Date().toISOString(),
        });

        const source = createArbeitsagenturSource({http, apiKey: "k", cache});
        const postings = await source.search(emptyQuery);

        const cached = postings.find((one) => one.sourceId === `arbeitsagentur:${refnr}`);
        expect(cached?.company).toBe("Cached GmbH");
        // The cached hit cost no detail request; the other hit still made one.
        expect(http.calls.filter((url) => url.includes("/jobdetails/")).length).toBe(
            postings.length - 1,
        );
    });
});

/* ------------------------------------------------------------------ */
/* HTTP behaviour                                                       */
/* ------------------------------------------------------------------ */

describe("http", () => {
    it("retries a 429 and succeeds on the third attempt", async () => {
        vi.spyOn(process.stderr, "write").mockReturnValue(true);
        let attempts = 0;

        const fetchLike: FetchLike = async () => {
            attempts += 1;
            if (attempts < 3) return new Response("slow down", {status: 429});
            return new Response(JSON.stringify({ok: true}), {status: 200});
        };

        const http = createHttp({fetch: fetchLike, sleep: async () => {}});
        await expect(http.getJson<{ok: boolean}>("https://example.invalid/x")).resolves.toEqual({
            ok: true,
        });
        expect(attempts).toBe(3);
    });

    it("honours Retry-After over its own backoff", async () => {
        vi.spyOn(process.stderr, "write").mockReturnValue(true);
        const waits: number[] = [];
        let attempts = 0;

        const fetchLike: FetchLike = async () => {
            attempts += 1;
            if (attempts === 1) {
                return new Response("wait", {status: 429, headers: {"retry-after": "7"}});
            }
            return new Response(JSON.stringify({ok: true}), {status: 200});
        };

        const http = createHttp({
            fetch: fetchLike,
            sleep: async (ms) => {
                waits.push(ms);
            },
        });
        await http.getJson("https://example.invalid/x");
        expect(waits).toEqual([7000]);
    });

    it("does not retry a 404", async () => {
        let attempts = 0;
        const fetchLike: FetchLike = async () => {
            attempts += 1;
            return new Response("nope", {status: 404});
        };

        const http = createHttp({fetch: fetchLike, sleep: async () => {}});
        await expect(http.getJson("https://example.invalid/x")).rejects.toThrow(/404/);
        expect(attempts).toBe(1);
    });

    it("sends a descriptive User-Agent", async () => {
        let sent: string | undefined;
        const fetchLike: FetchLike = async (_url, init) => {
            sent = (init?.headers as Record<string, string>)["user-agent"];
            return new Response("{}", {status: 200});
        };

        await createHttp({fetch: fetchLike}).getJson("https://example.invalid/x");
        expect(sent).toContain("job-tailor");
    });
});

/* ------------------------------------------------------------------ */
/* searchAll: dedupe, tolerance, cache                                  */
/* ------------------------------------------------------------------ */

function fakeSource(
    name: string,
    kind: "board" | "aggregator",
    postings: RawPosting[],
    behaviour: {fails?: boolean} = {},
): JobSource {
    return {
        name,
        kind,
        requiresCredentials: false,
        async search() {
            if (behaviour.fails) throw new Error(`${name} is down`);
            return postings;
        },
    };
}

function posting(over: Partial<RawPosting> & {sourceId: string; source: string}): RawPosting {
    return {
        company: "Meridian",
        title: "React Native Engineer",
        location: "Berlin",
        url: "https://example.invalid",
        postedAt: null,
        text: "Company: Meridian\n\nReact Native and TypeScript.\n",
        language: "en",
        fetchedAt: new Date().toISOString(),
        ...over,
    };
}

async function runSearch(sources: JobSource[], options: {refresh?: boolean} = {}) {
    const cache = await PostingCache.open("/dev/null");
    vi.spyOn(cache, "save").mockResolvedValue();

    return searchAll({
        query: {keywords: []},
        profile,
        cache,
        ...options,
        sourcesOverride: sources,
    });
}

describe("searchAll", () => {
    it("prefers the board copy of a role the aggregator also lists", async () => {
        const result = await runSearch([
            fakeSource("adzuna", "aggregator", [
                posting({sourceId: "adzuna:1", source: "adzuna", textTruncated: true}),
            ]),
            fakeSource("greenhouse", "board", [
                posting({sourceId: "greenhouse:meridian:9", source: "greenhouse"}),
            ]),
        ]);

        expect(result.postings).toHaveLength(1);
        expect(result.postings[0]?.source).toBe("greenhouse");
        expect(result.postings[0]?.textTruncated).toBeUndefined();
    });

    it("keeps both when company, title or location differ", async () => {
        const result = await runSearch([
            fakeSource("greenhouse", "board", [
                posting({sourceId: "greenhouse:a:1", source: "greenhouse"}),
                posting({
                    sourceId: "greenhouse:a:2",
                    source: "greenhouse",
                    title: "Backend Engineer",
                }),
            ]),
        ]);
        expect(result.postings).toHaveLength(2);
    });

    it("warns and continues when a source fails entirely", async () => {
        const result = await runSearch([
            fakeSource("lever", "board", [], {fails: true}),
            fakeSource("ashby", "board", [posting({sourceId: "ashby:n:1", source: "ashby"})]),
        ]);

        expect(result.warnings.join(" ")).toContain("lever");
        expect(result.postings).toHaveLength(1);
        expect(result.postings[0]?.source).toBe("ashby");
    });

    it("scores and orders by the keyword pre-score", async () => {
        const result = await runSearch([
            fakeSource("ashby", "board", [
                posting({
                    sourceId: "ashby:n:1",
                    source: "ashby",
                    title: "COBOL Engineer",
                    text: "Company: Meridian\n\nCOBOL and mainframe work.\n",
                }),
                posting({sourceId: "ashby:n:2", source: "ashby", title: "React Native Engineer"}),
            ]),
        ]);

        expect(result.postings[0]?.title).toBe("React Native Engineer");
        expect(result.postings[0]?.preScore).toBe(100);
        // Nothing in the COBOL posting is in the vocabulary, so it is unscored
        // rather than scored 100 — and an unscored posting sorts last.
        expect(result.postings[1]?.preScore).toBeNull();
    });

    it("applies the limit", async () => {
        const many = Array.from({length: 5}, (_, index) =>
            posting({
                sourceId: `ashby:n:${index}`,
                source: "ashby",
                title: `Role ${index}`,
            }),
        );
        const result = await runSearch([fakeSource("ashby", "board", many)]);
        expect(result.postings.length).toBe(5);

        const limited = await searchAll({
            query: {keywords: []},
            profile,
            limit: 2,
            cache: await (async () => {
                const cache = await PostingCache.open("/dev/null");
                vi.spyOn(cache, "save").mockResolvedValue();
                return cache;
            })(),
            sourcesOverride: [fakeSource("ashby", "board", many)],
        });
        expect(limited.postings).toHaveLength(2);
    });
});
