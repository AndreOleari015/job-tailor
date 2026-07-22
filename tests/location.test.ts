import {fileURLToPath} from "node:url";
import {describe, expect, it, vi} from "vitest";
import {loadProfile} from "../src/core/tailor.js";
import {PostingCache} from "../src/sources/cache.js";
import {searchAll} from "../src/sources/index.js";
import {detectLanguage, detectLanguageWithEvidence} from "../src/sources/language.js";
import {
    countryLabel,
    isAmbiguousFor,
    isKnownCountry,
    isRemote,
    isRemoteIn,
    matchesCountry,
    matchesLocation,
    resolveCountry,
} from "../src/sources/location.js";
import type {PostingLanguage} from "../src/sources/language.js";
import type {JobSource, RawPosting, SourceQuery} from "../src/sources/types.js";

const profile = await loadProfile(
    fileURLToPath(new URL("../data/profile.example.yaml", import.meta.url)),
);

/* ------------------------------------------------------------------ */
/* matchesCountry                                                       */
/* ------------------------------------------------------------------ */

describe("matchesCountry", () => {
    it("matches the country by name", () => {
        expect(matchesCountry("Munich, Germany", "DE")).toBe(true);
        expect(matchesCountry("Lisbon, Portugal", "PT")).toBe(true);
    });

    it("matches a city on its own, which is how boards write it", () => {
        expect(matchesCountry("München", "DE")).toBe(true);
        expect(matchesCountry("Berlin", "DE")).toBe(true);
        expect(matchesCountry("Dublin", "IE")).toBe(true);
    });

    it("ignores diacritics in either direction", () => {
        expect(matchesCountry("Munchen", "DE")).toBe(true);
        expect(matchesCountry("Köln", "DE")).toBe(true);
        expect(matchesCountry("Malaga", "ES")).toBe(true);
    });

    it("is case insensitive", () => {
        expect(matchesCountry("BERLIN, GERMANY", "DE")).toBe(true);
        expect(matchesCountry("Munich, Germany", "de")).toBe(true);
    });

    it("does not match a different country", () => {
        expect(matchesCountry("Dublin, Ireland", "DE")).toBe(false);
        expect(matchesCountry("Germany", "IE")).toBe(false);
        expect(matchesCountry("Warsaw, Poland", "DE")).toBe(false);
        expect(matchesCountry("San Francisco, CA", "DE")).toBe(false);
    });

    it("never matches an absent location", () => {
        expect(matchesCountry(null, "DE")).toBe(false);
        expect(matchesCountry("", "DE")).toBe(false);
        expect(matchesCountry("   ", "DE")).toBe(false);
    });

    it("matches whole tokens only", () => {
        // "uk" must not be found inside "Ukraine".
        expect(matchesCountry("Kyiv, Ukraine", "GB")).toBe(false);
    });

    it("keeps Northern Ireland out of Ireland", () => {
        expect(matchesCountry("Belfast, Northern Ireland", "IE")).toBe(false);
        expect(matchesCountry("Belfast, Northern Ireland", "GB")).toBe(true);
    });

    it("returns false for a country it does not know", () => {
        expect(matchesCountry("Tokyo, Japan", "JP")).toBe(false);
        expect(isKnownCountry("JP")).toBe(false);
        expect(isKnownCountry("de")).toBe(true);
    });

    it("labels a country for the filter line", () => {
        expect(countryLabel("de")).toBe("Germany");
        expect(countryLabel("jp")).toBe("JP");
    });
});

describe("matchesLocation", () => {
    it("is a substring match, unchanged", () => {
        expect(matchesLocation("Berlin, Germany", "berl")).toBe(true);
        expect(matchesLocation("Berlin, Germany", "munich")).toBe(false);
    });

    it("treats an empty needle as no filter", () => {
        expect(matchesLocation(null, "")).toBe(true);
    });
});

/* ------------------------------------------------------------------ */
/* isRemote                                                             */
/* ------------------------------------------------------------------ */

describe("isRemote", () => {
    it("recognises the words postings actually use", () => {
        expect(isRemote("Remote Europe")).toBe(true);
        expect(isRemote("Remote")).toBe(true);
        expect(isRemote("Anywhere")).toBe(true);
        expect(isRemote("Distributed team")).toBe(true);
        expect(isRemote("UK - Remote")).toBe(true);
    });

    it("is false for a place", () => {
        expect(isRemote("Berlin, Germany")).toBe(false);
        expect(isRemote(null)).toBe(false);
    });
});

describe("isRemoteIn", () => {
    it("keeps a remote role open to a region containing the country", () => {
        expect(isRemoteIn("Remote Europe", "DE")).toBe(true);
        expect(isRemoteIn("EMEA Remote", "DE")).toBe(true);
        expect(isRemoteIn("Remote (EU)", "PT")).toBe(true);
        expect(isRemoteIn("Remote - Anywhere", "DE")).toBe(true);
    });

    it("rejects a remote role scoped to somewhere else", () => {
        expect(isRemoteIn("US Remote", "DE")).toBe(false);
        expect(isRemoteIn("Remote — United States", "DE")).toBe(false);
        expect(isRemoteIn("Remote, Dublin", "DE")).toBe(false);
    });

    it("keeps a remote role that names the country itself", () => {
        expect(isRemoteIn("Remote, Germany", "DE")).toBe(true);
        expect(isRemoteIn("Berlin (Remote)", "DE")).toBe(true);
    });

    it("is false for a posting that is not remote at all", () => {
        expect(isRemoteIn("Berlin, Germany", "DE")).toBe(false);
    });

    it("does not put the UK inside an EU-only remote scope", () => {
        // Brexit is a work-authorisation fact, not a pedantic one.
        expect(isRemoteIn("Remote (EU)", "GB")).toBe(false);
        expect(isRemoteIn("Remote Europe", "GB")).toBe(true);
    });
});

/* ------------------------------------------------------------------ */
/* searchAll                                                            */
/* ------------------------------------------------------------------ */

function fakeSource(name: string, kind: "board" | "aggregator", postings: RawPosting[]): JobSource {
    return {
        name,
        kind,
        requiresCredentials: false,
        search: async () => postings,
    };
}

function posting(
    sourceId: string,
    title: string,
    location: string | null,
    language: PostingLanguage = "en",
): RawPosting {
    return {
        sourceId,
        source: sourceId.split(":")[0] ?? "greenhouse",
        company: "Meridian",
        title,
        location,
        url: "https://example.invalid",
        postedAt: null,
        text: `Company: Meridian\n\nReact Native and TypeScript.\n`,
        language,
        fetchedAt: new Date().toISOString(),
    };
}

async function runSearch(sources: JobSource[], query: SourceQuery) {
    const cache = await PostingCache.open("/dev/null");
    vi.spyOn(cache, "save").mockResolvedValue();
    return searchAll({query, profile, cache, sourcesOverride: sources});
}

describe("searchAll --country", () => {
    const board = fakeSource("greenhouse", "board", [
        posting("greenhouse:m:1", "Engineer Lisbon", "Lisbon, Portugal"),
        posting("greenhouse:m:2", "Engineer Dublin", "Dublin, Ireland"),
        posting("greenhouse:m:3", "Engineer Munich", "Munich, Germany"),
    ]);

    it("filters board postings on the posting's own location", async () => {
        const result = await runSearch([board], {keywords: [], country: "de"});

        expect(result.postings).toHaveLength(1);
        expect(result.postings[0]?.title).toBe("Engineer Munich");
    });

    it("reports what the filter did, so an empty result is explicable", async () => {
        const result = await runSearch([board], {keywords: [], country: "de"});
        expect(result.filter).toEqual({
            country: "DE",
            label: "Germany",
            matched: 1,
            total: 3,
            ambiguous: 0,
        });

        const none = await runSearch([board], {keywords: [], country: "se"});
        expect(none.postings).toHaveLength(0);
        expect(none.filter?.matched).toBe(0);
        expect(none.filter?.total).toBe(3);
    });

    it("drops a posting with no location rather than guessing", async () => {
        const result = await runSearch(
            [fakeSource("ashby", "board", [posting("ashby:m:1", "Engineer", null)])],
            {keywords: [], country: "de"},
        );
        expect(result.postings).toHaveLength(0);
    });

    it("does not filter when no country is given", async () => {
        const result = await runSearch([board], {keywords: []});
        expect(result.postings).toHaveLength(3);
        expect(result.filter).toBeUndefined();
    });

    it("warns instead of silently returning nothing for an unknown country", async () => {
        const result = await runSearch([board], {keywords: [], country: "JP"});

        expect(result.postings).toHaveLength(3);
        expect(result.warnings.join(" ")).toContain("JP is not in the location vocabulary");
        expect(result.filter).toBeUndefined();
    });
});

describe("searchAll --remote", () => {
    const board = fakeSource("greenhouse", "board", [
        posting("greenhouse:m:1", "Engineer Europe", "Remote Europe"),
        posting("greenhouse:m:2", "Engineer US", "US Remote"),
        posting("greenhouse:m:3", "Engineer Munich", "Munich, Germany"),
    ]);

    it("with a country, keeps the region-wide remote role and rejects the US one", async () => {
        const result = await runSearch([board], {keywords: [], country: "de", remote: true});
        const titles = result.postings.map((one) => one.title).sort();

        expect(titles).toEqual(["Engineer Europe", "Engineer Munich"]);
    });

    it("without a country, keeps anything remote", async () => {
        const result = await runSearch([board], {keywords: [], remote: true});
        const titles = result.postings.map((one) => one.title).sort();

        expect(titles).toEqual(["Engineer Europe", "Engineer US"]);
    });

    it("without --remote, a country filter excludes an unlocated remote role", async () => {
        const result = await runSearch([board], {keywords: [], country: "de"});
        expect(result.postings.map((one) => one.title)).toEqual(["Engineer Munich"]);
    });
});

describe("searchAll and the aggregators", () => {
    it("country-filters an aggregator client-side, like every other source", async () => {
        // The defect this replaced: the Bundesagentur's index carries Austrian
        // listings, so trusting its server-side filter returned a German search
        // that was almost entirely Vienna and Graz.
        const aggregator = fakeSource("arbeitsagentur", "aggregator", [
            posting("arbeitsagentur:1", "Entwickler Wien", "Wien,Landstraße, Wien"),
            posting("arbeitsagentur:2", "Entwickler Graz", "Graz, Steiermark"),
            posting("arbeitsagentur:3", "Entwickler Köln", "Köln, Nordrhein-Westfalen"),
        ]);

        const result = await runSearch([aggregator], {keywords: [], country: "de"});
        expect(result.postings.map((one) => one.title)).toEqual(["Entwickler Köln"]);
    });

    it("drops an aggregator posting with no usable location", async () => {
        // The cost of the rule, stated: a server-side match we cannot confirm
        // is not a match. Server-side filtering is a bandwidth optimisation.
        const aggregator = fakeSource("adzuna", "aggregator", [
            posting("adzuna:1", "Engineer", "Home Office"),
            posting("adzuna:2", "Engineer Two", null),
        ]);

        const result = await runSearch([aggregator], {keywords: [], country: "de"});
        expect(result.postings).toHaveLength(0);
    });

    it("filters boards and aggregators in one pass", async () => {
        const aggregator = fakeSource("arbeitsagentur", "aggregator", [
            posting("arbeitsagentur:1", "Aggregated Berlin", "Berlin, Berlin"),
        ]);
        const board = fakeSource("greenhouse", "board", [
            posting("greenhouse:m:1", "Board Lisbon", "Lisbon, Portugal"),
        ]);

        const result = await runSearch([aggregator, board], {keywords: [], country: "de"});
        expect(result.postings.map((one) => one.title)).toEqual(["Aggregated Berlin"]);
        expect(result.filter).toEqual({
            country: "DE",
            label: "Germany",
            matched: 1,
            total: 2,
            ambiguous: 0,
        });
    });
});

/* ------------------------------------------------------------------ */
/* Defect 12: Austria and Switzerland                                   */
/* ------------------------------------------------------------------ */

describe("the DACH countries", () => {
    it("keeps Austrian postings out of a German search", () => {
        // The defect verbatim: `search softwareentwickler --country de` was
        // returning Vienna, Linz, Graz, Innsbruck and Salzburg.
        expect(matchesCountry("Wien, Landstraße, Wien", "DE")).toBe(false);
        expect(matchesCountry("Wien, Landstraße, Wien", "AT")).toBe(true);

        for (const location of ["Linz, Oberösterreich", "Graz", "Innsbruck", "Salzburg"]) {
            expect(matchesCountry(location, "DE")).toBe(false);
            expect(matchesCountry(location, "AT")).toBe(true);
        }
    });

    it("keeps Swiss postings out of a German search", () => {
        expect(matchesCountry("Zürich", "DE")).toBe(false);
        expect(matchesCountry("Zürich", "CH")).toBe(true);
        expect(matchesCountry("Zurich", "CH")).toBe(true);
        expect(matchesCountry("Genf", "CH")).toBe(true);
        expect(matchesCountry("Basel, Schweiz", "DE")).toBe(false);
    });

    it("still matches German locations, and only Germany", () => {
        expect(resolveCountry("Berlin, Germany").countries).toEqual(["DE"]);
        expect(matchesCountry("Berlin, Germany", "AT")).toBe(false);
        expect(matchesCountry("Berlin, Germany", "CH")).toBe(false);
    });

    it("does not let 'österreich' leak out of 'Niederösterreich'", () => {
        // Whole-token matching: the sub-national name is Austrian either way,
        // but the name/city distinction drives the tie-break.
        expect(resolveCountry("Mannswörth, Niederösterreich").countries).toEqual(["AT"]);
    });
});

describe("multi-location postings", () => {
    it("matches every country a location names", () => {
        // The rule that replaced withholding these: a posting open in two
        // countries is in both, and it is not ambiguous about it.
        const location = "Berlin, Germany; Dublin, Ireland";
        expect(resolveCountry(location).countries.sort()).toEqual(["DE", "IE"]);
        expect(matchesCountry(location, "DE")).toBe(true);
        expect(matchesCountry(location, "IE")).toBe(true);
        expect(isAmbiguousFor(location, "DE")).toBe(false);
    });

    it("matches a three-country listing, remote scope included", () => {
        const location = "Berlin, Germany; Dublin, Ireland; EMEA, Remote; London, England";
        for (const code of ["DE", "IE", "GB"]) {
            expect(matchesCountry(location, code)).toBe(true);
        }
    });

    it("treats a list of cities as a list, not a tie", () => {
        expect(resolveCountry("Berlin | Wien | Zürich").countries.sort()).toEqual([
            "AT",
            "CH",
            "DE",
        ]);
        expect(matchesCountry("Berlin | Wien | Zürich", "DE")).toBe(true);
    });

    it("returns a multi-location posting to a country search", async () => {
        const board = fakeSource("greenhouse", "board", [
            posting("greenhouse:m:1", "Engineer Munich", "Munich, Germany"),
            posting("greenhouse:m:2", "Engineer Multi", "Cologne, Germany; London, England"),
            posting("greenhouse:m:3", "Engineer Lisbon", "Lisbon, Portugal"),
        ]);

        const result = await runSearch([board], {keywords: [], country: "de"});
        expect(result.postings.map((one) => one.title).sort()).toEqual([
            "Engineer Multi",
            "Engineer Munich",
        ]);
        expect(result.filter?.ambiguous).toBe(0);
    });
});

describe("genuinely ambiguous place names", () => {
    it("withholds a name that belongs to two countries", () => {
        // Freiburg im Breisgau is German; Freiburg/Fribourg is Swiss. On its
        // own the word does not say which.
        expect(resolveCountry("Freiburg").countries).toEqual([]);
        expect(resolveCountry("Freiburg").withheld.sort()).toEqual(["CH", "DE"]);

        expect(matchesCountry("Freiburg", "DE")).toBe(false);
        expect(matchesCountry("Freiburg", "CH")).toBe(false);
        expect(isAmbiguousFor("Freiburg", "DE")).toBe(true);
        expect(isAmbiguousFor("Freiburg", "CH")).toBe(true);
    });

    it("is settled by anything else in the string that names a country", () => {
        expect(resolveCountry("Freiburg im Breisgau, Baden-Württemberg").countries).toEqual([
            "DE",
        ]);
        expect(resolveCountry("Freiburg, Schweiz").countries).toEqual(["CH"]);
        expect(isAmbiguousFor("Freiburg im Breisgau, Baden-Württemberg", "CH")).toBe(false);
    });

    it("is not ambiguous for a country the location never names", () => {
        expect(isAmbiguousFor("Freiburg", "PT")).toBe(false);
        expect(isAmbiguousFor("Berlin", "DE")).toBe(false);
    });

    it("counts a withheld posting instead of dropping it silently", async () => {
        const board = fakeSource("greenhouse", "board", [
            posting("greenhouse:m:1", "Engineer Munich", "Munich, Germany"),
            posting("greenhouse:m:2", "Engineer Freiburg", "Freiburg"),
        ]);

        const result = await runSearch([board], {keywords: [], country: "de"});
        expect(result.postings.map((one) => one.title)).toEqual(["Engineer Munich"]);
        expect(result.filter?.ambiguous).toBe(1);
    });
});

/* ------------------------------------------------------------------ */
/* Defect 13: posting language                                          */
/* ------------------------------------------------------------------ */

const GERMAN_POSTING = `
Wir suchen einen Softwareentwickler für unser Team in Berlin. Die Stelle ist
unbefristet und wird nach Tarif vergütet. Sie werden mit modernen Technologien
arbeiten und sind für die Entwicklung neuer Funktionen verantwortlich. Der
Bewerber sollte über Erfahrung mit TypeScript und React verfügen sowie
Kenntnisse in der Backend-Entwicklung mitbringen. Wir bieten flexible
Arbeitszeiten und die Möglichkeit, nach Absprache im Homeoffice zu arbeiten.
Bei uns finden Sie ein Team, das durch offene Kommunikation überzeugt.
`;

const ENGLISH_POSTING = `
We are looking for a software engineer to join the platform team. You will be
responsible for the design and delivery of new features, and you will work with
product managers and designers throughout. The role is permanent and can be
done from the office or remotely after the first month. The ideal candidate
should have experience with TypeScript and React, as well as an understanding
of backend services. We offer flexible hours and a generous learning budget.
`;

describe("detectLanguage", () => {
    it("recognises a German posting", () => {
        expect(detectLanguage(GERMAN_POSTING)).toBe("de");
    });

    it("recognises an English posting", () => {
        expect(detectLanguage(ENGLISH_POSTING)).toBe("en");
    });

    it("returns unknown for a stub with too little prose", () => {
        const stub = "Senior Engineer. Cloud, Kubernetes, Docker. Apply now.";
        expect(detectLanguage(stub)).toBe("unknown");
    });

    it("returns unknown when the two counts are within 20%", () => {
        const mixed = `${GERMAN_POSTING.slice(0, 300)}\n${ENGLISH_POSTING.slice(0, 300)}`;
        const evidence = detectLanguageWithEvidence(mixed);
        const margin =
            Math.abs(evidence.german - evidence.english) /
            Math.max(evidence.german, evidence.english);

        if (margin < 0.2) expect(evidence.language).toBe("unknown");
        else expect(evidence.language).not.toBe("unknown");
    });

    it("does not let (m/w/d) alone force German", () => {
        // German employers put the gender marker on English postings too. It is
        // weighted, never decisive.
        expect(detectLanguage(ENGLISH_POSTING, "Senior Engineer (m/w/d)")).toBe("en");
        expect(detectLanguage(ENGLISH_POSTING, "Senior Engineer (w/m/d)")).toBe("en");
    });

    it("does weigh (m/w/d) when the counts are otherwise close", () => {
        const plain = detectLanguageWithEvidence("Wir bauen software with the team");
        const marked = detectLanguageWithEvidence("Wir bauen software with the team", "(m/w/d)");
        expect(marked.german).toBe(plain.german + 3);
    });

    it("counts umlauted function words, which a \\b regex would miss", () => {
        const evidence = detectLanguageWithEvidence(
            "über für über für über für über für über",
        );
        expect(evidence.german).toBe(9);
    });
});

describe("searchAll --language", () => {
    const board = fakeSource("greenhouse", "board", [
        posting("greenhouse:m:1", "Entwickler Berlin", "Berlin, Germany", "de"),
        posting("greenhouse:m:2", "Engineer Berlin", "Berlin, Germany", "en"),
        posting("greenhouse:m:3", "Engineer Munich", "Munich, Germany", "unknown"),
    ]);

    it("keeps only English postings for --english", async () => {
        const result = await runSearch([board], {
            keywords: [],
            country: "de",
            languages: ["en"],
        });
        expect(result.postings.map((one) => one.title)).toEqual(["Engineer Berlin"]);
    });

    it("accepts several languages at once", async () => {
        const result = await runSearch([board], {keywords: [], languages: ["de", "unknown"]});
        expect(result.postings.map((one) => one.title).sort()).toEqual([
            "Engineer Munich",
            "Entwickler Berlin",
        ]);
    });

    it("reports the language breakdown of what it returned", async () => {
        const result = await runSearch([board], {keywords: []});
        expect(result.languages).toEqual({de: 1, en: 1, unknown: 1});
    });
});

describe("the German states", () => {
    it("matches a town by its Bundesland, which is how the feed writes it", () => {
        // Live data: the Bundesagentur returns "Ort, Bundesland", and small
        // towns are not in any city list. Without the states these were dropped
        // from a German search — the mirror image of the Austrian leak.
        const towns = [
            "Burgwedel, Niedersachsen",
            "Heilbronn, Neckar, Baden-Württemberg",
            "Heidenheim an der Brenz, Baden-Württemberg",
            "Mittenaar, Hessen",
            "Wuppertal, Nordrhein-Westfalen",
            "Dresden, Sachsen",
        ];
        for (const town of towns) expect(matchesCountry(town, "DE")).toBe(true);
    });

    it("covers every Bundesland", () => {
        const states = [
            "Baden-Württemberg", "Bayern", "Berlin", "Brandenburg", "Bremen", "Hamburg",
            "Hessen", "Mecklenburg-Vorpommern", "Niedersachsen", "Nordrhein-Westfalen",
            "Rheinland-Pfalz", "Saarland", "Sachsen", "Sachsen-Anhalt", "Schleswig-Holstein",
            "Thüringen",
        ];
        for (const state of states) expect(matchesCountry(`Musterstadt, ${state}`, "DE")).toBe(true);
    });

    it("covers every Austrian Bundesland", () => {
        const states = [
            "Burgenland", "Kärnten", "Niederösterreich", "Oberösterreich", "Salzburg",
            "Steiermark", "Tirol", "Vorarlberg", "Wien",
        ];
        for (const state of states) {
            expect(matchesCountry(`Musterdorf, ${state}`, "AT")).toBe(true);
            expect(matchesCountry(`Musterdorf, ${state}`, "DE")).toBe(false);
        }
    });

    it("leaves Freiburg im Breisgau in Germany", () => {
        // The Bundesland settles the one name that could have been Swiss.
        expect(resolveCountry("Freiburg im Breisgau, Baden-Württemberg").countries).toEqual([
            "DE",
        ]);
    });
});
