import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import {loadProfile} from "../src/core/tailor.js";
import {matchesTerm, textMatchesTerm, tokenise} from "../src/core/terms.js";
import {matchesKeywords} from "../src/sources/filter.js";
import {BODY_ONLY_SCORE_CAP, lightweightSpec, scorePosting} from "../src/sources/index.js";
import type {RawPosting} from "../src/sources/types.js";

const profile = await loadProfile(
    fileURLToPath(new URL("../data/profile.example.yaml", import.meta.url)),
);

function posting(title: string, body: string): RawPosting {
    return {
        sourceId: "greenhouse:m:1",
        source: "greenhouse",
        company: "Meridian",
        title,
        location: "Berlin, Germany",
        url: "https://example.invalid",
        postedAt: null,
        text: `Company: Meridian\nLocation: Berlin, Germany\n\n${body}\n`,
        language: "en",
        fetchedAt: new Date().toISOString(),
    };
}

/* ------------------------------------------------------------------ */
/* Tokenisation                                                         */
/* ------------------------------------------------------------------ */

describe("tokenise", () => {
    it("splits on anything that is not a letter or a digit", () => {
        expect(tokenise("React Native, TypeScript!")).toEqual(["react", "native", "typescript"]);
    });

    it("keeps the symbol-bearing technology names apart", () => {
        expect(tokenise("C# and C++ and F#")).toEqual(["csharp", "and", "cplusplus", "and", "fsharp"]);
        // Without the table these would all collapse to "c" and match each other.
        expect(tokenise("C#")).not.toEqual(tokenise("C++"));
    });

    it("finds .NET inside ASP.NET", () => {
        expect(tokenise("ASP.NET Core")).toEqual(["asp", "dotnet", "core"]);
    });

    it("keeps German letters whole, which \\b would not", () => {
        expect(tokenise("Softwareentwickler für Prüfsysteme")).toEqual([
            "softwareentwickler",
            "für",
            "prüfsysteme",
        ]);
    });
});

/* ------------------------------------------------------------------ */
/* Defect 15: whole-token keyword matching                              */
/* ------------------------------------------------------------------ */

describe("matchesTerm", () => {
    it("does not find a keyword inside a longer word", () => {
        // The defect verbatim: "Senior CRM Strategy Manager, Reactivation" was
        // top of a search for React Native work.
        for (const text of ["Reactivation", "proactive", "reactive", "Reactivation Manager"]) {
            expect(textMatchesTerm(text, "react")).toBe(false);
        }
    });

    it("finds it as a whole word, however the title punctuates it", () => {
        expect(textMatchesTerm("React Native Developer", "react")).toBe(true);
        expect(textMatchesTerm("react-native engineer", "react")).toBe(true);
        expect(textMatchesTerm("Senior Engineer (React)", "react")).toBe(true);
        expect(textMatchesTerm("REACT NATIVE", "react")).toBe(true);
    });

    it("matches a punctuated technology written either way", () => {
        for (const text of ["We use Node.js in production", "a nodejs service", "Node services"]) {
            expect(textMatchesTerm(text, "node.js")).toBe(true);
        }
        expect(textMatchesTerm("CI/CD pipelines", "ci/cd")).toBe(true);
        expect(textMatchesTerm("cicd pipelines", "ci/cd")).toBe(true);
        expect(textMatchesTerm("Strong C# background", "c#")).toBe(true);
        expect(textMatchesTerm("ASP.NET Core", ".net")).toBe(true);
    });

    it("does not match C++ against a search for C#", () => {
        expect(textMatchesTerm("We write C++ all day", "c#")).toBe(false);
    });

    it("keeps the order-independent multi-word semantic from phase 3.8", () => {
        expect(textMatchesTerm("Entwickler für mobile Systeme", "mobile entwickler")).toBe(true);
        expect(textMatchesTerm("Senior Mobile & App-Entwickler (m/w/d)", "mobile entwickler")).toBe(
            true,
        );
        expect(textMatchesTerm("Entwickler für Prüfsysteme", "mobile entwickler")).toBe(false);
    });

    it("still honours the spelling aliases", () => {
        expect(textMatchesTerm("We use TS everywhere", "typescript")).toBe(true);
        expect(textMatchesTerm("React-Native shop", "react native")).toBe(true);
    });

    it("takes a prepared token set, so a haystack is tokenised once", () => {
        const tokens = new Set(tokenise("React Native and TypeScript"));
        expect(matchesTerm(tokens, "react")).toBe(true);
        expect(matchesTerm(tokens, "vue")).toBe(false);
    });
});

describe("matchesKeywords", () => {
    const crm = posting("Senior CRM Strategy Manager, Reactivation", "Own the reactivation funnel.");

    it("rejects the posting that started this phase", () => {
        expect(matchesKeywords(crm, ["react", "native", "typescript"])).toBe(false);
    });

    it("keeps a posting that names the keyword as a word", () => {
        const real = posting("Senior React Native Engineer", "You will ship mobile features.");
        expect(matchesKeywords(real, ["react", "native", "typescript"])).toBe(true);
    });

    it("matches on the body as well as the title", () => {
        const body = posting("Senior Mobile Engineer", "Our stack is React Native and Expo.");
        expect(matchesKeywords(body, ["react"])).toBe(true);
    });

    it("treats no keywords as no filter", () => {
        expect(matchesKeywords(crm, [])).toBe(true);
    });
});

/* ------------------------------------------------------------------ */
/* Defect 16: the title carries the weight                              */
/* ------------------------------------------------------------------ */

describe("lightweightSpec", () => {
    it("puts title technologies in required and body-only ones in nice-to-have", () => {
        const spec = lightweightSpec(
            posting("React Native Engineer", "You will also touch our Python services."),
        );
        expect(spec.required_stack).toContain("react native");
        expect(spec.nice_to_have).toContain("python");
        expect(spec.required_stack).not.toContain("python");
    });

    it("never lists a term in both", () => {
        const spec = lightweightSpec(posting("TypeScript Engineer", "TypeScript everywhere."));
        expect(spec.nice_to_have).not.toContain("typescript");
    });
});

describe("scorePosting", () => {
    it("caps a posting whose title names no technology", () => {
        // An Account Executive role that mentions TypeScript once in a
        // paragraph about the engineering culture.
        const sales = posting(
            "Account Executive, DACH",
            "You will sell to engineering teams who use TypeScript and React Native daily.",
        );
        const score = scorePosting(profile, sales);

        expect(score).not.toBeNull();
        expect(score).toBeLessThanOrEqual(BODY_ONLY_SCORE_CAP);
    });

    it("scores a title match above the same terms in the body alone", () => {
        const inTitle = scorePosting(profile, posting("React Native Engineer", "Ship features."));
        const inBody = scorePosting(
            profile,
            posting("Engineer", "You will use React Native to ship features."),
        );

        expect(inTitle).not.toBeNull();
        expect(inBody).not.toBeNull();
        expect(inTitle as number).toBeGreaterThan(inBody as number);
    });

    it("returns null when the posting names no known technology at all", () => {
        expect(scorePosting(profile, posting("Warehouse Associate", "Lifting boxes."))).toBeNull();
    });

    it("does not cap a posting whose title carries the stack", () => {
        const score = scorePosting(
            profile,
            posting("Senior React Native Engineer", "React Native, TypeScript, Expo."),
        );
        expect(score).toBeGreaterThan(BODY_ONLY_SCORE_CAP);
    });
});
