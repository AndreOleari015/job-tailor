import type Anthropic from "@anthropic-ai/sdk";
import {mkdir, readdir, rename, rm, rmdir, writeFile} from "node:fs/promises";
import path from "node:path";
import {z, type ZodType} from "zod";
import {
    isDebug,
    PROVIDER_DEFAULT_MODEL,
    readMaxRetries,
    readOutputDir,
    type Task,
} from "../config.js";
import {
    AnthropicProvider,
    resolveProvider,
    type LlmProvider,
    type LlmResponse,
    type LlmTurn,
} from "./providers/index.js";

/** Thrown when the model never produced JSON matching the requested schema. */
export class LlmValidationError extends Error {
    override readonly name = "LlmValidationError";
    readonly attempts: number;
    readonly validationError: string;
    readonly lastResponse: string;

    constructor(params: {attempts: number; validationError: string; lastResponse: string}) {
        super(
            `Model did not return valid JSON for the requested schema after ${params.attempts} ` +
                `attempt(s). Last validation error:\n${params.validationError}`,
        );
        this.attempts = params.attempts;
        this.validationError = params.validationError;
        this.lastResponse = params.lastResponse;
    }
}

export interface CallJsonOptions<T> {
    system: string;
    user: string;
    schema: ZodType<T>;
    /** Repair attempts after the first failure. Defaults to JOB_TAILOR_MAX_RETRIES (2). */
    maxRetries?: number;
    /** Selects the per-task model override. */
    task?: Task;
    /** Fully injected provider; skips environment resolution. */
    provider?: LlmProvider;
    /** Convenience for tests: injects an Anthropic SDK client and forces that provider. */
    client?: Anthropic;
    model?: string;
}

/** Removes a surrounding markdown code fence, with or without a language tag. */
export function stripCodeFences(text: string): string {
    const trimmed = text.trim();
    const fenced = /^```[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)\n?```$/.exec(trimmed);
    return fenced?.[1]?.trim() ?? trimmed;
}

function firstJsonObject(text: string): string | undefined {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end <= start) return undefined;
    return text.slice(start, end + 1);
}

function parseJson(raw: string): {ok: true; value: unknown} | {ok: false; error: string} {
    const candidates = [stripCodeFences(raw)];
    const sliced = firstJsonObject(candidates[0] ?? "");
    if (sliced && sliced !== candidates[0]) candidates.push(sliced);

    let lastError = "response was empty";
    for (const candidate of candidates) {
        if (!candidate) continue;
        try {
            return {ok: true, value: JSON.parse(candidate)};
        } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
        }
    }
    return {ok: false, error: `JSON.parse failed: ${lastError}`};
}

function describeIssues(error: unknown): string {
    if (error && typeof error === "object" && "issues" in error) {
        const {issues} = error as {issues: unknown};
        return JSON.stringify(issues, null, 2);
    }
    return error instanceof Error ? error.message : String(error);
}

function logUsage(provider: LlmProvider, response: LlmResponse, attempt: number): void {
    if (!isDebug()) return;
    const usage = response.usage;
    process.stderr.write(
        `[job-tailor] llm attempt=${attempt + 1} provider=${provider.name} ` +
            `model=${provider.model} input_tokens=${usage?.inputTokens ?? "?"} ` +
            `output_tokens=${usage?.outputTokens ?? "?"}\n`,
    );
}

/* ------------------------------------------------------------------ */
/* Debug transcript                                                     */
/* ------------------------------------------------------------------ */

/**
 * Under DEBUG=1 every request, raw response and failure is written to disk so a
 * bad run can be read afterwards instead of reproduced. Nothing here runs, and
 * nothing is created, when DEBUG is unset.
 */
let sessionStamp: string | undefined;
let rebasedDir: string | undefined;
let announcedDir: string | undefined;

/** Where transcripts go now: the artefact directory once known, else a timestamp. */
function transcriptDir(): string {
    if (rebasedDir) return rebasedDir;
    sessionStamp ??= new Date().toISOString().replace(/[:.]/g, "-");
    return path.join(readOutputDir(), "_debug", sessionStamp);
}

/**
 * Moves transcripts written so far under the final artefact directory and sends
 * later ones straight there. Callers know the slug only after extraction, so the
 * session starts under `_debug/` and is rebased once the company and role exist.
 */
export async function rebaseTranscript(targetDir: string): Promise<void> {
    if (!isDebug()) return;

    const from = transcriptDir();
    if (from === targetDir) return;
    rebasedDir = targetDir;

    await mkdir(targetDir, {recursive: true});
    for (const name of await readdir(from).catch(() => [])) {
        await rename(path.join(from, name), path.join(targetDir, name)).catch(() => undefined);
    }
    await rm(from, {recursive: true, force: true}).catch(() => undefined);
    // Drop the now-empty _debug parent; fails harmlessly if another session is live.
    await rmdir(path.dirname(from)).catch(() => undefined);
}

interface Transcript {
    request(attempt: number, payload: object): Promise<void>;
    response(attempt: number, text: string): Promise<void>;
    error(attempt: number, message: string): Promise<void>;
}

function openTranscript(task: string): Transcript {
    const write = async (name: string, body: string): Promise<void> => {
        const dir = transcriptDir();
        try {
            await mkdir(dir, {recursive: true});
            await writeFile(path.join(dir, `${task}-${name}`), body, "utf8");
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            process.stderr.write(`[job-tailor] could not write debug transcript: ${reason}\n`);
            return;
        }
        if (dir !== announcedDir) {
            announcedDir = dir;
            process.stderr.write(`[job-tailor] debug transcript: ${dir}\n`);
        }
    };

    return {
        request: (attempt, payload) =>
            write(`${attempt}-request.json`, `${JSON.stringify(payload, null, 2)}\n`),
        response: (attempt, text) => write(`${attempt}-response.txt`, text),
        error: (attempt, message) => write(`${attempt}-error.txt`, `${message}\n`),
    };
}

function repairMessage(validationError: string): string {
    return (
        "Your previous response was not valid JSON for the requested schema.\n\n" +
        `Validation error:\n${validationError}\n\n` +
        "Return the corrected object as raw JSON only. No prose, no markdown code fences, " +
        "no trailing commentary. Keep every field required by the schema."
    );
}

function providerFor<T>(options: CallJsonOptions<T>): LlmProvider {
    if (options.provider) return options.provider;
    if (options.client) {
        return new AnthropicProvider({
            model: options.model ?? PROVIDER_DEFAULT_MODEL.anthropic,
            client: options.client,
        });
    }
    return resolveProvider(options.task, options.model);
}

/** JSON Schema for providers that constrain output server-side. */
function jsonSchemaFor<T>(schema: ZodType<T>): object | undefined {
    try {
        return z.toJSONSchema(schema) as object;
    } catch {
        // Not every zod construct is representable; fall back to prompt-only.
        return undefined;
    }
}

/**
 * Calls the configured provider and returns a value validated against `schema`.
 *
 * Providers with native structured output receive the schema and are constrained
 * server-side; the rest rely on the prompt. Either way the response is fence
 * stripped, parsed and validated here, and a failure continues the conversation
 * with a repair message carrying the exact validation error.
 */
export async function callJson<T>(options: CallJsonOptions<T>): Promise<T> {
    const provider = providerFor(options);
    const maxRetries = options.maxRetries ?? readMaxRetries();
    const jsonSchema = provider.supportsNativeJsonSchema
        ? jsonSchemaFor(options.schema)
        : undefined;

    const transcript = isDebug() ? openTranscript(options.task ?? "llm") : undefined;
    const history: LlmTurn[] = [];
    let validationError = "no attempt was made";
    let lastResponse = "";

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        await transcript?.request(attempt + 1, {
            provider: provider.name,
            model: provider.model,
            system: options.system,
            user: options.user,
            history: [...history],
            jsonSchema: jsonSchema ?? null,
        });

        const response = await provider.complete({
            system: options.system,
            user: options.user,
            history: [...history],
            ...(jsonSchema ? {jsonSchema} : {}),
        });

        logUsage(provider, response, attempt);
        lastResponse = response.text;
        await transcript?.response(attempt + 1, lastResponse);

        const parsed = parseJson(lastResponse);
        if (parsed.ok) {
            const result = options.schema.safeParse(parsed.value);
            if (result.success) return result.data;
            validationError = describeIssues(result.error);
        } else {
            validationError = parsed.error;
        }

        await transcript?.error(attempt + 1, validationError);
        history.push({role: "assistant", text: lastResponse || "(empty response)"});
        history.push({role: "user", text: repairMessage(validationError)});
    }

    throw new LlmValidationError({attempts: maxRetries + 1, validationError, lastResponse});
}
