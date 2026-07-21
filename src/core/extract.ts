import type Anthropic from "@anthropic-ai/sdk";
import {callJson} from "../llm/client.js";
import type {LlmProvider} from "../llm/providers/index.js";
import {extractionPrompt} from "../llm/prompts.js";
import {jobSpecSchema, type JobSpec} from "../types.js";

export interface ExtractOptions {
    provider?: LlmProvider;
    client?: Anthropic;
    model?: string;
    maxRetries?: number;
}

const COMPANY_HEADER = /^[ \t]*company[ \t]*:[ \t]*([^\n]+?)[ \t]*$/im;

/**
 * The company named by an explicit `Company: X` line, which the operator adds
 * to a job file when the posting itself hides the employer (recruiter listings
 * usually do). Deterministic, so it is enforced here rather than only asked
 * for in the prompt.
 */
export function companyFromHeader(jobText: string): string | undefined {
    const declared = COMPANY_HEADER.exec(jobText)?.[1]?.trim();
    return declared ? declared : undefined;
}

/** Parses raw job-description text into a validated JobSpec. */
export async function extractJobSpec(
    jobText: string,
    options: ExtractOptions = {},
): Promise<JobSpec> {
    const text = jobText.trim();
    if (!text) {
        throw new Error("The job description is empty. Pass a file path or pipe text on stdin.");
    }

    const {system, user} = extractionPrompt(text);
    const jobSpec = await callJson({
        system,
        user,
        schema: jobSpecSchema,
        task: "extract",
        ...options,
    });

    const declared = companyFromHeader(text);
    return declared ? {...jobSpec, company: declared} : jobSpec;
}
