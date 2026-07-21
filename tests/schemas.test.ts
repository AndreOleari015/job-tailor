import {describe, expect, it} from "vitest";
import {
    collectBulletIds,
    jobSpecSchema,
    profileSchema,
    tailoredApplicationSchema,
} from "../src/types.js";

const validJobSpec = {
    company: "Acme GmbH",
    role: "Senior React Native Engineer",
    location: "Berlin, Germany",
    country: "DE",
    remote: "hybrid",
    language: "de",
    seniority: "senior",
    required_stack: ["React Native", "TypeScript"],
    nice_to_have: ["Fastlane"],
    salary_min_eur: 72000,
    visa_sponsorship: "explicit_yes",
    key_responsibilities: ["Ship features to the App Store"],
    tone: "startup",
};

const validApplication = {
    selected_bullet_ids: ["pl-volume", "pl-cicd"],
    bullet_order: ["pl-cicd", "pl-volume"],
    cover_letter_bullet_refs: ["pl-cicd"],
    headline: "Mobile engineer shipping cross-platform products",
    profile_summary: "Builds and publishes React Native apps end to end.",
    cover_letter: "A letter.",
    match_score: 78,
    gaps: ["No professional Kotlin experience"],
    flags: [],
};

const validProfile = {
    basics: {
        name: "Alex Moreira",
        email: "alex.moreira@example.com",
        phone: "+353 1 234 5678",
        github: "github.com/example-user",
        linkedin: "linkedin.com/in/example-user",
        location: "Dublin, Ireland",
        work_authorisation: {DE: "Eligible for the EU Blue Card.", IE: ""},
    },
    experience: [
        {
            id: "polar-labs",
            role: "Software Engineer",
            company: "Polar Labs",
            from: "2024-11",
            to: "2026-07",
            location: "Remote",
            bullets: [{id: "pl-volume", text: "Shipped 30+ apps.", tags: ["mobile"]}],
        },
    ],
    projects: [
        {
            id: "transit-app",
            name: "Transit",
            description: "Transport app.",
            bullets: [{id: "bt-opendata", text: "Integrated open data.", tags: ["open-data"]}],
        },
    ],
    skills: {languages: ["TypeScript"]},
    education: [
        {
            degree: "Technologist in Systems Analysis and Development",
            institution: "Example Federal Institute",
            from: "2022-03",
            to: "2024-12",
        },
    ],
    languages: [{language: "Portuguese", level: "Native"}],
};

describe("jobSpecSchema", () => {
    it("accepts a valid JobSpec", () => {
        expect(jobSpecSchema.parse(validJobSpec)).toMatchObject({company: "Acme GmbH"});
    });

    it("strips unknown keys rather than failing", () => {
        const parsed = jobSpecSchema.parse({...validJobSpec, hallucinated_field: true});
        expect(parsed).not.toHaveProperty("hallucinated_field");
    });

    it("rejects an out-of-range enum value", () => {
        const result = jobSpecSchema.safeParse({...validJobSpec, remote: "sometimes"});
        expect(result.success).toBe(false);
    });

    it("rejects a salary that is a string instead of number|null", () => {
        const result = jobSpecSchema.safeParse({...validJobSpec, salary_min_eur: "72000"});
        expect(result.success).toBe(false);
    });

    it("rejects a missing required field", () => {
        const {tone: _tone, ...withoutTone} = validJobSpec;
        expect(jobSpecSchema.safeParse(withoutTone).success).toBe(false);
    });
});

describe("tailoredApplicationSchema", () => {
    it("accepts a valid TailoredApplication", () => {
        expect(tailoredApplicationSchema.parse(validApplication).match_score).toBe(78);
    });

    it("rejects a match_score above 100", () => {
        const result = tailoredApplicationSchema.safeParse({...validApplication, match_score: 140});
        expect(result.success).toBe(false);
    });

    it("rejects an empty cover letter", () => {
        const result = tailoredApplicationSchema.safeParse({...validApplication, cover_letter: ""});
        expect(result.success).toBe(false);
    });
});

describe("profileSchema", () => {
    it("accepts a valid profile", () => {
        expect(profileSchema.parse(validProfile).basics.name).toBe("Alex Moreira");
    });

    it("rejects the old visa_note string shape with a readable error", () => {
        const {work_authorisation: _dropped, ...basics} = validProfile.basics;
        const legacy = {
            ...validProfile,
            basics: {...basics, visa_note: "Eligible for EU Blue Card under 18g AufenthG."},
        };

        const result = profileSchema.safeParse(legacy);
        expect(result.success).toBe(false);

        const issue = result.error?.issues.find((candidate) =>
            candidate.path.join(".").includes("work_authorisation"),
        );
        expect(issue).toBeDefined();
        expect(issue?.path.join(".")).toBe("basics.work_authorisation");
        expect(issue?.message).toMatch(/expected record|received undefined|invalid/i);
    });

    it("rejects a work_authorisation entry that is not a string", () => {
        const malformed = {
            ...validProfile,
            basics: {...validProfile.basics, work_authorisation: {DE: 42}},
        };
        expect(profileSchema.safeParse(malformed).success).toBe(false);
    });

    it("rejects a bullet without an id", () => {
        const malformed = structuredClone(validProfile);
        malformed.experience[0]!.bullets[0] = {text: "No id.", tags: []} as never;
        expect(profileSchema.safeParse(malformed).success).toBe(false);
    });

    it("collects bullet ids from experience and projects", () => {
        const ids = collectBulletIds(profileSchema.parse(validProfile));
        expect([...ids].sort()).toEqual(["bt-opendata", "pl-volume"]);
    });
});
