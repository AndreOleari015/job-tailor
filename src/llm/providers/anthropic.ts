import Anthropic from "@anthropic-ai/sdk";
import {DEFAULT_MAX_TOKENS} from "../../config.js";
import type {LlmProvider, LlmRequest, LlmResponse} from "./types.js";

export interface AnthropicProviderOptions {
    model: string;
    apiKey?: string;
    maxTokens?: number;
    /** Injected in tests. */
    client?: Anthropic;
}

export class AnthropicProvider implements LlmProvider {
    readonly name = "anthropic" as const;
    readonly model: string;
    /** The Messages API has no response-schema parameter; we prompt for JSON. */
    readonly supportsNativeJsonSchema = false;

    readonly #client: Anthropic;
    readonly #maxTokens: number;

    constructor(options: AnthropicProviderOptions) {
        this.model = options.model;
        this.#maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
        this.#client = options.client ?? new Anthropic({apiKey: options.apiKey});
    }

    async complete(request: LlmRequest): Promise<LlmResponse> {
        const messages: Anthropic.MessageParam[] = [{role: "user", content: request.user}];
        for (const turn of request.history ?? []) {
            messages.push({role: turn.role, content: turn.text});
        }

        // `temperature` is deliberately not forwarded: it is rejected with a 400
        // on Claude 4.6 and later, and JOB_TAILOR_MODEL may point at any model.
        const message = await this.#client.messages.create({
            model: this.model,
            max_tokens: this.#maxTokens,
            system: request.system,
            messages,
        });

        const parts: string[] = [];
        for (const block of message.content) {
            if (block.type === "text") parts.push(block.text);
        }

        return {
            text: parts.join("\n"),
            usage: {
                inputTokens: message.usage.input_tokens,
                outputTokens: message.usage.output_tokens,
            },
        };
    }
}
