import type {FastifyInstance} from "fastify";
import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {afterEach, describe, expect, it, vi} from "vitest";
import {loadProfile} from "../src/core/tailor.js";
import {createServer, type Pipeline} from "../src/server/index.js";
import {GenerationQueue} from "../src/server/queue.js";
import {resolveArtefactPath} from "../src/server/routes.js";
import {openStore, type TrackerStore, type UpsertPosting} from "../src/tracker/store.js";
import {
    tailoredApplicationSchema,
    storedApplicationSchema,
    type JobSpec,
    type Profile,
    type TailoredApplication,
} from "../src/types.js";

const scratch: string[] = [];

afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(scratch.splice(0).map((dir) => rm(dir, {recursive: true, force: true})));
});

async function tempDir(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), "job-tailor-server-"));
    scratch.push(dir);
    return dir;
}

const profilePath = fileURLToPath(new URL("../data/profile.example.yaml", import.meta.url));
const profile: Profile = await loadProfile(profilePath);

const jobSpec: JobSpec = {
    company: "Meridian",
    role: "React Native Engineer",
    location: "Berlin, Germany",
    country: "DE",
    remote: "hybrid",
    language: "en",
    seniority: "mid",
    required_stack: ["React Native"],
    nice_to_have: [],
    salary_min_eur: null,
    salary_currency: null,
    visa_sponsorship: "not_mentioned",
    key_responsibilities: [],
    tone: "startup",
};

const BLUE_CARD =
    "Eligible for the EU Blue Card under section 18g AufenthG as an IT specialist, " +
    "based on 4+ years of professional software experience.";

const application: TailoredApplication = {
    selected_bullet_ids: ["pl-cicd", "pl-volume"],
    bullet_order: ["pl-cicd", "pl-volume"],
    cover_letter_bullet_refs: ["pl-cicd"],
    headline: "Mobile engineer shipping cross-platform products",
    profile_summary: "Publishes React Native apps end to end.",
    cover_letter: `Meridian is hiring.\n\nAt Polar Labs I shipped to both stores.\n\n${BLUE_CARD}`,
    match_score: 78,
    gaps: ["Kotlin"],
    flags: [],
};

function posting(over: Partial<UpsertPosting> & {sourceId: string}): UpsertPosting {
    return {
        source: "ashby",
        company: "Meridian",
        title: "React Native Engineer",
        location: "Berlin",
        url: "https://example.invalid",
        postedAt: "2026-07-01T00:00:00Z",
        fetchedAt: "2026-07-20T00:00:00Z",
        text: "Company: Meridian\n\nWe want React Native.\n",
        ...over,
    };
}

interface Spy {
    extract: number;
    tailor: number;
    render: number;
    search: number;
}

/** A pipeline that records what was called, so "no LLM" is provable. */
function fakePipeline(over: Partial<Pipeline> = {}): {pipeline: Pipeline; calls: Spy} {
    const calls: Spy = {extract: 0, tailor: 0, render: 0, search: 0};

    const pipeline: Pipeline = {
        async loadProfile() {
            return profile;
        },
        async extract() {
            calls.extract += 1;
            return jobSpec;
        },
        async tailor() {
            calls.tailor += 1;
            return application;
        },
        async render(input) {
            calls.render += 1;
            return {
                cvPath: path.join(input.outDir, "cv.pdf"),
                coverPath: path.join(input.outDir, "cover-letter.pdf"),
            };
        },
        async search() {
            calls.search += 1;
            return {postings: [], warnings: [], languages: {de: 0, en: 0, unknown: 0}};
        },
        ...over,
    };

    return {pipeline, calls};
}

async function harness(over: Partial<Pipeline> = {}): Promise<{
    app: FastifyInstance;
    store: TrackerStore;
    calls: Spy;
    outputRoot: string;
}> {
    const store = openStore(":memory:");
    const outputRoot = await tempDir();
    const {pipeline, calls} = fakePipeline(over);

    const app = await createServer({
        store,
        pipeline,
        profilePath,
        outputRoot,
        serveStatic: false,
    });

    return {app, store, calls, outputRoot};
}

/* ------------------------------------------------------------------ */
/* Path traversal                                                       */
/* ------------------------------------------------------------------ */

describe("resolveArtefactPath", () => {
    it("accepts a plain document name", () => {
        expect(resolveArtefactPath("/out/acme", "cv.pdf")).toBe(path.resolve("/out/acme/cv.pdf"));
    });

    for (const name of [
        "../secret.pdf",
        "../../etc/passwd",
        "sub/cv.pdf",
        "..\\windows.pdf",
        "/etc/passwd",
        "/out/acme/cv.pdf",
        "..",
    ]) {
        it(`rejects ${JSON.stringify(name)}`, () => {
            expect(resolveArtefactPath("/out/acme", name)).toBeNull();
        });
    }

    it("rejects a file type it does not serve", () => {
        expect(resolveArtefactPath("/out/acme", "profile.yaml")).toBeNull();
        expect(resolveArtefactPath("/out/acme", "tracker.db")).toBeNull();
    });
});

describe("GET /api/postings/:id/files/:name", () => {
    it("refuses a traversing name over HTTP", async () => {
        const {app, store} = await harness();
        store.upsertPostings([posting({sourceId: "a"})]);
        store.setStatus("a", "generating");
        store.recordGeneration("a", {outDir: "/tmp/whatever", matchScore: 70, flags: [], gaps: []});

        const response = await app.inject({
            method: "GET",
            url: "/api/postings/a/files/..%2F..%2Fetc%2Fpasswd",
        });

        expect(response.statusCode).toBe(400);
        store.close();
    });
});

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

describe("GET /api/postings", () => {
    it("returns an empty list on a fresh database", async () => {
        const {app, store} = await harness();
        const response = await app.inject({method: "GET", url: "/api/postings"});

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual([]);
        store.close();
    });

    it("filters by status", async () => {
        const {app, store} = await harness();
        store.upsertPostings([posting({sourceId: "a"}), posting({sourceId: "b"})]);
        store.setStatus("b", "dismissed");

        const response = await app.inject({method: "GET", url: "/api/postings?status=new"});
        expect(response.json().map((one: {sourceId: string}) => one.sourceId)).toEqual(["a"]);
        store.close();
    });
});

describe("POST /api/postings/:id/generate", () => {
    it("runs the pipeline and records the result", async () => {
        const {app, store, calls, outputRoot} = await harness();
        store.upsertPostings([posting({sourceId: "a"})]);

        const response = await app.inject({method: "POST", url: "/api/postings/a/generate"});
        expect(response.statusCode).toBe(200);
        expect(calls).toMatchObject({extract: 1, tailor: 1, render: 1});

        const stored = store.getPosting("a");
        expect(stored?.status).toBe("generated");
        expect(stored?.matchScore).toBe(78);
        expect(stored?.gaps).toEqual(["Kotlin"]);
        expect(stored?.country).toBe("DE");

        // The artefacts are on disk, in the same shape the CLI writes.
        const written = await readFile(
            path.join(outputRoot, "meridian-react-native-engineer", "application.json"),
            "utf8",
        );
        expect(JSON.parse(written).match_score).toBe(78);
        store.close();
    });

    it("marks the posting failed and reports why", async () => {
        const {app, store} = await harness({
            async extract() {
                throw new Error("Gemini quota exhausted");
            },
        });
        store.upsertPostings([posting({sourceId: "a"})]);

        const response = await app.inject({method: "POST", url: "/api/postings/a/generate"});
        expect(response.statusCode).toBe(500);
        expect(store.getPosting("a")?.status).toBe("failed");
        expect(store.getPosting("a")?.lastError).toMatch(/quota/);
        store.close();
    });

    it("404s for an unknown posting", async () => {
        const {app, store} = await harness();
        const response = await app.inject({method: "POST", url: "/api/postings/nope/generate"});
        expect(response.statusCode).toBe(404);
        store.close();
    });

    /*
     * The shape a browser actually sends. fetch() with a JSON content-type and
     * no body made Fastify's default parser reject the request before any
     * handler ran, so every Generate click 400'd — invisible to inject(),
     * which sends no content-type when there is no payload.
     */
    it("accepts a bodyless POST that still declares a JSON content-type", async () => {
        const {app, store, calls} = await harness();
        store.upsertPostings([posting({sourceId: "a"})]);

        const response = await app.inject({
            method: "POST",
            url: "/api/postings/a/generate",
            headers: {"content-type": "application/json"},
        });

        expect(response.statusCode).toBe(200);
        expect(calls.tailor).toBe(1);
        store.close();
    });

    it("still rejects a malformed JSON body", async () => {
        const {app, store} = await harness();
        store.upsertPostings([posting({sourceId: "a"})]);

        const response = await app.inject({
            method: "POST",
            url: "/api/postings/a/status",
            headers: {"content-type": "application/json"},
            payload: "{not json",
        });

        expect(response.statusCode).toBe(400);
        store.close();
    });
});

describe("PUT /api/postings/:id/cover-letter", () => {
    it("re-renders without calling the model", async () => {
        const {app, store, calls} = await harness();
        store.upsertPostings([posting({sourceId: "a"})]);
        await app.inject({method: "POST", url: "/api/postings/a/generate"});

        const before = {...calls};
        const response = await app.inject({
            method: "PUT",
            url: "/api/postings/a/cover-letter",
            payload: {cover_letter: `One.\n\nTwo.\n\n${BLUE_CARD}`},
        });

        expect(response.statusCode).toBe(200);
        // The whole point: a hand edit costs a render, never a model call.
        expect(calls.extract).toBe(before.extract);
        expect(calls.tailor).toBe(before.tailor);
        expect(calls.render).toBe(before.render + 1);
        store.close();
    });

    it("recomputes the flags against what was written", async () => {
        const {app, store} = await harness();
        store.upsertPostings([posting({sourceId: "a"})]);
        await app.inject({method: "POST", url: "/api/postings/a/generate"});

        vi.spyOn(process.stderr, "write").mockReturnValue(true);
        const response = await app.inject({
            method: "PUT",
            url: "/api/postings/a/cover-letter",
            // A letter for a German role that drops the authorisation statement.
            payload: {cover_letter: "One.\n\nTwo.\n\nThree."},
        });

        expect(response.statusCode).toBe(200);
        expect(response.json().application.flags).toContain("MISSING_AUTHORISATION_CLAIM");
        expect(store.getPosting("a")?.flags).toContain("MISSING_AUTHORISATION_CLAIM");
        store.close();
    });

    it("rejects a non-string body", async () => {
        const {app, store} = await harness();
        store.upsertPostings([posting({sourceId: "a"})]);

        const response = await app.inject({
            method: "PUT",
            url: "/api/postings/a/cover-letter",
            payload: {cover_letter: 42},
        });
        expect(response.statusCode).toBe(400);
        store.close();
    });
});

describe("status and outcome routes", () => {
    it("refuses an illegal transition with 409", async () => {
        const {app, store} = await harness();
        store.upsertPostings([posting({sourceId: "a"})]);

        const response = await app.inject({
            method: "POST",
            url: "/api/postings/a/status",
            payload: {status: "applied"},
        });
        expect(response.statusCode).toBe(409);
        store.close();
    });

    it("refuses an outcome before applying", async () => {
        const {app, store} = await harness();
        store.upsertPostings([posting({sourceId: "a"})]);

        const response = await app.inject({
            method: "POST",
            url: "/api/postings/a/outcome",
            payload: {outcome: "offer"},
        });
        expect(response.statusCode).toBe(409);
        store.close();
    });

    it("rejects a status that is not in the machine", async () => {
        const {app, store} = await harness();
        store.upsertPostings([posting({sourceId: "a"})]);

        const response = await app.inject({
            method: "POST",
            url: "/api/postings/a/status",
            payload: {status: "ghosted"},
        });
        expect(response.statusCode).toBe(400);
        store.close();
    });
});

describe("POST /api/search", () => {
    it("upserts results and never calls the model", async () => {
        const {app, store, calls} = await harness({
            async search() {
                return {
                    postings: [
                        {
                            ...posting({sourceId: "ashby:n:1"}),
                            preScore: 80,
                        } as never,
                    ],
                    warnings: ["adzuna needs credentials"],
                    languages: {de: 0, en: 1, unknown: 0},
                };
            },
        });

        const response = await app.inject({
            method: "POST",
            url: "/api/search",
            payload: {keywords: ["react"]},
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({found: 1, added: 1});
        expect(response.json().warnings).toHaveLength(1);
        expect(calls.extract).toBe(0);
        expect(calls.tailor).toBe(0);
        expect(store.getPosting("ashby:n:1")?.status).toBe("new");
        store.close();
    });
});

/* ------------------------------------------------------------------ */
/* Queue                                                                */
/* ------------------------------------------------------------------ */

const LABEL = {company: "Meridian", title: "React Native Engineer"};

describe("GenerationQueue", () => {
    it("serialises two concurrent jobs", async () => {
        const queue = new GenerationQueue();
        const events: string[] = [];

        const task = (name: string) => async () => {
            events.push(`${name}:start`);
            await new Promise((resolve) => setTimeout(resolve, 20));
            events.push(`${name}:end`);
            return name;
        };

        const both = Promise.all([queue.enqueue("a", LABEL, task("a")), queue.enqueue("b", LABEL, task("b"))]);
        expect(queue.status().current).toBeNull();

        await both;
        // b never starts before a has finished.
        expect(events).toEqual(["a:start", "a:end", "b:start", "b:end"]);
    });

    it("keeps running after a job throws", async () => {
        const queue = new GenerationQueue();

        const failing = queue.enqueue("a", LABEL, async () => {
            throw new Error("boom");
        });
        const following = queue.enqueue("b", LABEL, async () => "ok");

        await expect(failing).rejects.toThrow("boom");
        await expect(following).resolves.toBe("ok");
        expect(queue.status()).toMatchObject({current: null, pending: []});
    });

    it("reports what is running and what is waiting", async () => {
        const queue = new GenerationQueue();
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => (release = resolve));

        const first = queue.enqueue("a", LABEL, () => gate);
        const second = queue.enqueue("b", LABEL, async () => undefined);

        await Promise.resolve();
        await Promise.resolve();
        expect(queue.status().current).toBe("a");
        expect(queue.status().pending).toEqual(["b"]);

        release();
        await Promise.all([first, second]);
        expect(queue.status().current).toBeNull();
    });
});

describe("POST /api/postings/:id/generate concurrency", () => {
    it("refuses a second request while one is queued", async () => {
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => (release = resolve));

        const {app, store} = await harness({
            async extract() {
                await gate;
                return jobSpec;
            },
        });
        store.upsertPostings([posting({sourceId: "a"})]);

        const first = app.inject({method: "POST", url: "/api/postings/a/generate"});
        await new Promise((resolve) => setTimeout(resolve, 10));
        const second = await app.inject({method: "POST", url: "/api/postings/a/generate"});

        // Already generating: the state machine and the queue both say no.
        expect(second.statusCode).toBe(409);

        release();
        expect((await first).statusCode).toBe(200);
        store.close();
    });
});

/* ------------------------------------------------------------------ */
/* Stored schema                                                        */
/* ------------------------------------------------------------------ */

describe("reading a skipped application from disk", () => {
    it("parses through the stored schema but not the output schema", async () => {
        const {app, store, outputRoot} = await harness();
        store.upsertPostings([posting({sourceId: "a"})]);

        const outDir = path.join(outputRoot, "skipped");
        const skipped = {...application, cover_letter: "", flags: ["SKIPPED_LOW_MATCH"]};

        await writeFile(
            path.join(await tempDir(), "unused.json"),
            JSON.stringify(skipped),
            "utf8",
        );
        expect(tailoredApplicationSchema.safeParse(skipped).success).toBe(false);
        expect(storedApplicationSchema.safeParse(skipped).success).toBe(true);

        // And the route reads it through the looser one.
        store.setStatus("a", "generating");
        store.recordGeneration("a", {outDir, matchScore: 15, flags: [], gaps: []});
        const {mkdir} = await import("node:fs/promises");
        await mkdir(outDir, {recursive: true});
        await writeFile(path.join(outDir, "job.json"), JSON.stringify(jobSpec), "utf8");
        await writeFile(path.join(outDir, "application.json"), JSON.stringify(skipped), "utf8");

        const response = await app.inject({method: "GET", url: "/api/postings/a/application"});
        expect(response.statusCode).toBe(200);
        expect(response.json().application.cover_letter).toBe("");
        store.close();
    });
});

describe("GET /api/postings?language", () => {
    async function seeded() {
        const harnessed = await harness();
        harnessed.store.upsertPostings([
            posting({sourceId: "de-1", title: "Softwareentwickler", language: "de"}),
            posting({sourceId: "en-1", title: "Software Engineer", language: "en"}),
            posting({sourceId: "un-1", title: "Engineer", language: "unknown"}),
        ]);
        return harnessed;
    }

    it("filters the list by the detected language", async () => {
        const {app} = await seeded();
        const response = await app.inject({method: "GET", url: "/api/postings?language=en"});

        expect(response.statusCode).toBe(200);
        expect(response.json().map((row: {sourceId: string}) => row.sourceId)).toEqual(["en-1"]);
    });

    it("returns everything when the parameter is absent", async () => {
        const {app} = await seeded();
        const response = await app.inject({method: "GET", url: "/api/postings"});
        expect(response.json()).toHaveLength(3);
    });

    it("combines with the status filter", async () => {
        const {app} = await seeded();
        const response = await app.inject({
            method: "GET",
            url: "/api/postings?language=de&status=applied",
        });
        expect(response.json()).toEqual([]);
    });
});

describe("POST /api/search language", () => {
    it("passes the language through to the sources layer", async () => {
        let seen: unknown;
        const {app} = await harness({
            async search(options) {
                seen = options.query.languages;
                return {postings: [], warnings: [], languages: {de: 0, en: 0, unknown: 0}};
            },
        });

        await app.inject({
            method: "POST",
            url: "/api/search",
            payload: {keywords: ["react"], language: "en"},
        });
        expect(seen).toEqual(["en"]);
    });

    it("ignores a language it does not recognise rather than emptying the search", async () => {
        let seen: unknown = "untouched";
        const {app} = await harness({
            async search(options) {
                seen = options.query.languages;
                return {postings: [], warnings: [], languages: {de: 0, en: 0, unknown: 0}};
            },
        });

        await app.inject({
            method: "POST",
            url: "/api/search",
            payload: {keywords: ["react"], language: "klingon"},
        });
        expect(seen).toBeUndefined();
    });
});

/* ------------------------------------------------------------------ */
/* Phase 4.1: stages, queue visibility and cancellation                 */
/* ------------------------------------------------------------------ */

describe("the queue as something you can watch", () => {
    it("numbers what is running 0 and what waits behind it from 1", async () => {
        const queue = new GenerationQueue();
        let release = () => {};
        const gate = new Promise<void>((resolve) => (release = resolve));

        const first = queue.enqueue("a", {company: "Celonis", title: "Engineer"}, () => gate);
        const second = queue.enqueue("b", {company: "N26", title: "Mobile"}, async () => undefined);
        const third = queue.enqueue("c", {company: "SumUp", title: "React Native"}, async () => undefined);

        await Promise.resolve();
        await Promise.resolve();

        const {entries} = queue.status();
        expect(entries.map((one) => [one.sourceId, one.position])).toEqual([
            ["a", 0],
            ["b", 1],
            ["c", 2],
        ]);
        expect(entries[0]?.company).toBe("Celonis");

        release();
        await Promise.all([first, second, third]);
        expect(queue.status().entries).toEqual([]);
    });

    it("refuses to enqueue the same posting twice", async () => {
        const queue = new GenerationQueue();
        let release = () => {};
        const gate = new Promise<void>((resolve) => (release = resolve));

        const running = queue.enqueue("a", LABEL, () => gate);
        expect(() => queue.enqueue("a", LABEL, async () => undefined)).toThrow(/already queued/i);

        release();
        await running;
    });

    it("cancels a waiting posting and renumbers the rest", async () => {
        const queue = new GenerationQueue();
        let release = () => {};
        const gate = new Promise<void>((resolve) => (release = resolve));

        const first = queue.enqueue("a", LABEL, () => gate);
        const second = queue.enqueue("b", LABEL, async () => "b");
        const third = queue.enqueue("c", LABEL, async () => "c");

        await Promise.resolve();
        await Promise.resolve();
        expect(queue.cancel("b")).toBe(true);

        // c moves up rather than keeping the hole b left.
        expect(queue.status().entries.map((one) => [one.sourceId, one.position])).toEqual([
            ["a", 0],
            ["c", 1],
        ]);

        release();
        await expect(second).rejects.toThrow(/cancelled/i);
        await Promise.all([first, third]);
    });

    it("refuses to cancel the posting already running", async () => {
        const queue = new GenerationQueue();
        let release = () => {};
        const gate = new Promise<void>((resolve) => (release = resolve));
        const running = queue.enqueue("a", LABEL, () => gate);

        await Promise.resolve();
        await Promise.resolve();
        // Stopping it here would hide the model call, not end it.
        expect(() => queue.cancel("a")).toThrow(/cannot be cancelled/i);

        release();
        await running;
    });

    it("reports nothing for a posting that was never queued", () => {
        expect(new GenerationQueue().cancel("nobody")).toBe(false);
    });
});

describe("GET /api/status", () => {
    it("is empty on a quiet server", async () => {
        const {app} = await harness();
        const response = await app.inject({method: "GET", url: "/api/status"});

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({running: null, queue: [], queueLength: 0});
    });
});

describe("POST /api/postings/:id/cancel", () => {
    it("returns a queued posting to new, leaving the running one alone", async () => {
        let release = () => {};
        const gate = new Promise<void>((resolve) => (release = resolve));

        const {app, store} = await harness({
            async tailor(profile, jobSpec) {
                await gate;
                return application;
            },
        });
        store.upsertPostings([posting({sourceId: "a"}), posting({sourceId: "b"})]);

        const first = app.inject({method: "POST", url: "/api/postings/a/generate"});
        const second = app.inject({method: "POST", url: "/api/postings/b/generate"});
        await new Promise((resolve) => setTimeout(resolve, 20));

        const cancelled = await app.inject({method: "POST", url: "/api/postings/b/cancel"});
        expect(cancelled.statusCode).toBe(200);
        // It never left `new`: waiting in a queue is not a status.
        expect(store.getPosting("b")?.status).toBe("new");

        const refused = await app.inject({method: "POST", url: "/api/postings/a/cancel"});
        expect(refused.statusCode).toBe(409);
        expect(refused.json().error).toMatch(/cannot be cancelled/i);

        release();
        await Promise.all([first, second]);
    });

    it("404s for a posting that is not queued at all", async () => {
        const {app, store} = await harness();
        store.upsertPostings([posting({sourceId: "a"})]);

        const response = await app.inject({method: "POST", url: "/api/postings/a/cancel"});
        expect(response.statusCode).toBe(404);
    });
});

/* ------------------------------------------------------------------ */
/* Phase 5: leads and the Gmail surface                                 */
/* ------------------------------------------------------------------ */

const lead = {
    sourceId: "lead:1",
    source: "gmail",
    company: "Trade Republic",
    title: "Senior React Native Engineer",
    location: "Berlin, Germany",
    url: "https://linkedin.com/jobs/view/1",
    fetchedAt: "2026-07-20T00:00:00Z",
    leadSource: "gmail:linkedin",
    emailId: "m1",
    emailDate: "2026-07-20T09:00:00Z",
    snippet: "Actively recruiting",
};

describe("generating a lead", () => {
    it("is refused with a message naming the missing description", async () => {
        const {app, store, calls} = await harness();
        store.upsertLeads([lead]);

        const response = await app.inject({method: "POST", url: "/api/postings/lead:1/generate"});
        expect(response.statusCode).toBe(409);
        expect(response.json().error).toMatch(/paste the description/i);
        // The model was never touched.
        expect(calls.extract).toBe(0);
        expect(calls.tailor).toBe(0);
    });
});

describe("POST /api/postings/:id/description", () => {
    it("stores the description and promotes the lead to new", async () => {
        const {app, store} = await harness();
        store.upsertLeads([lead]);

        const response = await app.inject({
            method: "POST",
            url: "/api/postings/lead:1/description",
            payload: {description: "We are hiring. You will build and ship features for the product team here."},
        });

        expect(response.statusCode).toBe(200);
        expect(response.json().status).toBe("new");
        expect(store.getPosting("lead:1")?.status).toBe("new");
    });

    it("rejects an empty description", async () => {
        const {app, store} = await harness();
        store.upsertLeads([lead]);

        const response = await app.inject({
            method: "POST",
            url: "/api/postings/lead:1/description",
            payload: {description: "   "},
        });
        expect(response.statusCode).toBe(400);
    });

    it("refuses a description on a posting that is not a lead", async () => {
        const {app, store} = await harness();
        store.upsertPostings([posting({sourceId: "p1"})]);

        const response = await app.inject({
            method: "POST",
            url: "/api/postings/p1/description",
            payload: {description: "some text"},
        });
        expect(response.statusCode).toBe(409);
    });

    it("then lets the promoted posting generate", async () => {
        const {app, store, calls} = await harness();
        store.upsertLeads([lead]);
        await app.inject({
            method: "POST",
            url: "/api/postings/lead:1/description",
            payload: {description: "We are hiring. You will build and ship features for the product team here."},
        });

        const response = await app.inject({method: "POST", url: "/api/postings/lead:1/generate"});
        expect(response.statusCode).toBe(200);
        expect(calls.tailor).toBe(1);
    });
});
