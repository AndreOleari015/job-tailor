import "dotenv/config";

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

/**
 * Annual gross EUR below which an offer is flagged. Currently the German
 * EU Blue Card threshold for IT specialists without a degree in the field.
 */
export const SALARY_THRESHOLD_EUR = 45934;

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
