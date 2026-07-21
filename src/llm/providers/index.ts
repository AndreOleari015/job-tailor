import {readMaxTokens, resolveProviderConfig, type Task} from "../../config.js";
import {AnthropicProvider} from "./anthropic.js";
import {GeminiProvider} from "./gemini.js";
import type {LlmProvider} from "./types.js";

export {AnthropicProvider} from "./anthropic.js";
export {GeminiProvider, toGeminiJsonSchema} from "./gemini.js";
export * from "./types.js";

/**
 * Builds the provider for a task from the environment. Throws ConfigError
 * naming the missing key when the selected provider is not configured.
 */
export function resolveProvider(task?: Task, modelOverride?: string): LlmProvider {
    const config = resolveProviderConfig(task);
    const model = modelOverride ?? config.model;

    switch (config.provider) {
        case "anthropic":
            return new AnthropicProvider({model, apiKey: config.apiKey, maxTokens: readMaxTokens()});
        case "gemini":
            return new GeminiProvider({model, apiKey: config.apiKey});
    }
}
