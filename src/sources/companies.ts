import {mkdir, readFile, writeFile} from "node:fs/promises";
import path from "node:path";
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
    /**
     * Where the board's postings are, as ISO 3166-1 alpha-2. Written by
     * `discover --write` from the candidate list; the sources layer itself
     * never learns a country, so nothing reads this yet — it is a note to you.
     */
    country: z.string().optional(),
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

/* ------------------------------------------------------------------ */
/* Writing                                                              */
/* ------------------------------------------------------------------ */

export interface CompanyAddition {
    board: BoardName;
    token: string;
    label?: string;
    country?: string;
}

/** Conservative: anything that is not plainly a scalar gets quoted. */
function yamlScalar(value: string): string {
    return /^[A-Za-z0-9][A-Za-z0-9 .&'()/_-]*$/.test(value) ? value : JSON.stringify(value);
}

function renderEntry(entry: CompanyAddition): string[] {
    const lines = [`  - token: ${yamlScalar(entry.token)}`];
    if (entry.label) lines.push(`    label: ${yamlScalar(entry.label)}`);
    if (entry.country) lines.push(`    country: ${yamlScalar(entry.country)}`);
    return lines;
}

/**
 * Splices lines under a top-level key without touching anything else.
 *
 * This file is hand-written and full of comments explaining where tokens come
 * from. Re-emitting it from a parsed object would silently delete all of that,
 * so the edit is textual: find the key, insert after its last entry, leave
 * every other byte alone.
 */
function insertUnderKey(lines: readonly string[], key: string, block: readonly string[]): string[] {
    const keyPattern = new RegExp(`^${key}:\\s*(.*)$`);
    const index = lines.findIndex((line) => keyPattern.test(line));

    if (index === -1) {
        const out = [...lines];
        while (out.length && out[out.length - 1]?.trim() === "") out.pop();
        return [...out, `${key}:`, ...block, ""];
    }

    const value = (keyPattern.exec(lines[index] ?? "")?.[1] ?? "").trim();
    if (value && value !== "[]") {
        throw new Error(
            `"${key}" is written inline in the companies file. Convert it to a block list ` +
                "(one `- token:` per line) before appending to it.",
        );
    }

    const out = [...lines];
    if (value === "[]") out[index] = `${key}:`;

    // Everything up to the next top-level key belongs to this block. Insert
    // after its last real entry, so trailing comments and blank lines stay put.
    let end = index;
    for (let cursor = index + 1; cursor < out.length; cursor++) {
        const line = out[cursor] ?? "";
        if (/^[^\s#]/.test(line)) break;
        if (line.trim() && !line.trimStart().startsWith("#")) end = cursor;
    }

    out.splice(end + 1, 0, ...block);
    return out;
}

/**
 * Appends confirmed board tokens, skipping any already present. Returns what
 * was actually added, which is what the caller should report.
 */
export async function appendCompanies(
    filePath: string,
    additions: readonly CompanyAddition[],
): Promise<CompanyAddition[]> {
    const existing = await loadCompanies(filePath);
    const known = new Set(
        (["greenhouse", "lever", "ashby"] as const).flatMap((board) =>
            existing[board].map((entry) => `${board}:${entry.token}`),
        ),
    );

    const fresh: CompanyAddition[] = [];
    for (const addition of additions) {
        const key = `${addition.board}:${addition.token}`;
        if (known.has(key)) continue;
        known.add(key);
        fresh.push(addition);
    }
    if (!fresh.length) return [];

    let raw = "";
    try {
        raw = await readFile(filePath, "utf8");
    } catch {
        // A missing file is written fresh, with only what we are adding.
    }

    let lines = raw ? raw.split("\n") : [];
    for (const board of ["greenhouse", "lever", "ashby"] as const) {
        const forBoard = fresh.filter((entry) => entry.board === board);
        if (!forBoard.length) continue;
        lines = insertUnderKey(lines, board, forBoard.flatMap(renderEntry));
    }

    const resolved = path.resolve(filePath);
    await mkdir(path.dirname(resolved), {recursive: true});
    await writeFile(resolved, `${lines.join("\n").replace(/\n+$/, "")}\n`, "utf8");
    return fresh;
}
