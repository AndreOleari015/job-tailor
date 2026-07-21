import {readFile} from "node:fs/promises";
import {parse as parseYaml} from "yaml";
import {z} from "zod";

export const DEFAULT_COMPANIES_PATH = "data/companies.yaml";

/**
 * A board is addressed by its token, the slug in the board URL. `label` is the
 * display name for sources whose API does not return one (Lever and Ashby do
 * not), and it becomes the posting's company.
 */
const boardEntrySchema = z.object({
    token: z.string().min(1),
    label: z.string().optional(),
});

const companiesSchema = z.object({
    greenhouse: z.array(boardEntrySchema).default([]),
    lever: z.array(boardEntrySchema).default([]),
    ashby: z.array(boardEntrySchema).default([]),
});

export type BoardEntry = z.infer<typeof boardEntrySchema>;
export type BoardName = "greenhouse" | "lever" | "ashby";
export type CompanyConfig = z.infer<typeof companiesSchema>;

const EMPTY: CompanyConfig = {greenhouse: [], lever: [], ashby: []};

/**
 * Reads the configured board tokens. A missing file is not an error — it means
 * no boards are configured, and the aggregator sources still work.
 */
export async function loadCompanies(filePath = DEFAULT_COMPANIES_PATH): Promise<CompanyConfig> {
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

    const result = companiesSchema.safeParse(parsed);
    if (!result.success) {
        const issues = result.error.issues
            .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
            .join("\n");
        throw new Error(`"${filePath}" does not match the companies schema:\n${issues}`);
    }
    return result.data;
}
