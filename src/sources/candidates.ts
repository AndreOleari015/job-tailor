import {readFile} from "node:fs/promises";
import {parse as parseYaml} from "yaml";
import {z} from "zod";
import {DEFAULT_CANDIDATES_PATH} from "../config.js";

/**
 * One company worth checking, and the market you would be applying in. The
 * country drives the salary threshold and the work-authorisation statement, so
 * a company reachable from two countries is two entries, not one.
 */
const candidateSchema = z.object({
    name: z.string().min(1),
    country: z.string().regex(/^[A-Za-z]{2}$/, "must be an ISO 3166-1 alpha-2 code"),
    /**
     * Board tokens to try instead of the ones derived from the name. Set this
     * when you already know the slug, or when the guesses all missed.
     */
    slugs: z.array(z.string().min(1)).optional(),
});

export const candidatesSchema = z.object({
    /** Vocabulary a posting has to hit to be worth reading. */
    keywords: z.array(z.string().min(1)).default([]),
    /** How many of those keywords, at minimum. */
    minMatching: z.number().int().min(1).default(1),
    companies: z.array(candidateSchema).default([]),
});

export type Candidate = z.infer<typeof candidateSchema>;
export type CandidatesConfig = z.infer<typeof candidatesSchema>;

const EMPTY: CandidatesConfig = {keywords: [], minMatching: 1, companies: []};

/**
 * Reads the candidate company list. A missing file is not an error — it means
 * no companies are being watched yet.
 */
export async function loadCandidates(
    filePath = DEFAULT_CANDIDATES_PATH,
): Promise<CandidatesConfig> {
    let raw: string;
    try {
        raw = await readFile(filePath, "utf8");
    } catch {
        return EMPTY;
    }

    let parsed: unknown;
    try {
        parsed = parseYaml(raw);
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`"${filePath}" is not valid YAML: ${reason}`);
    }

    if (parsed === null || parsed === undefined) return EMPTY;

    const result = candidatesSchema.safeParse(parsed);
    if (!result.success) {
        const issues = result.error.issues
            .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
            .join("\n");
        throw new Error(`"${filePath}" does not match the candidates schema:\n${issues}`);
    }

    return {
        ...result.data,
        companies: result.data.companies.map((company) => ({
            ...company,
            country: company.country.toUpperCase(),
        })),
    };
}
