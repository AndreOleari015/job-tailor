import {mkdtemp, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {
    ConfigError,
    getCountryProfile,
    loadCountries,
    readDefaultCountry,
    resetCountriesCache,
    resolveWorkAuthorisation,
} from "../src/config.js";
import {loadCandidates} from "../src/sources/candidates.js";

const countriesPath = fileURLToPath(new URL("../data/countries.yaml", import.meta.url));
const candidatesPath = fileURLToPath(new URL("../data/candidates.yaml", import.meta.url));

const BLUE_CARD =
    "Eligible for the EU Blue Card under section 18g AufenthG as an IT specialist, " +
    "based on 4+ years of professional software experience.";

beforeEach(() => {
    process.env["JOB_TAILOR_COUNTRIES"] = countriesPath;
    resetCountriesCache();
});

afterEach(() => {
    delete process.env["JOB_TAILOR_COUNTRIES"];
    delete process.env["JOB_TAILOR_DEFAULT_COUNTRY"];
    resetCountriesCache();
    vi.restoreAllMocks();
});

describe("data/countries.yaml", () => {
    it("parses against the countries schema", () => {
        const {countries, default: defaultCode} = loadCountries();
        expect(defaultCode).toBe("DE");
        expect(Object.keys(countries).sort()).toEqual(["DE", "ES", "IE", "NL", "PT"]);
    });

    it("ships a real figure for DE and null everywhere else", () => {
        const {countries} = loadCountries();
        expect(countries["DE"]?.salary_min).toBe(45934);

        for (const code of ["IE", "NL", "PT", "ES"]) {
            // Deliberate: an unverified immigration number is worse than none.
            expect(countries[code]?.salary_min).toBeNull();
        }
    });

    it("defaults salary_note to null when the entry omits it", () => {
        expect(loadCountries().countries["PT"]?.salary_note).toBeNull();
    });
});

describe("getCountryProfile", () => {
    it("returns the configured profile for a known code", () => {
        const country = getCountryProfile("DE");
        expect(country.label).toBe("Germany");
        expect(country.currency).toBe("EUR");
        expect(country.salary_min).toBe(45934);
    });

    it("is case and whitespace insensitive", () => {
        expect(getCountryProfile(" de ").salary_min).toBe(45934);
    });

    it("returns the empty profile for a null code without throwing", () => {
        const country = getCountryProfile(null);
        expect(country.salary_min).toBeNull();
        expect(country.work_authorisation).toBe("");
    });

    it("treats an empty string like a null code", () => {
        expect(getCountryProfile("  ").salary_min).toBeNull();
    });

    it("logs an unconfigured country once and does not throw", () => {
        const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

        const first = getCountryProfile("JP");
        const second = getCountryProfile("jp");

        expect(first.salary_min).toBeNull();
        expect(first.work_authorisation).toBe("");
        expect(second.salary_min).toBeNull();

        const logged = stderr.mock.calls.map(([chunk]) => String(chunk)).join("");
        expect(logged).toContain("JP");
        // Said once, however many postings arrive from there.
        expect(logged.match(/JP is not configured/g)).toHaveLength(1);
    });
});

describe("resolveWorkAuthorisation", () => {
    it("returns the statement for a country that has one", () => {
        expect(resolveWorkAuthorisation("DE")).toBe(BLUE_CARD);
    });

    it("returns nothing for a country whose entry is deliberately empty", () => {
        expect(resolveWorkAuthorisation("IE")).toBeUndefined();
        expect(resolveWorkAuthorisation("ES")).toBeUndefined();
    });

    it("returns nothing when the country is unknown or absent", () => {
        vi.spyOn(process.stderr, "write").mockReturnValue(true);
        expect(resolveWorkAuthorisation(null)).toBeUndefined();
        expect(resolveWorkAuthorisation("JP")).toBeUndefined();
    });
});

describe("readDefaultCountry", () => {
    it("reads `default` from the file", () => {
        expect(readDefaultCountry()).toBe("DE");
    });

    it("is overridden by JOB_TAILOR_DEFAULT_COUNTRY", () => {
        process.env["JOB_TAILOR_DEFAULT_COUNTRY"] = "pt";
        expect(readDefaultCountry()).toBe("PT");
    });

    it("rejects an override that is not an alpha-2 code", () => {
        process.env["JOB_TAILOR_DEFAULT_COUNTRY"] = "Portugal";
        expect(() => readDefaultCountry()).toThrow(ConfigError);
    });
});

describe("a malformed countries file", () => {
    async function withFile(body: string): Promise<string> {
        const dir = await mkdtemp(path.join(tmpdir(), "job-tailor-countries-"));
        const filePath = path.join(dir, "countries.yaml");
        await writeFile(filePath, body, "utf8");
        process.env["JOB_TAILOR_COUNTRIES"] = filePath;
        resetCountriesCache();
        return filePath;
    }

    it("fails when a threshold is a string rather than a number or null", async () => {
        await withFile(
            "default: DE\ncountries:\n  DE:\n    label: Germany\n    currency: EUR\n" +
                '    salary_min: "45934"\n    work_authorisation: ""\n',
        );
        expect(() => loadCountries()).toThrow(/does not match the countries schema/);
    });

    it("fails when `default` names a country that is not configured", async () => {
        await withFile(
            "default: FR\ncountries:\n  DE:\n    label: Germany\n    currency: EUR\n" +
                '    salary_min: null\n    work_authorisation: ""\n',
        );
        expect(() => loadCountries()).toThrow(/not one of the configured countries/);
    });

    it("fails readably when the file is missing", async () => {
        process.env["JOB_TAILOR_COUNTRIES"] = "data/does-not-exist.yaml";
        resetCountriesCache();
        expect(() => loadCountries()).toThrow(/Could not read the country profiles/);
    });
});

describe("data/candidates.yaml", () => {
    it("parses against the candidates schema", async () => {
        const candidates = await loadCandidates(candidatesPath);

        expect(candidates.keywords).toContain("react native");
        expect(candidates.minMatching).toBe(1);
        expect(candidates.companies.length).toBeGreaterThanOrEqual(40);
    });

    it("spreads the seed list across several markets", async () => {
        const {companies} = await loadCandidates(candidatesPath);
        const byCountry = new Set(companies.map((company) => company.country));

        for (const code of ["DE", "NL", "IE", "PT", "ES"]) expect(byCountry).toContain(code);
        // Not concentrated in one market: no country holds half the list.
        for (const code of byCountry) {
            const share = companies.filter((company) => company.country === code).length;
            expect(share).toBeLessThan(companies.length / 2);
        }
    });

    it("returns an empty config for a missing file rather than throwing", async () => {
        const candidates = await loadCandidates("data/does-not-exist.yaml");
        expect(candidates.companies).toEqual([]);
    });

    it("rejects a company whose country is not an alpha-2 code", async () => {
        const dir = await mkdtemp(path.join(tmpdir(), "job-tailor-candidates-"));
        const filePath = path.join(dir, "candidates.yaml");
        await writeFile(filePath, "companies:\n  - name: Acme\n    country: Germany\n", "utf8");

        await expect(loadCandidates(filePath)).rejects.toThrow(/alpha-2/);
    });
});
