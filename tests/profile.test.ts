import {fileURLToPath} from "node:url";
import {afterEach, describe, expect, it, vi} from "vitest";
import {companyFromHeader, extractJobSpec} from "../src/core/extract.js";
import {applyMinScore, computeFlags, loadProfile, reconcile} from "../src/core/tailor.js";
import type {LlmProvider} from "../src/llm/providers/index.js";
import {
    collectBulletIds,
    flags,
    resolveWorkAuthorisation,
    type JobSpec,
    type TailoredApplication,
} from "../src/types.js";

afterEach(() => {
    vi.restoreAllMocks();
});

// The example, not the real profile: data/profile.yaml holds personal data and is
// gitignored, so the suite must run on a fresh clone. Both share a structure.
const profilePath = fileURLToPath(new URL("../data/profile.example.yaml", import.meta.url));

const jobSpec: JobSpec = {
    company: "Acme GmbH",
    role: "Senior React Native Engineer",
    location: "Berlin, Germany",
    country: null,
    remote: "hybrid",
    language: "en",
    seniority: "senior",
    required_stack: ["React Native"],
    nice_to_have: [],
    salary_min_eur: null,
    visa_sponsorship: "not_mentioned",
    key_responsibilities: [],
    tone: "startup",
};

/** Three paragraphs, under 200 words, no unbacked requirement terms. */
const coverLetter = [
    "Acme is rebuilding its ordering flow.",
    "At Polar Labs I shipped 30+ applications to both stores.",
    "This role is the reason I applied.",
].join("\n\n");

const application: TailoredApplication = {
    selected_bullet_ids: ["pl-volume", "pl-cicd"],
    bullet_order: ["pl-cicd", "pl-volume"],
    cover_letter_bullet_refs: [],
    headline: "Mobile engineer shipping cross-platform products",
    profile_summary: "Builds and publishes React Native apps end to end.",
    cover_letter: coverLetter,
    match_score: 78,
    gaps: [],
    flags: [],
};

describe("data/profile.example.yaml", () => {
    it("parses against the Profile schema", async () => {
        const profile = await loadProfile(profilePath);
        expect(profile.basics.name).toBe("Alex Moreira");
        expect(profile.experience).toHaveLength(3);
        expect(profile.projects).toHaveLength(3);
    });

    it("gives every bullet a unique id", async () => {
        const profile = await loadProfile(profilePath);
        const ids = [
            ...profile.experience.flatMap((entry) => entry.bullets.map((bullet) => bullet.id)),
            ...profile.projects.flatMap((project) => project.bullets.map((bullet) => bullet.id)),
        ];
        expect(new Set(ids).size).toBe(ids.length);
        expect(collectBulletIds(profile).size).toBe(ids.length);
    });

    it("tags every bullet", async () => {
        const profile = await loadProfile(profilePath);
        for (const entry of profile.experience) {
            for (const bullet of entry.bullets) expect(bullet.tags.length).toBeGreaterThan(0);
        }
    });

    it("fails readably on a missing file", async () => {
        await expect(loadProfile("data/does-not-exist.yaml")).rejects.toThrow(
            /Could not read the profile/,
        );
    });
});

describe("computeFlags", () => {
    it("returns no flags for a clean match", () => {
        expect(computeFlags(jobSpec, 78)).toEqual([]);
    });

    it("flags a low score, a refusal to sponsor, a risky language and a low salary", () => {
        const hostile: JobSpec = {
            ...jobSpec,
            language: "de",
            visa_sponsorship: "explicit_no",
            salary_min_eur: 40000,
        };
        expect(computeFlags(hostile, 30)).toEqual([
            flags.lowMatch,
            flags.noSponsorship,
            flags.languageRisk,
            flags.salaryBelowThreshold,
        ]);
    });
});

describe("reconcile", () => {
    it("drops bullet ids that do not exist in the profile", async () => {
        const profile = await loadProfile(profilePath);
        const result = reconcile(
            {
                ...application,
                selected_bullet_ids: ["pl-volume", "pl-invented", "pl-cicd"],
                bullet_order: ["pl-invented", "pl-cicd", "pl-volume"],
            },
            profile,
            jobSpec,
        );

        expect(result.selected_bullet_ids).toEqual(["pl-volume", "pl-cicd"]);
        expect(result.bullet_order).toEqual(["pl-cicd", "pl-volume"]);
        expect(result.flags).toContain(flags.invalidBulletIdsDropped);
    });

    it("appends selected ids the model forgot to order", async () => {
        const profile = await loadProfile(profilePath);
        const result = reconcile(
            {...application, bullet_order: ["pl-cicd"]},
            profile,
            jobSpec,
        );
        expect(result.bullet_order).toEqual(["pl-cicd", "pl-volume"]);
    });

    it("recomputes flags rather than trusting the model", async () => {
        const profile = await loadProfile(profilePath);
        const result = reconcile(
            {...application, match_score: 20, flags: ["TOTALLY_MADE_UP"]},
            profile,
            jobSpec,
        );
        expect(result.flags).toEqual([flags.lowMatch]);
    });
});

/* ------------------------------------------------------------------ */
/* Work authorisation                                                   */
/* ------------------------------------------------------------------ */

const BLUE_CARD =
    "Eligible for the EU Blue Card under section 18g AufenthG as an IT specialist, " +
    "based on 4+ years of professional software experience.";

describe("resolveWorkAuthorisation", () => {
    it("returns the statement for a country that has one", async () => {
        const profile = await loadProfile(profilePath);
        expect(resolveWorkAuthorisation(profile, "DE")).toBe(BLUE_CARD);
    });

    it("returns nothing for a country whose entry is deliberately empty", async () => {
        const profile = await loadProfile(profilePath);
        expect(resolveWorkAuthorisation(profile, "IE")).toBeUndefined();
        expect(resolveWorkAuthorisation(profile, "ES")).toBeUndefined();
    });

    it("returns nothing when the country is unknown or absent", async () => {
        const profile = await loadProfile(profilePath);
        expect(resolveWorkAuthorisation(profile, null)).toBeUndefined();
        expect(resolveWorkAuthorisation(profile, "JP")).toBeUndefined();
    });

    it("is case and whitespace insensitive on the country code", async () => {
        const profile = await loadProfile(profilePath);
        expect(resolveWorkAuthorisation(profile, " de ")).toBe(BLUE_CARD);
    });
});

describe("authorisation claims in the letter", () => {
    /** The exact defect from the first real run: German law, Irish role. */
    const germanClaim =
        "Robotics calibration is unforgiving work. I am eligible for an EU Blue Card " +
        "under section 18g AufenthG as an IT specialist.";

    it("flags a Blue Card claim on an Irish role", async () => {
        const profile = await loadProfile(profilePath);
        const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

        const result = reconcile(
            {...application, cover_letter: germanClaim},
            profile,
            {...jobSpec, country: "IE"},
        );

        expect(result.flags).toContain(flags.unexpectedAuthorisationClaim);
        expect(result.flags).not.toContain(flags.missingAuthorisationClaim);

        // The offending sentence is surfaced, not the whole letter.
        const logged = stderr.mock.calls.map(([chunk]) => String(chunk)).join("");
        expect(logged).toContain("AufenthG");
        expect(logged).not.toContain("Robotics calibration is unforgiving");
    });

    it("does not flag the same letter on a German role", async () => {
        const profile = await loadProfile(profilePath);
        const result = reconcile(
            {...application, cover_letter: `${germanClaim} ${BLUE_CARD}`},
            profile,
            {...jobSpec, country: "DE"},
        );

        expect(result.flags).not.toContain(flags.unexpectedAuthorisationClaim);
        expect(result.flags).not.toContain(flags.missingAuthorisationClaim);
    });

    it("flags a German role whose letter omits the statement", async () => {
        const profile = await loadProfile(profilePath);
        vi.spyOn(process.stderr, "write").mockReturnValue(true);

        const result = reconcile(
            {...application, cover_letter: "A letter with no authorisation line."},
            profile,
            {...jobSpec, country: "DE"},
        );

        expect(result.flags).toContain(flags.missingAuthorisationClaim);
    });

    it("stays silent when the country has no statement and the letter makes no claim", async () => {
        const profile = await loadProfile(profilePath);
        const result = reconcile(
            {...application, cover_letter: "A letter about the role."},
            profile,
            {...jobSpec, country: "IE"},
        );

        expect(result.flags).not.toContain(flags.unexpectedAuthorisationClaim);
        expect(result.flags).not.toContain(flags.missingAuthorisationClaim);
    });

    it("tolerates line wrapping in the expected statement", async () => {
        const profile = await loadProfile(profilePath);
        const wrapped = BLUE_CARD.replace(/ /g, "\n   ");
        const result = reconcile(
            {...application, cover_letter: `Something specific.\n${wrapped}`},
            profile,
            {...jobSpec, country: "DE"},
        );

        expect(result.flags).not.toContain(flags.missingAuthorisationClaim);
    });
});

/* ------------------------------------------------------------------ */
/* Extraction                                                           */
/* ------------------------------------------------------------------ */

/** Returns whatever text it is given, so extraction is exercised without a model. */
function fakeProvider(response: object): LlmProvider {
    return {
        name: "anthropic",
        model: "test",
        supportsNativeJsonSchema: false,
        complete: async () => ({text: JSON.stringify(response)}),
    };
}

describe("companyFromHeader", () => {
    it("reads a Company: line verbatim", () => {
        expect(companyFromHeader("Company: Acme Robotics GmbH\n\nWe are hiring.")).toBe(
            "Acme Robotics GmbH",
        );
    });

    it("finds the line anywhere in the input and is case insensitive", () => {
        expect(companyFromHeader("Full job description\ncompany:  TES Recruitment  \nRole")).toBe(
            "TES Recruitment",
        );
    });

    it("returns nothing when there is no header or it is blank", () => {
        expect(companyFromHeader("We are an industry leader.")).toBeUndefined();
        expect(companyFromHeader("Company:   \nRole: x")).toBeUndefined();
    });

    it("does not run past the end of the line", () => {
        expect(companyFromHeader("Company: Acme\nLocation: Cork")).toBe("Acme");
    });
});

describe("extractJobSpec", () => {
    const modelSpec = {...jobSpec, company: "unknown"};

    it("overrides the model with the Company: header", async () => {
        const result = await extractJobSpec("Company: Acme Robotics GmbH\n\nWe are hiring.", {
            provider: fakeProvider(modelSpec),
        });
        expect(result.company).toBe("Acme Robotics GmbH");
    });

    it("keeps the model's answer when there is no header", async () => {
        const result = await extractJobSpec("About Globex, we are hiring.", {
            provider: fakeProvider({...jobSpec, company: "Globex"}),
        });
        expect(result.company).toBe("Globex");
    });

    it("rejects empty input before calling the model", async () => {
        await expect(extractJobSpec("   ", {provider: fakeProvider(jobSpec)})).rejects.toThrow(
            /job description is empty/,
        );
    });
});

/* ------------------------------------------------------------------ */
/* Letter quality                                                       */
/* ------------------------------------------------------------------ */

/** Wraps a body so only the property under test differs from a good letter. */
function paragraphed(body: string): string {
    return `Acme is rebuilding its ordering flow.\n\n${body}\n\nThis role is the reason I applied.`;
}

describe("UNSUPPORTED_TECH_CLAIM", () => {
    it("fires when the letter names a requirement nothing in the profile backs", async () => {
        const profile = await loadProfile(profilePath);
        const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

        const result = reconcile(
            {...application, cover_letter: paragraphed("I have used MongoDB extensively.")},
            profile,
            {...jobSpec, required_stack: ["MongoDB"]},
        );

        expect(result.flags).toContain(flags.unsupportedTechClaim);
        expect(stderr.mock.calls.map(([c]) => String(c)).join("")).toContain("MongoDB");
    });

    it("fires for a nice_to_have term too — the RevenueCat re-characterisation", async () => {
        const profile = await loadProfile(profilePath);
        vi.spyOn(process.stderr, "write").mockReturnValue(true);

        // The real defect: RevenueCat is in the profile, "payment platforms" is not.
        const result = reconcile(
            {
                ...application,
                selected_bullet_ids: ["pl-cicd"],
                bullet_order: ["pl-cicd"],
                cover_letter: paragraphed("I integrated payment platforms like RevenueCat."),
            },
            profile,
            {...jobSpec, required_stack: [], nice_to_have: ["payment platforms"]},
        );

        expect(result.flags).toContain(flags.unsupportedTechClaim);
    });

    it("does not fire when the technology appears in a selected bullet", async () => {
        const profile = await loadProfile(profilePath);

        // pl-cicd's text names RevenueCat, and it is selected.
        const result = reconcile(
            {
                ...application,
                selected_bullet_ids: ["pl-cicd"],
                bullet_order: ["pl-cicd"],
                cover_letter: paragraphed("I implemented RevenueCat subscription flows."),
            },
            profile,
            {...jobSpec, required_stack: ["RevenueCat"]},
        );

        expect(result.flags).not.toContain(flags.unsupportedTechClaim);
    });

    it("does not fire when the technology is in the skills map", async () => {
        const profile = await loadProfile(profilePath);

        // Firestore is a declared skill but appears in no selected bullet here.
        const result = reconcile(
            {...application, cover_letter: paragraphed("I have worked with Firestore.")},
            profile,
            {...jobSpec, required_stack: ["Firestore"]},
        );

        expect(result.flags).not.toContain(flags.unsupportedTechClaim);
    });

    it("does not fire on a requirement the letter never mentions", async () => {
        const profile = await loadProfile(profilePath);
        const result = reconcile(application, profile, {
            ...jobSpec,
            required_stack: ["MongoDB", "Kubernetes"],
        });
        expect(result.flags).not.toContain(flags.unsupportedTechClaim);
    });

    it("matches whole tokens only, so Java does not match JavaScript", async () => {
        const profile = await loadProfile(profilePath);
        const result = reconcile(
            {...application, cover_letter: paragraphed("I write JavaScript daily.")},
            profile,
            {...jobSpec, required_stack: ["Java"]},
        );
        expect(result.flags).not.toContain(flags.unsupportedTechClaim);
    });
});

describe("COVER_LETTER_TOO_LONG", () => {
    /** A paragraphed letter of exactly `words` words. */
    function letterOf(words: number): string {
        const body = Array.from({length: words - 2}, (_, i) => `word${i}`).join(" ");
        return `Opening.\n\n${body}\n\nClose.`;
    }

    it("does not fire at exactly 200 words", async () => {
        const profile = await loadProfile(profilePath);
        const letter = letterOf(200);
        expect(letter.trim().split(/\s+/)).toHaveLength(200);

        const result = reconcile({...application, cover_letter: letter}, profile, jobSpec);
        expect(result.flags).not.toContain(flags.coverLetterTooLong);
    });

    it("fires at 201 words", async () => {
        const profile = await loadProfile(profilePath);
        vi.spyOn(process.stderr, "write").mockReturnValue(true);
        const letter = letterOf(201);
        expect(letter.trim().split(/\s+/)).toHaveLength(201);

        const result = reconcile({...application, cover_letter: letter}, profile, jobSpec);
        expect(result.flags).toContain(flags.coverLetterTooLong);
    });
});

describe("COVER_LETTER_NOT_PARAGRAPHED", () => {
    it("fires on a single block", async () => {
        const profile = await loadProfile(profilePath);
        const result = reconcile(
            {...application, cover_letter: "One long block with no breaks at all."},
            profile,
            jobSpec,
        );
        expect(result.flags).toContain(flags.coverLetterNotParagraphed);
    });

    it("fires on two paragraphs", async () => {
        const profile = await loadProfile(profilePath);
        const result = reconcile(
            {...application, cover_letter: "Opening.\n\nClose."},
            profile,
            jobSpec,
        );
        expect(result.flags).toContain(flags.coverLetterNotParagraphed);
    });

    it("does not fire on three", async () => {
        const profile = await loadProfile(profilePath);
        const result = reconcile(application, profile, jobSpec);
        expect(result.flags).not.toContain(flags.coverLetterNotParagraphed);
    });

    it("does not count single newlines as paragraph breaks", async () => {
        const profile = await loadProfile(profilePath);
        const result = reconcile(
            {...application, cover_letter: "Opening.\nMiddle.\nClose."},
            profile,
            jobSpec,
        );
        expect(result.flags).toContain(flags.coverLetterNotParagraphed);
    });
});

describe("applyMinScore", () => {
    const letter = "A letter worth reading.";

    it("blanks the letter and flags it below the threshold", () => {
        const result = applyMinScore(
            {...application, match_score: 15, cover_letter: letter},
            {minScore: 40},
        );

        expect(result.cover_letter).toBe("");
        expect(result.flags).toContain(flags.skippedLowMatch);
    });

    it("keeps the gaps, which are the useful output at a low score", () => {
        const gaps = ["No robotics experience", "No CAD/CAM experience"];
        const result = applyMinScore(
            {...application, match_score: 15, cover_letter: letter, gaps},
            {minScore: 40},
        );

        expect(result.gaps).toEqual(gaps);
        expect(result.match_score).toBe(15);
    });

    it("leaves the letter alone at or above the threshold", () => {
        const result = applyMinScore(
            {...application, match_score: 40, cover_letter: letter},
            {minScore: 40},
        );

        expect(result.cover_letter).toBe(letter);
        expect(result.flags).not.toContain(flags.skippedLowMatch);
    });

    it("does not skip when forced", () => {
        const result = applyMinScore(
            {...application, match_score: 15, cover_letter: letter},
            {minScore: 40, force: true},
        );

        expect(result.cover_letter).toBe(letter);
        expect(result.flags).not.toContain(flags.skippedLowMatch);
    });

    it("preserves flags raised earlier by reconcile", () => {
        const result = applyMinScore(
            {...application, match_score: 15, cover_letter: letter, flags: [flags.lowMatch]},
            {minScore: 40},
        );

        expect(result.flags).toEqual([flags.lowMatch, flags.skippedLowMatch]);
    });
});

describe("cover_letter_bullet_refs", () => {
    it("flags refs that were never selected, without dropping them", async () => {
        const profile = await loadProfile(profilePath);
        const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

        // lv-scale is a real profile bullet, but it was not selected — this is
        // exactly the misattribution seen in the first real run.
        const result = reconcile(
            {...application, cover_letter_bullet_refs: ["pl-cicd", "lv-scale"]},
            profile,
            jobSpec,
        );

        expect(result.flags).toContain(flags.coverLetterRefMismatch);
        expect(result.cover_letter_bullet_refs).toEqual(["pl-cicd", "lv-scale"]);

        const logged = stderr.mock.calls.map(([chunk]) => String(chunk)).join("");
        expect(logged).toContain("lv-scale");
    });

    it("flags refs that do not exist in the profile at all", async () => {
        const profile = await loadProfile(profilePath);
        vi.spyOn(process.stderr, "write").mockReturnValue(true);

        const result = reconcile(
            {...application, cover_letter_bullet_refs: ["pl-invented"]},
            profile,
            jobSpec,
        );
        expect(result.flags).toContain(flags.coverLetterRefMismatch);
    });

    it("accepts refs that are a subset of the selected bullets", async () => {
        const profile = await loadProfile(profilePath);
        const result = reconcile(
            {...application, cover_letter_bullet_refs: ["pl-cicd"]},
            profile,
            jobSpec,
        );
        expect(result.flags).not.toContain(flags.coverLetterRefMismatch);
    });
});
