import type {GoogleGenAI} from "@google/genai";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {z} from "zod";
import {
    ConfigError,
    resolveModel,
    resolveProviderName,
    setProviderOverride,
    type ProviderName,
} from "../src/config.js";
import {callJson} from "../src/llm/client.js";
import {
    AnthropicProvider,
    GeminiProvider,
    LlmProviderError,
    LlmQuotaError,
    resolveProvider,
    toGeminiJsonSchema,
} from "../src/llm/providers/index.js";
import {jobSpecSchema} from "../src/types.js";

const MANAGED_ENV = [
    "JOB_TAILOR_PROVIDER",
    "JOB_TAILOR_MODEL",
    "JOB_TAILOR_EXTRACT_MODEL",
    "JOB_TAILOR_TAILOR_MODEL",
    "GEMINI_API_KEY",
    "ANTHROPIC_API_KEY",
] as const;

const saved = new Map<string, string | undefined>();

beforeEach(() => {
    for (const key of MANAGED_ENV) {
        saved.set(key, process.env[key]);
        delete process.env[key];
    }
    setProviderOverride(undefined);
});

afterEach(() => {
    for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    setProviderOverride(undefined);
    vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ */
/* Provider and model resolution                                        */
/* ------------------------------------------------------------------ */

describe("provider resolution", () => {
    it("defaults to gemini", () => {
        expect(resolveProviderName()).toBe("gemini");
        expect(resolveModel("gemini")).toBe("gemini-2.5-flash");
    });

    it("reads JOB_TAILOR_PROVIDER", () => {
        process.env.JOB_TAILOR_PROVIDER = "anthropic";
        expect(resolveProviderName()).toBe("anthropic");
        expect(resolveModel("anthropic")).toBe("claude-sonnet-4-5");
    });

    it("rejects an unknown provider name", () => {
        process.env.JOB_TAILOR_PROVIDER = "openai";
        expect(() => resolveProviderName()).toThrow(ConfigError);
        expect(() => resolveProviderName()).toThrow(/anthropic.*gemini/);
    });

    it("lets the CLI override beat the env var", () => {
        process.env.JOB_TAILOR_PROVIDER = "gemini";
        setProviderOverride("anthropic");
        expect(resolveProviderName()).toBe("anthropic");
    });
});

describe("model resolution precedence", () => {
    it("uses the provider default when nothing is set", () => {
        expect(resolveModel("gemini", "extract")).toBe("gemini-2.5-flash");
        expect(resolveModel("anthropic", "tailor")).toBe("claude-sonnet-4-5");
    });

    it("lets JOB_TAILOR_MODEL beat the provider default for every task", () => {
        process.env.JOB_TAILOR_MODEL = "gemini-2.5-pro";
        expect(resolveModel("gemini", "extract")).toBe("gemini-2.5-pro");
        expect(resolveModel("gemini", "tailor")).toBe("gemini-2.5-pro");
        expect(resolveModel("gemini")).toBe("gemini-2.5-pro");
    });

    it("lets a task model beat JOB_TAILOR_MODEL, for that task only", () => {
        process.env.JOB_TAILOR_MODEL = "gemini-2.5-pro";
        process.env.JOB_TAILOR_EXTRACT_MODEL = "gemini-2.5-flash";
        expect(resolveModel("gemini", "extract")).toBe("gemini-2.5-flash");
        expect(resolveModel("gemini", "tailor")).toBe("gemini-2.5-pro");
    });

    it("resolves each task independently", () => {
        process.env.JOB_TAILOR_EXTRACT_MODEL = "gemini-2.5-flash";
        process.env.JOB_TAILOR_TAILOR_MODEL = "gemini-2.5-pro";
        expect(resolveModel("gemini", "extract")).toBe("gemini-2.5-flash");
        expect(resolveModel("gemini", "tailor")).toBe("gemini-2.5-pro");
    });
});

describe("resolveProvider", () => {
    it("builds a Gemini provider with native schema support", () => {
        process.env.GEMINI_API_KEY = "test-key";
        const provider = resolveProvider("extract");

        expect(provider).toBeInstanceOf(GeminiProvider);
        expect(provider.name).toBe("gemini");
        expect(provider.model).toBe("gemini-2.5-flash");
        expect(provider.supportsNativeJsonSchema).toBe(true);
    });

    it("builds an Anthropic provider without native schema support", () => {
        process.env.JOB_TAILOR_PROVIDER = "anthropic";
        process.env.ANTHROPIC_API_KEY = "test-key";
        const provider = resolveProvider("tailor");

        expect(provider).toBeInstanceOf(AnthropicProvider);
        expect(provider.name).toBe("anthropic");
        expect(provider.model).toBe("claude-sonnet-4-5");
        expect(provider.supportsNativeJsonSchema).toBe(false);
    });

    it("applies the task model override", () => {
        process.env.GEMINI_API_KEY = "test-key";
        process.env.JOB_TAILOR_TAILOR_MODEL = "gemini-2.5-pro";
        expect(resolveProvider("extract").model).toBe("gemini-2.5-flash");
        expect(resolveProvider("tailor").model).toBe("gemini-2.5-pro");
    });
});

describe("ConfigError for a missing key", () => {
    const cases: {provider: ProviderName; missing: string; other: string}[] = [
        {provider: "gemini", missing: "GEMINI_API_KEY", other: "ANTHROPIC_API_KEY"},
        {provider: "anthropic", missing: "ANTHROPIC_API_KEY", other: "GEMINI_API_KEY"},
    ];

    for (const {provider, missing, other} of cases) {
        it(`names ${missing} when ${provider} is selected`, () => {
            process.env.JOB_TAILOR_PROVIDER = provider;
            // The other provider's key must not satisfy this one.
            process.env[other] = "irrelevant";

            expect(() => resolveProvider("extract")).toThrow(ConfigError);
            expect(() => resolveProvider("extract")).toThrow(
                `JOB_TAILOR_PROVIDER=${provider} but ${missing} is not set.`,
            );
        });
    }
});

/* ------------------------------------------------------------------ */
/* Gemini provider                                                      */
/* ------------------------------------------------------------------ */

function apiError(status: number, message: string): Error {
    return Object.assign(new Error(message), {status});
}

function geminiReply(text: string) {
    return {
        text,
        usageMetadata: {promptTokenCount: 1200, candidatesTokenCount: 340},
    };
}

/** Fake @google/genai client plus captured sleep delays. */
function fakeGemini(model = "gemini-2.5-flash") {
    const generateContent = vi.fn();
    const delays: number[] = [];
    const provider = new GeminiProvider({
        model,
        client: {models: {generateContent}} as unknown as GoogleGenAI,
        sleep: async (ms) => {
            delays.push(ms);
        },
        random: () => 0,
    });
    return {provider, generateContent, delays};
}

describe("GeminiProvider retries", () => {
    it("retries a 429 and succeeds on the third attempt", async () => {
        const {provider, generateContent, delays} = fakeGemini();
        const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

        generateContent
            .mockRejectedValueOnce(apiError(429, "Resource has been exhausted"))
            .mockRejectedValueOnce(apiError(429, "Resource has been exhausted"))
            .mockResolvedValueOnce(geminiReply('{"ok":true}'));

        const response = await provider.complete({system: "s", user: "u"});

        expect(response.text).toBe('{"ok":true}');
        expect(generateContent).toHaveBeenCalledTimes(3);
        expect(delays).toEqual([2000, 4000]);

        // The wait is explained on stderr so a stall is never silent.
        const logged = stderr.mock.calls.map(([chunk]) => String(chunk)).join("");
        expect(logged).toContain("HTTP 429");
        expect(logged).toContain("retry 2/3");
        expect(logged).toContain("retry 3/3");
    });

    it("retries a 503", async () => {
        const {provider, generateContent} = fakeGemini();
        vi.spyOn(process.stderr, "write").mockReturnValue(true);

        generateContent
            .mockRejectedValueOnce(apiError(503, "Service unavailable"))
            .mockResolvedValueOnce(geminiReply('{"ok":true}'));

        await expect(provider.complete({system: "s", user: "u"})).resolves.toMatchObject({
            text: '{"ok":true}',
        });
        expect(generateContent).toHaveBeenCalledTimes(2);
    });

    it("reports LlmQuotaError once the retries are spent", async () => {
        const {provider, generateContent} = fakeGemini();
        vi.spyOn(process.stderr, "write").mockReturnValue(true);
        generateContent.mockRejectedValue(apiError(429, "Resource has been exhausted"));

        await expect(provider.complete({system: "s", user: "u"})).rejects.toBeInstanceOf(
            LlmQuotaError,
        );
        expect(generateContent).toHaveBeenCalledTimes(3);
    });

    it("fails fast on a per-day quota instead of burning the retry window", async () => {
        const {provider, generateContent, delays} = fakeGemini();
        generateContent.mockRejectedValue(
            apiError(429, "Quota exceeded: GenerateRequestsPerDayPerProjectPerModel"),
        );

        const error = await provider.complete({system: "s", user: "u"}).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(LlmQuotaError);
        expect((error as Error).message).toMatch(/--provider anthropic/);
        expect(generateContent).toHaveBeenCalledTimes(1);
        expect(delays).toEqual([]);
    });

    it("does not retry a 400", async () => {
        const {provider, generateContent} = fakeGemini();
        generateContent.mockRejectedValue(apiError(400, "Invalid request"));

        const error = await provider.complete({system: "s", user: "u"}).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(LlmProviderError);
        expect(error).not.toBeInstanceOf(LlmQuotaError);
        expect(generateContent).toHaveBeenCalledTimes(1);
    });

    it("reports usage", async () => {
        const {provider, generateContent} = fakeGemini();
        generateContent.mockResolvedValueOnce(geminiReply("{}"));

        const response = await provider.complete({system: "s", user: "u"});
        expect(response.usage).toEqual({inputTokens: 1200, outputTokens: 340});
    });
});

/* ------------------------------------------------------------------ */
/* Schema conversion                                                    */
/* ------------------------------------------------------------------ */

describe("toGeminiJsonSchema", () => {
    it("drops keywords Gemini rejects and keeps the rest", () => {
        const converted = toGeminiJsonSchema({
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: {
                name: {type: "string", minLength: 1, description: "keep me"},
                mode: {type: "string", enum: ["a", "b"]},
                salary: {anyOf: [{type: "number", minimum: 0}, {type: "null"}]},
                tags: {type: "array", items: {type: "string", pattern: "^x"}},
            },
            required: ["name"],
            additionalProperties: false,
        }) as Record<string, never>;

        expect(converted).toEqual({
            type: "object",
            properties: {
                name: {type: "string", description: "keep me"},
                mode: {type: "string", enum: ["a", "b"]},
                salary: {anyOf: [{type: "number", minimum: 0}, {type: "null"}]},
                tags: {type: "array", items: {type: "string"}},
            },
            required: ["name"],
            additionalProperties: false,
        });
    });
});

describe("callJson against Gemini", () => {
    it("sends a schema the Gemini request accepts", async () => {
        const {provider, generateContent} = fakeGemini();
        generateContent.mockResolvedValueOnce(
            geminiReply(
                JSON.stringify({
                    company: "Acme GmbH",
                    role: "Senior React Native Engineer",
                    location: "Berlin",
                    country: "DE",
                    remote: "hybrid",
                    language: "de",
                    seniority: "senior",
                    required_stack: ["React Native"],
                    nice_to_have: [],
                    salary_min_eur: null,
                    visa_sponsorship: "not_mentioned",
                    key_responsibilities: [],
                    tone: "startup",
                }),
            ),
        );

        const result = await callJson({
            system: "system prompt",
            user: "user prompt",
            schema: jobSpecSchema,
            provider,
        });

        expect(result.company).toBe("Acme GmbH");

        const payload = generateContent.mock.calls[0]?.[0] as {
            model: string;
            contents: {role: string; parts: {text: string}[]}[];
            config: Record<string, unknown>;
        };

        expect(payload.model).toBe("gemini-2.5-flash");
        expect(payload.contents).toEqual([{role: "user", parts: [{text: "user prompt"}]}]);
        expect(payload.config.systemInstruction).toBe("system prompt");
        expect(payload.config.temperature).toBe(0);
        expect(payload.config.responseMimeType).toBe("application/json");

        const schema = payload.config.responseJsonSchema as Record<string, unknown>;
        expect(schema).not.toHaveProperty("$schema");
        expect(schema.type).toBe("object");
        expect(schema.required).toContain("visa_sponsorship");

        // zod emits minLength on non-empty strings; Gemini does not accept it.
        expect(JSON.stringify(schema)).not.toContain("minLength");

        // Enums and the nullable salary survive the conversion.
        const properties = schema.properties as Record<string, Record<string, unknown>>;
        expect(properties.tone?.enum).toEqual(["corporate", "startup", "agency"]);
        expect(properties.salary_min_eur?.anyOf).toEqual([{type: "number"}, {type: "null"}]);
    });

    it("replays a failed attempt as a model turn on the repair call", async () => {
        const {provider, generateContent} = fakeGemini();
        generateContent
            .mockResolvedValueOnce(geminiReply("not json at all"))
            .mockResolvedValueOnce(geminiReply('{"company":"Acme","score":1}'));

        const result = await callJson({
            system: "s",
            user: "u",
            schema: z.object({company: z.string(), score: z.number()}),
            provider,
        });

        expect(result).toEqual({company: "Acme", score: 1});

        const second = generateContent.mock.calls[1]?.[0] as {
            contents: {role: string; parts: {text: string}[]}[];
        };
        expect(second.contents.map((turn) => turn.role)).toEqual(["user", "model", "user"]);
        expect(second.contents[2]?.parts[0]?.text).toContain("JSON.parse failed");
    });
});
