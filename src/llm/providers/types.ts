import type {ProviderName} from "../../config.js";

/** One prior turn of a repair conversation. */
export interface LlmTurn {
    role: "user" | "assistant";
    text: string;
}

export interface LlmRequest {
    system: string;
    user: string;
    /**
     * Prior turns appended after `user`. The repair loop uses this to show the
     * model its own bad output alongside the validation error.
     */
    history?: LlmTurn[];
    /** JSON Schema, for providers with native structured output. */
    jsonSchema?: object;
    /** Defaults to 0. */
    temperature?: number;
}

export interface LlmResponse {
    text: string;
    usage?: {inputTokens: number; outputTokens: number};
}

export interface LlmProvider {
    readonly name: ProviderName;
    readonly model: string;
    readonly supportsNativeJsonSchema: boolean;
    complete(request: LlmRequest): Promise<LlmResponse>;
}

export class LlmProviderError extends Error {
    override readonly name: string = "LlmProviderError";
    readonly provider: ProviderName;

    constructor(provider: ProviderName, message: string, options?: {cause?: unknown}) {
        super(message, options);
        this.provider = provider;
    }
}

/** Quota or rate limit that retrying will not clear soon. */
export class LlmQuotaError extends LlmProviderError {
    override readonly name: string = "LlmQuotaError";
}
