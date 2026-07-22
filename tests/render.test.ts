import {mkdtemp, rm, stat} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {afterAll, describe, expect, it} from "vitest";
import {
    RenderBlockedError,
    WATERMARK,
    renderApplication,
    renderDocuments,
    type RenderInput,
} from "../src/core/render.js";
import {loadProfile} from "../src/core/tailor.js";
import {flags, type JobSpec, type Profile, type TailoredApplication} from "../src/types.js";

const profilePath = fileURLToPath(new URL("../data/profile.example.yaml", import.meta.url));
const profile: Profile = await loadProfile(profilePath);

const jobSpec: JobSpec = {
    company: "Meridian",
    role: "Full-Stack Product Engineer",
    location: "Berlin, Germany",
    country: "DE",
    remote: "hybrid",
    language: "en",
    seniority: "mid",
    required_stack: ["React Native", "TypeScript"],
    nice_to_have: [],
    salary_min_eur: 80000,
    salary_currency: "EUR",
    visa_sponsorship: "not_mentioned",
    key_responsibilities: [],
    tone: "startup",
};

/** A clean application selecting two bullets from the Polar Labs entry. */
const clean: TailoredApplication = {
    selected_bullet_ids: ["pl-cicd", "pl-volume"],
    bullet_order: ["pl-cicd", "pl-volume"],
    cover_letter_bullet_refs: ["pl-cicd"],
    headline: "Mobile engineer shipping cross-platform products",
    profile_summary: "Publishes React Native apps end to end.",
    cover_letter: "Meridian is hiring.\n\nAt Polar Labs I shipped to both stores.\n\nThis is why I applied.",
    match_score: 78,
    gaps: [],
    flags: [],
};

function input(application: TailoredApplication, over: Partial<RenderInput> = {}): RenderInput {
    return {
        profile,
        jobSpec,
        application,
        outDir: "/unused",
        now: new Date(Date.UTC(2026, 6, 21)),
        ...over,
    };
}

/** Text of a bullet by id, to assert on its presence or absence in the HTML. */
function bulletText(id: string): string {
    for (const entry of profile.experience) {
        for (const bullet of entry.bullets) if (bullet.id === id) return bullet.text;
    }
    for (const project of profile.projects) {
        for (const bullet of project.bullets) if (bullet.id === id) return bullet.text;
    }
    throw new Error(`no bullet ${id}`);
}

const BLOCKING = [
    flags.unexpectedAuthorisationClaim,
    flags.coverLetterRefMismatch,
    flags.unsupportedTechClaim,
    flags.invalidBulletIdsDropped,
];

describe("refusal", () => {
    for (const flag of BLOCKING) {
        it(`throws RenderBlockedError for ${flag}`, async () => {
            await expect(
                renderApplication(input({...clean, flags: [flag]})),
            ).rejects.toBeInstanceOf(RenderBlockedError);
        });
    }

    it("names the blocking flags in the error", () => {
        try {
            renderDocuments(input({...clean, flags: [flags.unsupportedTechClaim]}));
            expect.unreachable();
        } catch (error) {
            expect(error).toBeInstanceOf(RenderBlockedError);
            expect((error as RenderBlockedError).blockingFlags).toEqual([
                flags.unsupportedTechClaim,
            ]);
        }
    });

    it("does not throw for a clean application", () => {
        expect(() => renderDocuments(input(clean))).not.toThrow();
    });

    it("does not treat MISSING_AUTHORISATION_CLAIM as blocking", () => {
        expect(() =>
            renderDocuments(input({...clean, flags: [flags.missingAuthorisationClaim]})),
        ).not.toThrow();
    });
});

describe("watermark", () => {
    it("stamps both documents when a blocked render is forced", () => {
        const {cv, cover} = renderDocuments(
            input({...clean, flags: [flags.unsupportedTechClaim]}, {force: true}),
        );
        expect(cv).toContain(WATERMARK);
        expect(cover).toContain(WATERMARK);
    });

    it("does not stamp a clean application even when forced", () => {
        const {cv} = renderDocuments(input(clean, {force: true}));
        expect(cv).not.toContain(WATERMARK);
    });
});

describe("CV bullet selection", () => {
    it("renders only selected bullets", () => {
        const {cv} = renderDocuments(input(clean));
        expect(cv).toContain(bulletText("pl-cicd"));
        expect(cv).toContain(bulletText("pl-volume"));
        // pl-tooling is in the same entry but was not selected.
        expect(cv).not.toContain(bulletText("pl-tooling"));
    });

    it("orders bullets within an entry by bullet_order", () => {
        const {cv} = renderDocuments(input(clean));
        // bullet_order is [pl-cicd, pl-volume], so pl-cicd's text comes first.
        expect(cv.indexOf(bulletText("pl-cicd"))).toBeLessThan(cv.indexOf(bulletText("pl-volume")));
    });

    it("reflects a reversed bullet_order", () => {
        const reversed = {
            ...clean,
            bullet_order: ["pl-volume", "pl-cicd"],
        };
        const {cv} = renderDocuments(input(reversed));
        expect(cv.indexOf(bulletText("pl-volume"))).toBeLessThan(cv.indexOf(bulletText("pl-cicd")));
    });

    it("omits an entry with no selected bullets, heading and body", () => {
        const {cv} = renderDocuments(input(clean));
        // Only Polar Labs bullets were selected; the freelance entry is gone.
        expect(cv).not.toContain("Freelance");
        expect(cv).not.toContain(bulletText("fl-e2e"));
        // And the Kestrel entry.
        expect(cv).not.toContain("Kestrel Software");
    });

    it("puts the entry holding the earliest-ordered bullet first", () => {
        // Order a project bullet ahead of an experience bullet.
        const projectFirst = {
            ...clean,
            selected_bullet_ids: ["bt-opendata", "pl-cicd"],
            bullet_order: ["bt-opendata", "pl-cicd"],
        };
        const {cv} = renderDocuments(input(projectFirst));
        expect(cv.indexOf(bulletText("bt-opendata"))).toBeLessThan(
            cv.indexOf(bulletText("pl-cicd")),
        );
    });
});

describe("skipped low match", () => {
    it("renders the CV but no cover letter", () => {
        const skipped: TailoredApplication = {
            ...clean,
            cover_letter: "",
            flags: [flags.skippedLowMatch],
        };
        const {cv, cover} = renderDocuments(input(skipped));
        expect(cv).toContain(profile.basics.name.toUpperCase());
        expect(cover).toBeNull();
    });
});

describe("cover letter", () => {
    it("renders one paragraph per blank-line-separated block", () => {
        const {cover} = renderDocuments(input(clean));
        const paragraphs = cover?.match(/<p>/g) ?? [];
        // The three body paragraphs; the salutation uses <p class="salutation">.
        expect(paragraphs).toHaveLength(3);
    });

    it("prints a recipient block for a named company", () => {
        const {cover} = renderDocuments(input(clean));
        expect(cover).toContain("Meridian");
    });

    it("omits the recipient block when the company is unknown", () => {
        const {cover} = renderDocuments(
            input(clean, {jobSpec: {...jobSpec, company: "unknown"}}),
        );
        expect(cover).not.toContain('class="recipient"');
        expect(cover?.toLowerCase()).not.toContain(">unknown<");
    });

    it("formats the date en-IE from the injected clock", () => {
        const {cover} = renderDocuments(input(clean));
        expect(cover).toContain("21 July 2026");
    });

    it("does not invent a recipient name in the salutation", () => {
        const {cover} = renderDocuments(input(clean));
        expect(cover).toContain("Dear Hiring Team,");
    });
});

/*
 * The one test that drives a real browser. Skipped when JOB_TAILOR_SKIP_PDF=1,
 * which is set in CI so the suite needs no Chromium. It asserts only that a
 * non-trivial file lands on disk: PDF bytes are not stable across Chromium
 * versions, so asserting on them would fail for no real reason.
 */
const skipPdf = process.env.JOB_TAILOR_SKIP_PDF === "1";
const scratch: string[] = [];

afterAll(async () => {
    await Promise.all(scratch.map((dir) => rm(dir, {recursive: true, force: true})));
});

describe.skipIf(skipPdf)("PDF integration", () => {
    it("writes a CV PDF over 1KB", async () => {
        const outDir = await mkdtemp(path.join(tmpdir(), "job-tailor-render-"));
        scratch.push(outDir);

        const result = await renderApplication(input(clean, {outDir}));
        const info = await stat(result.cvPath);
        expect(info.size).toBeGreaterThan(1024);
        expect(result.coverPath).not.toBeNull();
    }, 60_000);
});
