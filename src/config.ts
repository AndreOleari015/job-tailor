import "dotenv/config";
import {readFileSync} from "node:fs";
import {parse as parseYaml} from "yaml";
import {countriesFileSchema, type CountriesFile, type CountryProfile} from "./types.js";

export type ProviderName = "anthropic" | "gemini";
export type Task = "extract" | "tailor";

export const DEFAULT_PROVIDER: ProviderName = "gemini";

/** Model used when neither JOB_TAILOR_{TASK}_MODEL nor JOB_TAILOR_MODEL is set. */
export const PROVIDER_DEFAULT_MODEL: Record<ProviderName, string> = {
    gemini: "gemini-2.5-flash",
    anthropic: "claude-sonnet-4-5",
};

const PROVIDER_KEY_ENV: Record<ProviderName, string> = {
    gemini: "GEMINI_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
};

const TASK_MODEL_ENV: Record<Task, string> = {
    extract: "JOB_TAILOR_EXTRACT_MODEL",
    tailor: "JOB_TAILOR_TAILOR_MODEL",
};

/** Output cap per call. Comfortably above a JobSpec or TailoredApplication. */
export const DEFAULT_MAX_TOKENS = 16000;

/** Repair attempts after the first failed parse/validation. */
export const DEFAULT_MAX_RETRIES = 2;

export const DEFAULT_PROFILE_PATH = "data/profile.yaml";
export const DEFAULT_OUTPUT_DIR = "output";

/** Below this match score `run` skips the cover letter and keeps only the gaps. */
export const DEFAULT_MIN_SCORE = 40;

/**
 * Below this deterministic pre-score `run` skips the posting before the
 * tailoring call. 0 disables the filter, which is the default: a threshold
 * that rejects a posting on keyword overlap alone has to be opted into.
 */
export const DEFAULT_PRESCORE_MIN = 0;

export const DEFAULT_COUNTRIES_PATH = "data/countries.yaml";
export const DEFAULT_CANDIDATES_PATH = "data/candidates.yaml";

export class ConfigError extends Error {
    override readonly name = "ConfigError";
}

export function isDebug(): boolean {
    return process.env.DEBUG === "1";
}

function env(name: string): string | undefined {
    const value = process.env[name]?.trim();
    return value ? value : undefined;
}

function readInt(name: string, fallback: number, min = 1): number {
    const raw = env(name);
    if (!raw) return fallback;

    const value = Number.parseInt(raw, 10);
    if (!Number.isFinite(value) || value < min) {
        const bound = min === 1 ? "a positive integer" : `an integer >= ${min}`;
        throw new ConfigError(`${name} must be ${bound}, got "${raw}".`);
    }
    return value;
}

export function readMaxTokens(): number {
    return readInt("JOB_TAILOR_MAX_TOKENS", DEFAULT_MAX_TOKENS);
}

export function readMaxRetries(): number {
    return readInt("JOB_TAILOR_MAX_RETRIES", DEFAULT_MAX_RETRIES);
}

export function readMinScore(): number {
    return readInt("JOB_TAILOR_MIN_SCORE", DEFAULT_MIN_SCORE);
}

/** 0 disables the pre-filter entirely, so this one accepts zero. */
export function readPreScoreMin(): number {
    return readInt("JOB_TAILOR_PRESCORE_MIN", DEFAULT_PRESCORE_MIN, 0);
}

export function readProfilePath(): string {
    return env("JOB_TAILOR_PROFILE") ?? DEFAULT_PROFILE_PATH;
}

export function readOutputDir(): string {
    return env("JOB_TAILOR_OUTPUT_DIR") ?? DEFAULT_OUTPUT_DIR;
}

/** The port `serve` listens on. The --port flag still wins over it. */
export function readPort(fallback: number): number {
    return readInt("JOB_TAILOR_PORT", fallback);
}

/* ------------------------------------------------------------------ */
/* Country profiles                                                     */
/* ------------------------------------------------------------------ */

export function readCountriesPath(): string {
    return env("JOB_TAILOR_COUNTRIES") ?? DEFAULT_COUNTRIES_PATH;
}

/** Parsed once per path. Read synchronously: every caller of it is sync. */
const countriesByPath = new Map<string, CountriesFile>();

/** Codes already reported as unconfigured, so the warning is said once. */
const reportedUnconfigured = new Set<string>();

function normaliseCode(code: string): string {
    return code.trim().toUpperCase();
}

/**
 * A country with nothing configured: no threshold to compare against and
 * nothing that may be said about the right to work there. Both absences are
 * deliberate outcomes, not missing data to fill in with a guess.
 */
function unconfigured(code: string | null): CountryProfile {
    return {
        label: code ?? "unknown",
        currency: "",
        salary_min: null,
        salary_note: null,
        work_authorisation: "",
    };
}

export function loadCountries(filePath = readCountriesPath()): CountriesFile {
    const cached = countriesByPath.get(filePath);
    if (cached) return cached;

    let raw: string;
    try {
        raw = readFileSync(filePath, "utf8");
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new ConfigError(
            `Could not read the country profiles at "${filePath}": ${reason}\n` +
                "Copy the one from the repository, or set JOB_TAILOR_COUNTRIES.",
        );
    }

    let parsed: unknown;
    try {
        parsed = parseYaml(raw);
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new ConfigError(`"${filePath}" is not valid YAML: ${reason}`);
    }

    const result = countriesFileSchema.safeParse(parsed);
    if (!result.success) {
        const issues = result.error.issues
            .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
            .join("\n");
        throw new ConfigError(`"${filePath}" does not match the countries schema:\n${issues}`);
    }

    // Keyed by the normalised code from here on, so "de" and "DE" are one entry.
    const countries: Record<string, CountryProfile> = {};
    for (const [code, profile] of Object.entries(result.data.countries)) {
        countries[normaliseCode(code)] = profile;
    }

    const file: CountriesFile = {default: normaliseCode(result.data.default), countries};
    countriesByPath.set(filePath, file);
    return file;
}

/** Test seam: forces the next lookup to re-read the file. */
export function resetCountriesCache(): void {
    countriesByPath.clear();
    reportedUnconfigured.clear();
}

/**
 * The profile for a job's country. A null code — the posting's location was
 * ambiguous — and an unconfigured code both return the empty profile, which
 * disables the salary check and says nothing about work authorisation.
 */
export function getCountryProfile(code: string | null): CountryProfile {
    if (!code || !code.trim()) return unconfigured(null);

    const key = normaliseCode(code);
    const profile = loadCountries().countries[key];
    if (profile) return profile;

    if (!reportedUnconfigured.has(key)) {
        reportedUnconfigured.add(key);
        process.stderr.write(
            `[job-tailor] ${key} is not configured in ${readCountriesPath()}: no salary ` +
                "threshold and no work-authorisation statement will be applied.\n",
        );
    }
    return unconfigured(key);
}

/**
 * The work-authorisation statement for a country, or undefined when there is
 * none. Undefined means the letter must say nothing about authorisation at all
 * — an absent statement is never approximated from a neighbouring country.
 */
export function resolveWorkAuthorisation(country: string | null): string | undefined {
    const statement = getCountryProfile(country).work_authorisation;
    return statement.trim() ? statement : undefined;
}

/** JOB_TAILOR_DEFAULT_COUNTRY wins over `default` in the file. */
export function readDefaultCountry(): string {
    const override = env("JOB_TAILOR_DEFAULT_COUNTRY");
    if (override) {
        if (!/^[A-Za-z]{2}$/.test(override)) {
            throw new ConfigError(
                `JOB_TAILOR_DEFAULT_COUNTRY must be an ISO 3166-1 alpha-2 code, got "${override}".`,
            );
        }
        return normaliseCode(override);
    }
    return loadCountries().default;
}

/* ------------------------------------------------------------------ */
/* Job sources (phase 3)                                                */
/* ------------------------------------------------------------------ */

export const DEFAULT_SEARCH_LIMIT = 50;

/** Adzuna is the only source needing an account; both halves or neither. */
export function readAdzunaCredentials(): {appId: string; appKey: string} | undefined {
    const appId = env("ADZUNA_APP_ID");
    const appKey = env("ADZUNA_APP_KEY");
    return appId && appKey ? {appId, appKey} : undefined;
}

/**
 * The static client header the arbeitsagentur jobsuche API requires. Kept in
 * config rather than hardcoded so a change on their side is an .env edit.
 */
export function readArbeitsagenturKey(): string | undefined {
    return env("ARBEITSAGENTUR_API_KEY");
}

export function readCompaniesPath(): string {
    return env("JOB_TAILOR_COMPANIES") ?? "data/companies.yaml";
}

export function readCandidatesPath(): string {
    return env("JOB_TAILOR_CANDIDATES") ?? DEFAULT_CANDIDATES_PATH;
}

export function readJobsDir(): string {
    return env("JOB_TAILOR_JOBS_DIR") ?? "jobs";
}

/* ------------------------------------------------------------------ */
/* Provider selection                                                   */
/* ------------------------------------------------------------------ */

export function isProviderName(value: string): value is ProviderName {
    return value === "anthropic" || value === "gemini";
}

/** Set by the CLI's --provider flag; wins over JOB_TAILOR_PROVIDER. */
let providerOverride: ProviderName | undefined;

export function setProviderOverride(name: ProviderName | undefined): void {
    providerOverride = name;
}

export function resolveProviderName(): ProviderName {
    if (providerOverride) return providerOverride;

    const raw = env("JOB_TAILOR_PROVIDER");
    if (!raw) return DEFAULT_PROVIDER;
    if (!isProviderName(raw)) {
        throw new ConfigError(
            `JOB_TAILOR_PROVIDER must be "anthropic" or "gemini", got "${raw}".`,
        );
    }
    return raw;
}

/** JOB_TAILOR_{TASK}_MODEL > JOB_TAILOR_MODEL > provider default. */
export function resolveModel(provider: ProviderName, task?: Task): string {
    const taskModel = task ? env(TASK_MODEL_ENV[task]) : undefined;
    return taskModel ?? env("JOB_TAILOR_MODEL") ?? PROVIDER_DEFAULT_MODEL[provider];
}

export function resolveApiKey(provider: ProviderName): string {
    const keyName = PROVIDER_KEY_ENV[provider];
    const key = env(keyName);
    if (!key) {
        throw new ConfigError(
            `JOB_TAILOR_PROVIDER=${provider} but ${keyName} is not set. ` +
                "Copy .env.example to .env and add it.",
        );
    }
    return key;
}

export interface ProviderConfig {
    provider: ProviderName;
    model: string;
    apiKey: string;
}

export function resolveProviderConfig(task?: Task): ProviderConfig {
    const provider = resolveProviderName();
    return {provider, model: resolveModel(provider, task), apiKey: resolveApiKey(provider)};
}
