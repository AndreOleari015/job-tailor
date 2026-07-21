import {GoogleGenAI} from "@google/genai";
import {LlmProviderError, LlmQuotaError, type LlmProvider, type LlmRequest, type LlmResponse} from "./types.js";

/**
 * Keys Gemini accepts inside `responseJsonSchema`. Anything else (notably
 * `$schema` and `minLength`, both emitted by zod) is dropped rather than
 * risking a 400 on an unsupported property.
 */
const SUPPORTED_SCHEMA_KEYS = new Set([
    "$id",
    "$defs",
    "$ref",
    "$anchor",
    "type",
    "format",
    "title",
    "description",
    "enum",
    "items",
    "prefixItems",
    "minItems",
    "maxItems",
    "minimum",
    "maximum",
    "anyOf",
    "oneOf",
    "properties",
    "additionalProperties",
    "required",
    "propertyOrdering",
]);

/** Keys whose value is itself a schema, or a map/array of schemas. */
const SCHEMA_MAP_KEYS = new Set(["properties", "$defs"]);
const SCHEMA_VALUE_KEYS = new Set(["items", "additionalProperties", "anyOf", "oneOf", "prefixItems"]);

/** Strips JSON Schema keywords Gemini does not support, recursively. */
export function toGeminiJsonSchema(schema: unknown): unknown {
    if (Array.isArray(schema)) return schema.map(toGeminiJsonSchema);
    if (!schema || typeof schema !== "object") return schema;

    const output: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
        if (!SUPPORTED_SCHEMA_KEYS.has(key)) continue;

        if (SCHEMA_MAP_KEYS.has(key) && value && typeof value === "object") {
            const mapped: Record<string, unknown> = {};
            for (const [name, child] of Object.entries(value as Record<string, unknown>)) {
                mapped[name] = toGeminiJsonSchema(child);
            }
            output[key] = mapped;
        } else if (SCHEMA_VALUE_KEYS.has(key)) {
            output[key] = toGeminiJsonSchema(value);
        } else {
            output[key] = value;
        }
    }
    return output;
}

const RETRY_ATTEMPTS = 3;
const BASE_DELAY_MS = 2000;
const JITTER_MS = 500;

function statusOf(error: unknown): number | undefined {
    if (error && typeof error === "object" && "status" in error) {
        const {status} = error as {status: unknown};
        if (typeof status === "number") return status;
    }
    return undefined;
}

function isRetryable(status: number | undefined): boolean {
    return status === 429 || (status !== undefined && status >= 500 && status < 600);
}

/** A per-day cap will not clear within a retry window, so fail fast on it. */
function isDailyQuota(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /per\s*day|perday|daily/i.test(message);
}

function defaultSleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface GeminiProviderOptions {
    model: string;
    apiKey?: string;
    /** Injected in tests. */
    client?: GoogleGenAI;
    sleep?: (ms: number) => Promise<void>;
    random?: () => number;
}

export class GeminiProvider implements LlmProvider {
    readonly name = "gemini" as const;
    readonly model: string;
    readonly supportsNativeJsonSchema = true;

    readonly #client: GoogleGenAI;
    readonly #sleep: (ms: number) => Promise<void>;
    readonly #random: () => number;

    constructor(options: GeminiProviderOptions) {
        this.model = options.model;
        this.#client = options.client ?? new GoogleGenAI({apiKey: options.apiKey ?? ""});
        this.#sleep = options.sleep ?? defaultSleep;
        this.#random = options.random ?? Math.random;
    }

    async complete(request: LlmRequest): Promise<LlmResponse> {
        for (let attempt = 1; ; attempt++) {
            try {
                return await this.#send(request);
            } catch (error) {
                const status = statusOf(error);

                if (status === 429 && isDailyQuota(error)) throw this.#quotaError(error);
                if (!isRetryable(status) || attempt >= RETRY_ATTEMPTS) throw this.#translate(error, status);

                const delay = BASE_DELAY_MS * 2 ** (attempt - 1) + Math.floor(this.#random() * JITTER_MS);
                // Always logged, not only under DEBUG: this is why the CLI stalls.
                process.stderr.write(
                    `[job-tailor] gemini returned HTTP ${status}; waiting ` +
                        `${(delay / 1000).toFixed(1)}s before retry ${attempt + 1}/${RETRY_ATTEMPTS}\n`,
                );
                await this.#sleep(delay);
            }
        }
    }

    async #send(request: LlmRequest): Promise<LlmResponse> {
        const contents = [{role: "user", parts: [{text: request.user}]}];
        for (const turn of request.history ?? []) {
            contents.push({
                role: turn.role === "assistant" ? "model" : "user",
                parts: [{text: turn.text}],
            });
        }

        const config: Record<string, unknown> = {
            systemInstruction: request.system,
            temperature: request.temperature ?? 0,
        };
        if (request.jsonSchema) {
            config.responseMimeType = "application/json";
            config.responseJsonSchema = toGeminiJsonSchema(request.jsonSchema);
        }

        const response = await this.#client.models.generateContent({
            model: this.model,
            contents,
            config,
        });

        const usage = response.usageMetadata;
        return {
            text: response.text ?? "",
            usage: usage
                ? {
                      inputTokens: usage.promptTokenCount ?? 0,
                      outputTokens: usage.candidatesTokenCount ?? 0,
                  }
                : undefined,
        };
    }

    #quotaError(cause: unknown): LlmQuotaError {
        return new LlmQuotaError(
            this.name,
            `Gemini quota exhausted for ${this.model}. Free-tier limits reset on a schedule; ` +
                "wait, pick a lighter model with JOB_TAILOR_MODEL, or run with --provider anthropic.",
            {cause},
        );
    }

    #translate(error: unknown, status: number | undefined): Error {
        if (status === 429) return this.#quotaError(error);

        const detail = error instanceof Error ? error.message : String(error);
        return new LlmProviderError(
            this.name,
            `Gemini request failed${status ? ` (HTTP ${status})` : ""}: ${detail}`,
            {cause: error},
        );
    }
}
