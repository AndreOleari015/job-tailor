import {describe, expect, it} from "vitest";
import {preScore} from "../src/core/match.js";
import type {JobSpec, Profile} from "../src/types.js";

/** A minimal profile: two declared skills and one tagged bullet. */
const profile: Profile = {
    basics: {
        name: "Alex Moreira",
        email: "alex@example.com",
        phone: "",
        github: "",
        linkedin: "",
        location: "Dublin",
    },
    experience: [
        {
            id: "polar",
            role: "Engineer",
            company: "Polar Labs",
            from: "2024-01",
            to: "present",
            bullets: [{id: "b1", text: "Shipped apps.", tags: ["mobile", "ci-cd"]}],
        },
    ],
    projects: [],
    skills: {
        languages: ["TypeScript", "JavaScript"],
        mobile: ["React Native", "Expo"],
    },
    education: [],
    languages: [],
};

const baseJob: JobSpec = {
    company: "Acme",
    role: "Engineer",
    location: "Berlin",
    country: "DE",
    remote: "remote",
    language: "en",
    seniority: "mid",
    required_stack: [],
    nice_to_have: [],
    salary_min_eur: null,
    salary_currency: null,
    visa_sponsorship: "not_mentioned",
    key_responsibilities: [],
    tone: "startup",
};

describe("preScore", () => {
    it("returns 100 when the posting states no requirements", () => {
        const result = preScore(profile, baseJob);
        expect(result.score).toBe(100);
        expect(result.matchedTerms).toEqual([]);
        expect(result.missingTerms).toEqual([]);
    });

    it("scores the share of requirement weight the profile backs", () => {
        // React Native (required, matched) vs Kotlin (required, missing): 2/4.
        const result = preScore(profile, {
            ...baseJob,
            required_stack: ["React Native", "Kotlin"],
        });
        expect(result.score).toBe(50);
        expect(result.matchedTerms).toContain("React Native");
        expect(result.missingTerms).toContain("Kotlin");
    });

    it("weights required at 2 and nice-to-have at 1", () => {
        // Matched required (2) out of required 2 + nice 1 = 3 total. round(200/3)=67.
        const result = preScore(profile, {
            ...baseJob,
            required_stack: ["TypeScript"],
            nice_to_have: ["Rust"],
        });
        expect(result.score).toBe(67);
    });

    it("matches a required term against a bullet tag, not only skills", () => {
        const result = preScore(profile, {...baseJob, required_stack: ["CI/CD"]});
        expect(result.score).toBe(100);
        expect(result.matchedTerms).toContain("CI/CD");
    });

    it("treats spelling aliases as the same term", () => {
        // "rn" and "ts" are alias spellings; the profile has React Native and TypeScript.
        const result = preScore(profile, {...baseJob, required_stack: ["rn", "ts"]});
        expect(result.score).toBe(100);
    });

    it("is case and whitespace insensitive", () => {
        const result = preScore(profile, {...baseJob, required_stack: ["  REACT NATIVE  "]});
        expect(result.score).toBe(100);
    });

    it("does not fuzzy-match: Java is not JavaScript", () => {
        const result = preScore(profile, {...baseJob, required_stack: ["Java"]});
        expect(result.score).toBe(0);
        expect(result.missingTerms).toContain("Java");
    });

    it("counts a term stated twice once", () => {
        const result = preScore(profile, {
            ...baseJob,
            required_stack: ["Rust"],
            nice_to_have: ["Rust"],
        });
        expect(result.score).toBe(0);
        expect(result.missingTerms).toEqual(["Rust"]);
    });
});
