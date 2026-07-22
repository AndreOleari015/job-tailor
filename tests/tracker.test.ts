import {mkdtemp} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {describe, expect, it} from "vitest";
import {
    canTransition,
    openStore,
    STATUSES,
    TrackerError,
    type Status,
    type TrackerStore,
    type UpsertPosting,
} from "../src/tracker/store.js";

function store(): TrackerStore {
    return openStore(":memory:");
}

function posting(over: Partial<UpsertPosting> & {sourceId: string}): UpsertPosting {
    return {
        source: "ashby",
        company: "Meridian",
        title: "React Native Engineer",
        location: "Berlin",
        url: "https://example.invalid",
        postedAt: "2026-07-01T00:00:00Z",
        fetchedAt: "2026-07-20T00:00:00Z",
        text: "Company: Meridian\n\nBody.\n",
        ...over,
    };
}

/** Every legal move, as the state machine documents it. */
const VALID: [Status, Status][] = [
    ["new", "generating"],
    ["new", "dismissed"],
    ["generating", "generated"],
    ["generating", "failed"],
    ["failed", "generating"],
    ["failed", "dismissed"],
    ["generated", "applied"],
    ["generated", "dismissed"],
    ["generated", "generating"],
    ["applied", "closed"],
    ["applied", "generated"],
    ["closed", "applied"],
    ["closed", "generated"],
    ["dismissed", "new"],
];

/** Walks a posting to `target` using only legal moves. */
function drive(db: TrackerStore, id: string, target: Status): void {
    const routes: Record<Status, Status[]> = {
        new: [],
        generating: ["generating"],
        generated: ["generating", "generated"],
        failed: ["generating", "failed"],
        applied: ["generating", "generated", "applied"],
        dismissed: ["dismissed"],
        closed: ["generating", "generated", "applied", "closed"],
    };
    for (const step of routes[target]) db.setStatus(id, step);
}

describe("status transitions", () => {
    for (const [from, to] of VALID) {
        it(`allows ${from} -> ${to}`, () => {
            const db = store();
            db.upsertPostings([posting({sourceId: "a"})]);
            drive(db, "a", from);

            expect(db.setStatus("a", to).status).toBe(to);
            db.close();
        });
    }

    const invalid: [Status, Status][] = [
        ["new", "generated"],
        ["new", "applied"],
        ["new", "closed"],
        ["generating", "applied"],
        ["generated", "closed"],
        ["applied", "generating"],
        ["applied", "dismissed"],
        ["closed", "new"],
        ["closed", "generating"],
        ["dismissed", "generated"],
    ];

    for (const [from, to] of invalid) {
        it(`refuses ${from} -> ${to}`, () => {
            const db = store();
            db.upsertPostings([posting({sourceId: "a"})]);
            drive(db, "a", from);

            expect(() => db.setStatus("a", to)).toThrow(TrackerError);
            db.close();
        });
    }

    it("names the moves that are allowed instead", () => {
        const db = store();
        db.upsertPostings([posting({sourceId: "a"})]);
        expect(() => db.setStatus("a", "applied")).toThrow(/only moves are: generating, dismissed/);
        db.close();
    });

    it("reopens a closed posting", () => {
        // Closed is no longer terminal: an answer can arrive after you had
        // written a posting off.
        const db = store();
        db.upsertPostings([posting({sourceId: "a"})]);
        drive(db, "a", "closed");

        expect(db.setStatus("a", "applied").status).toBe("applied");
        db.close();
    });

    it("stamps applied_at when a posting is applied", () => {
        const db = store();
        db.upsertPostings([posting({sourceId: "a"})]);
        drive(db, "a", "generated");

        expect(db.getPosting("a")?.appliedAt).toBeNull();
        expect(db.setStatus("a", "applied").appliedAt).not.toBeNull();
        db.close();
    });

    it("clears applied_at and any outcome when un-applied", () => {
        // "not applied" is what generated means, and an outcome describes what
        // happened after applying — neither survives the walk back.
        const db = store();
        db.upsertPostings([posting({sourceId: "a"})]);
        drive(db, "a", "applied");
        db.setOutcome("a", "rejected");

        const back = db.setStatus("a", "generated");
        expect(back.status).toBe("generated");
        expect(back.appliedAt).toBeNull();
        expect(back.outcome).toBeNull();
        db.close();
    });

    it("keeps applied_at and outcome when a posting is closed", () => {
        const db = store();
        db.upsertPostings([posting({sourceId: "a"})]);
        drive(db, "a", "applied");
        const appliedAt = db.getPosting("a")?.appliedAt;
        db.setOutcome("a", "offer");

        const closed = db.setStatus("a", "closed");
        expect(closed.appliedAt).toBe(appliedAt);
        expect(closed.outcome).toBe("offer");
        db.close();
    });

    it("covers every status in the machine", () => {
        for (const status of STATUSES) {
            const reachable = STATUSES.some((other) => canTransition(other, status));
            expect(status === "new" || reachable).toBe(true);
        }
    });
});

describe("outcome", () => {
    it("is refused while the posting is still new", () => {
        const db = store();
        db.upsertPostings([posting({sourceId: "a"})]);
        expect(() => db.setOutcome("a", "rejected")).toThrow(/once you have applied/);
        db.close();
    });

    it("is refused while the posting is only generated", () => {
        const db = store();
        db.upsertPostings([posting({sourceId: "a"})]);
        drive(db, "a", "generated");
        expect(() => db.setOutcome("a", "interview")).toThrow(TrackerError);
        db.close();
    });

    it("is accepted once applied, and again once closed", () => {
        const db = store();
        db.upsertPostings([posting({sourceId: "a"})]);
        drive(db, "a", "applied");
        expect(db.setOutcome("a", "interview").outcome).toBe("interview");

        db.setStatus("a", "closed");
        expect(db.setOutcome("a", "offer").outcome).toBe("offer");
        db.close();
    });

    it("can always be cleared", () => {
        const db = store();
        db.upsertPostings([posting({sourceId: "a"})]);
        expect(db.setOutcome("a", null).outcome).toBeNull();
        db.close();
    });
});

describe("listPostings ordering", () => {
    it("sorts a null pre-score last within its status", () => {
        const db = store();
        db.upsertPostings([
            posting({sourceId: "none", title: "Unscored"}),
            posting({sourceId: "low", title: "Low", preScore: 20}),
            posting({sourceId: "high", title: "High", preScore: 90}),
        ]);

        expect(db.listPostings().map((row) => row.sourceId)).toEqual(["high", "low", "none"]);
        db.close();
    });

    it("puts generated before new regardless of score", () => {
        const db = store();
        db.upsertPostings([
            posting({sourceId: "new-high", preScore: 99}),
            posting({sourceId: "gen-low", preScore: 1}),
        ]);
        drive(db, "gen-low", "generated");

        expect(db.listPostings().map((row) => row.sourceId)).toEqual(["gen-low", "new-high"]);
        db.close();
    });

    it("filters by status, source and free text", () => {
        const db = store();
        db.upsertPostings([
            posting({sourceId: "a", company: "Meridian", source: "ashby"}),
            posting({sourceId: "b", company: "Northwind", source: "lever"}),
        ]);

        expect(db.listPostings({source: "lever"}).map((row) => row.sourceId)).toEqual(["b"]);
        expect(db.listPostings({q: "meri"}).map((row) => row.sourceId)).toEqual(["a"]);
        expect(db.listPostings({status: "generated"})).toHaveLength(0);
        db.close();
    });
});

describe("upsertPostings", () => {
    it("counts only genuinely new postings", () => {
        const db = store();
        expect(db.upsertPostings([posting({sourceId: "a"})])).toEqual({found: 1, added: 1});
        expect(db.upsertPostings([posting({sourceId: "a"}), posting({sourceId: "b"})])).toEqual({
            found: 2,
            added: 1,
        });
        db.close();
    });

    it("never resets a status the operator has already moved", () => {
        const db = store();
        db.upsertPostings([posting({sourceId: "a"})]);
        drive(db, "a", "applied");

        db.upsertPostings([posting({sourceId: "a", preScore: 55})]);
        const stored = db.getPosting("a");
        expect(stored?.status).toBe("applied");
        expect(stored?.preScore).toBe(55);
        db.close();
    });
});

describe("stats", () => {
    it("aggregates gap frequency across generated postings", () => {
        const db = store();
        db.upsertPostings([
            posting({sourceId: "a"}),
            posting({sourceId: "b"}),
            posting({sourceId: "c"}),
        ]);

        for (const id of ["a", "b", "c"]) db.setStatus(id, "generating");
        db.recordGeneration("a", {outDir: "out/a", matchScore: 70, flags: [], gaps: ["AWS", "Docker"]});
        db.recordGeneration("b", {outDir: "out/b", matchScore: 60, flags: [], gaps: ["AWS", "Kotlin"]});
        db.recordGeneration("c", {outDir: "out/c", matchScore: 50, flags: [], gaps: ["AWS"]});

        const stats = db.stats();
        expect(stats.topGaps[0]).toEqual({gap: "AWS", count: 3});
        expect(stats.byStatus["generated"]).toBe(3);
        expect(stats.total).toBe(3);
        db.close();
    });

    it("counts outcomes once they exist", () => {
        const db = store();
        db.upsertPostings([posting({sourceId: "a"})]);
        drive(db, "a", "applied");
        db.setOutcome("a", "interview");

        expect(db.stats().byOutcome).toEqual({interview: 1});
        db.close();
    });

    it("is empty and harmless on a fresh database", () => {
        const db = store();
        expect(db.stats()).toEqual({byStatus: {}, byOutcome: {}, topGaps: [], total: 0});
        db.close();
    });
});

describe("recordFailure", () => {
    it("stores the message without touching the operator's notes", () => {
        const db = store();
        db.upsertPostings([posting({sourceId: "a"})]);
        db.setNotes("a", "Referred by a friend.");
        db.setStatus("a", "generating");

        const failed = db.recordFailure("a", "Gemini quota exhausted");
        expect(failed.status).toBe("failed");
        expect(failed.lastError).toBe("Gemini quota exhausted");
        expect(failed.notes).toBe("Referred by a friend.");
        db.close();
    });
});

describe("filtering by language", () => {
    /** Phase 3.8 detects the language; the tracker has to be able to ask for it. */
    function seeded(): TrackerStore {
        const db = store();
        db.upsertPostings([
            posting({sourceId: "de-1", title: "Softwareentwickler", language: "de"}),
            posting({sourceId: "en-1", title: "Software Engineer", language: "en"}),
            posting({sourceId: "un-1", title: "Engineer", language: "unknown"}),
            posting({sourceId: "null-1", title: "Legacy row"}),
        ]);
        return db;
    }

    it("returns only the postings written in that language", () => {
        const db = seeded();
        expect(db.listPostings({language: "de"}).map((row) => row.sourceId)).toEqual(["de-1"]);
        expect(db.listPostings({language: "en"}).map((row) => row.sourceId)).toEqual(["en-1"]);
    });

    it("treats undetected as a value you can filter on", () => {
        expect(seeded().listPostings({language: "unknown"}).map((row) => row.sourceId)).toEqual([
            "un-1",
        ]);
    });

    it("returns everything when no language is asked for", () => {
        expect(seeded().listPostings()).toHaveLength(4);
    });

    it("combines with the other filters", () => {
        const db = seeded();
        expect(db.listPostings({language: "de", status: "new"})).toHaveLength(1);
        expect(db.listPostings({language: "de", status: "applied"})).toHaveLength(0);
    });

    it("stores the language it was given", () => {
        expect(seeded().getPosting("de-1")?.language).toBe("de");
        // A row upserted without one predates the column; null, not a guess.
        expect(seeded().getPosting("null-1")?.language).toBeNull();
    });
});

describe("the language backfill", () => {
    const GERMAN =
        "Wir suchen einen Entwickler für unser Team und bieten flexible Arbeitszeiten " +
        "sowie die Möglichkeit, nach Absprache im Homeoffice zu arbeiten. Der Bewerber " +
        "sollte über Erfahrung mit TypeScript verfügen und mit uns die Plattform bauen.";

    /** A file-backed store, so it can be closed and opened again. */
    async function onDisk(): Promise<string> {
        const dir = await mkdtemp(path.join(tmpdir(), "job-tailor-tracker-"));
        return path.join(dir, "tracker.db");
    }

    it("fills in a row that was stored before the column existed", async () => {
        const file = await onDisk();

        const first = openStore(file);
        // No language on the upsert is exactly the pre-3.8 state: the text is
        // there, the answer was never recorded.
        first.upsertPostings([
            posting({sourceId: "old-1", title: "Softwareentwickler (m/w/d)", text: GERMAN}),
        ]);
        expect(first.getPosting("old-1")?.language).toBeNull();
        first.close();

        const reopened = openStore(file);
        expect(reopened.getPosting("old-1")?.language).toBe("de");
        // And it is now reachable by the filter that could not see it before.
        expect(reopened.listPostings({language: "de"})).toHaveLength(1);
        reopened.close();
    });

    it("leaves a row with no stored text alone rather than guessing", async () => {
        const file = await onDisk();

        const first = openStore(file);
        first.upsertPostings([posting({sourceId: "empty-1", text: "   "})]);
        first.close();

        const reopened = openStore(file);
        expect(reopened.getPosting("empty-1")?.language).toBeNull();
        reopened.close();
    });

    it("does not overwrite a language already recorded", async () => {
        const file = await onDisk();

        const first = openStore(file);
        first.upsertPostings([
            posting({sourceId: "kept-1", title: "Engineer", text: GERMAN, language: "en"}),
        ]);
        first.close();

        const reopened = openStore(file);
        expect(reopened.getPosting("kept-1")?.language).toBe("en");
        reopened.close();
    });
});

describe("generation stages", () => {
    it("records the stage and clears it when generation succeeds", () => {
        const db = store();
        db.upsertPostings([posting({sourceId: "a"})]);
        db.setStatus("a", "generating");

        db.setStage("a", "extracting");
        expect(db.getPosting("a")?.stage).toBe("extracting");
        expect(db.getPosting("a")?.stageStartedAt).toBeTruthy();

        db.setStage("a", "tailoring");
        expect(db.getPosting("a")?.stage).toBe("tailoring");

        db.recordGeneration("a", {outDir: "output/a", matchScore: 70, flags: [], gaps: []});
        expect(db.getPosting("a")?.stage).toBeNull();
        expect(db.getPosting("a")?.stageStartedAt).toBeNull();
    });

    it("clears the stage when generation fails too", () => {
        const db = store();
        db.upsertPostings([posting({sourceId: "a"})]);
        db.setStatus("a", "generating");
        db.setStage("a", "rendering");

        db.recordFailure("a", "boom");
        expect(db.getPosting("a")?.status).toBe("failed");
        expect(db.getPosting("a")?.stage).toBeNull();
        expect(db.getPosting("a")?.stageStartedAt).toBeNull();
    });

    it("stamps a fresh start time on each stage", async () => {
        const db = store();
        db.upsertPostings([posting({sourceId: "a"})]);
        db.setStatus("a", "generating");

        db.setStage("a", "extracting");
        const first = db.getPosting("a")?.stageStartedAt;
        await new Promise((resolve) => setTimeout(resolve, 5));

        db.setStage("a", "tailoring");
        // The clock in the UI counts the stage, not the whole job.
        expect(db.getPosting("a")?.stageStartedAt).not.toBe(first);
    });
});

describe("resetInterruptedGenerations", () => {
    it("fails a posting left generating by a process that stopped", () => {
        const db = store();
        db.upsertPostings([posting({sourceId: "a"}), posting({sourceId: "b"})]);
        db.setStatus("a", "generating");
        db.setStage("a", "tailoring");

        expect(db.resetInterruptedGenerations()).toBe(1);

        const stranded = db.getPosting("a");
        expect(stranded?.status).toBe("failed");
        expect(stranded?.lastError).toBe("interrupted by server restart");
        expect(stranded?.stage).toBeNull();
        // Everything else is untouched.
        expect(db.getPosting("b")?.status).toBe("new");
    });

    it("does nothing on a clean database", () => {
        const db = store();
        db.upsertPostings([posting({sourceId: "a"})]);
        expect(db.resetInterruptedGenerations()).toBe(0);
        expect(db.getPosting("a")?.status).toBe("new");
    });
});
