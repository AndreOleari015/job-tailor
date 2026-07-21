#!/usr/bin/env node
import Anthropic from "@anthropic-ai/sdk";
import {Command} from "commander";
import {spawn} from "node:child_process";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import path from "node:path";
import {
    ConfigError,
    DEFAULT_SEARCH_LIMIT,
    isDebug,
    isProviderName,
    readAdzunaCredentials,
    readArbeitsagenturKey,
    readCompaniesPath,
    readJobsDir,
    readMinScore,
    readOutputDir,
    readPreScoreMin,
    readProfilePath,
    resolveModel,
    resolveProviderName,
    setProviderOverride,
    type Task,
} from "./config.js";
import {extractJobSpec} from "./core/extract.js";
import {preScore} from "./core/match.js";
import {RenderBlockedError, renderApplication} from "./core/render.js";
import {slugify} from "./core/slug.js";
import {applyMinScore, loadProfile, tailorApplication} from "./core/tailor.js";
import {rebaseTranscript} from "./llm/client.js";
import {DEFAULT_PORT, startServer} from "./server/index.js";
import {openStore} from "./tracker/store.js";
import {
    buildSources,
    fetchPosting,
    isSourceName,
    loadCompanies,
    PostingCache,
    searchAll,
    SOURCE_NAMES,
    type RawPosting,
    type ScoredPosting,
} from "./sources/index.js";
import {
    flags,
    jobSpecSchema,
    storedApplicationSchema,
    type JobSpec,
    type Profile,
    type TailoredApplication,
} from "./types.js";

const STDIN_MARKERS = new Set(["-", "--", "/dev/stdin"]);

/* ------------------------------------------------------------------ */
/* I/O helpers                                                          */
/* ------------------------------------------------------------------ */

async function readStdin(): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString("utf8");
}

async function readTextFile(filePath: string): Promise<string> {
    try {
        return await readFile(path.resolve(filePath), "utf8");
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`Could not read "${filePath}": ${reason}`);
    }
}

/** Resolves a `<file|->` argument to text, falling back to stdin. */
async function readJobText(source: string | undefined): Promise<string> {
    if (source && !STDIN_MARKERS.has(source)) return readTextFile(source);

    if (process.stdin.isTTY) {
        throw new Error(
            "No job description given. Pass a file path, or pipe the text on stdin " +
                "(job-tailor extract - < job.txt).",
        );
    }
    return readStdin();
}

async function readJobSpecFile(filePath: string): Promise<JobSpec> {
    const raw = await readTextFile(filePath);

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`"${filePath}" is not valid JSON: ${reason}`);
    }

    const result = jobSpecSchema.safeParse(parsed);
    if (!result.success) {
        const issues = result.error.issues
            .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
            .join("\n");
        throw new Error(`"${filePath}" does not match the JobSpec schema:\n${issues}`);
    }
    return result.data;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
    const resolved = path.resolve(filePath);
    await mkdir(path.dirname(resolved), {recursive: true});
    await writeFile(resolved, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readStoredApplication(filePath: string): Promise<TailoredApplication> {
    const raw = await readTextFile(filePath);
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`"${filePath}" is not valid JSON: ${reason}`);
    }

    // The stored schema tolerates a blanked cover letter; the write schema does not.
    const result = storedApplicationSchema.safeParse(parsed);
    if (!result.success) {
        const issues = result.error.issues
            .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
            .join("\n");
        throw new Error(`"${filePath}" does not match the application schema:\n${issues}`);
    }
    return result.data;
}

/** Opens a file with the OS default handler. A no-op on an unrecognised platform. */
function openInDefaultApp(filePath: string): void {
    const opener =
        process.platform === "darwin"
            ? "open"
            : process.platform === "win32"
              ? "start"
              : process.platform === "linux"
                ? "xdg-open"
                : undefined;
    if (!opener) {
        note(`--open is not supported on ${process.platform}; skipping.`);
        return;
    }
    const child = spawn(opener, [filePath], {
        stdio: "ignore",
        detached: true,
        shell: process.platform === "win32",
    });
    child.on("error", () => note(`Could not open ${filePath} automatically.`));
    child.unref();
}

/* ------------------------------------------------------------------ */
/* Output                                                               */
/* ------------------------------------------------------------------ */

function printJson(value: unknown): void {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function note(message: string): void {
    process.stderr.write(`${message}\n`);
}

/** An unnamed employer costs the letter its opening paragraph. */
function noteUnknownCompany(jobSpec: JobSpec): void {
    if (jobSpec.company.trim().toLowerCase() !== "unknown") return;
    note(
        "[job-tailor] company not detected — add a 'Company: <name>' line at the top " +
            "of the job file for a stronger opening paragraph.",
    );
}

function label(text: string): string {
    return `${text}:`.padEnd(13);
}

/**
 * The provider and models a set of tasks will use. Pure resolution, so it
 * reports exactly what `callJson` will pick without needing an API key.
 */
function describeProvider(tasks: Task[]): string {
    const provider = resolveProviderName();
    const pairs = tasks.map((task) => [task, resolveModel(provider, task)] as const);
    const models = new Set(pairs.map(([, model]) => model));

    if (models.size === 1) return `${provider} / ${[...models][0]}`;
    return `${provider} / ${pairs.map(([task, model]) => `${task}: ${model}`).join(", ")}`;
}

function printSummary(jobSpec: JobSpec, application: TailoredApplication, outDir: string): void {
    const lines = [
        `${label("Company")}${jobSpec.company}`,
        `${label("Role")}${jobSpec.role}`,
        `${label("Match score")}${Math.round(application.match_score)}/100`,
        `${label("Flags")}${application.flags.length ? application.flags.join(", ") : "(none)"}`,
        `${label("Provider")}${describeProvider(["extract", "tailor"])}`,
    ];

    if (application.gaps.length) {
        lines.push("Gaps:");
        for (const gap of application.gaps) lines.push(`  - ${gap}`);
    } else {
        lines.push(`${label("Gaps")}(none)`);
    }

    lines.push(`${label("Written to")}${outDir}`);
    process.stdout.write(`${lines.join("\n")}\n`);
}

function printPreScoreSkip(
    jobSpec: JobSpec,
    pre: {score: number; matchedTerms: string[]; missingTerms: string[]},
    threshold: number,
    outDir: string,
): void {
    const lines = [
        `${label("Company")}${jobSpec.company}`,
        `${label("Role")}${jobSpec.role}`,
        `${label("Pre-score")}${pre.score}/100 (threshold ${threshold})`,
        `${label("Matched")}${pre.matchedTerms.length ? pre.matchedTerms.join(", ") : "(none)"}`,
        `${label("Missing")}${pre.missingTerms.length ? pre.missingTerms.join(", ") : "(none)"}`,
        `${label("Written to")}${outDir}`,
        "",
        `Skipped before tailoring: pre-score ${pre.score}/100. Re-run with --force.`,
    ];
    process.stdout.write(`${lines.join("\n")}\n`);
}

/* ------------------------------------------------------------------ */
/* Sources                                                              */
/* ------------------------------------------------------------------ */

function truncate(value: string, width: number): string {
    return value.length <= width ? value.padEnd(width) : `${value.slice(0, width - 1)}…`;
}

function printSearchTable(postings: readonly ScoredPosting[]): void {
    if (!postings.length) {
        process.stdout.write("No postings matched.\n");
        return;
    }

    const header = [
        "  #".padEnd(4),
        truncate("COMPANY", 22),
        truncate("TITLE", 40),
        truncate("LOCATION", 22),
        truncate("SOURCE", 15),
        "PRE",
    ].join("  ");
    const lines = [header, "-".repeat(header.length)];

    postings.forEach((posting, index) => {
        lines.push(
            [
                String(index + 1).padStart(3).padEnd(4),
                truncate(posting.company ?? "(unknown)", 22),
                truncate(posting.title, 40),
                truncate(posting.location ?? "—", 22),
                truncate(posting.textTruncated ? `${posting.source}*` : posting.source, 15),
                (posting.preScore === null ? "—" : String(posting.preScore)).padStart(3),
            ].join("  "),
        );
    });

    if (postings.some((posting) => posting.textTruncated)) {
        lines.push("", "* description is truncated at the source; pull it and read before tailoring.");
    }
    lines.push("", "Pre-score is a keyword hint for ordering only, not the model's match score.");
    process.stdout.write(`${lines.join("\n")}\n`);
}

/**
 * Records a pulled posting in the tracker, so a posting reached from the CLI
 * and one reached from the web UI are the same row in one database.
 */
function trackPosting(posting: RawPosting): void {
    const store = openStore();
    try {
        store.upsertPostings([
            {
                sourceId: posting.sourceId,
                source: posting.source,
                company: posting.company,
                title: posting.title,
                location: posting.location,
                url: posting.url,
                postedAt: posting.postedAt,
                fetchedAt: posting.fetchedAt,
                text: posting.text,
            },
        ]);
    } finally {
        store.close();
    }
}

/** Writes a posting in the exact plain-text shape a pasted job file has. */
async function writePostingFile(posting: RawPosting): Promise<string> {
    const name = `${slugify(posting.company ?? "unknown")}-${slugify(posting.title)}.txt`;
    const filePath = path.join(readJobsDir(), name);
    const resolved = path.resolve(filePath);

    await mkdir(path.dirname(resolved), {recursive: true});
    await writeFile(resolved, posting.text, "utf8");
    return filePath;
}

/** A shortened description hides requirements; say so before the model reads it. */
function warnIfTruncated(posting: RawPosting): void {
    if (!posting.textTruncated) return;
    note(
        `[job-tailor] ${posting.source} returns a truncated description. Tailoring from it ` +
            `reads requirements that are not all there — open ${posting.url} and paste the ` +
            "full text for anything you intend to send.",
    );
}

/** Resolves a `pull` argument: a source id, or a 1-based index from the last search. */
function resolveSourceId(reference: string, cache: PostingCache): string {
    const trimmed = reference.trim();
    if (/^\d+$/.test(trimmed)) {
        const sourceId = cache.fromLastSearch(Number(trimmed));
        if (!sourceId) {
            throw new Error(
                `No posting at index ${trimmed} in the last search. Run \`job-tailor search\` first.`,
            );
        }
        return sourceId;
    }
    return trimmed;
}

interface RenderTarget {
    profile: Profile;
    jobSpec: JobSpec;
    application: TailoredApplication;
    outDir: string;
    force?: boolean;
}

/**
 * Renders, returning the paths, or null when the refusal fired. A blocked
 * render is a normal outcome — a flagged draft is not printable — so it prints
 * the reason and does not abort the surrounding command.
 */
async function renderAndReport(
    target: RenderTarget,
): Promise<{cvPath: string; coverPath: string | null} | null> {
    try {
        return await renderApplication(target);
    } catch (error) {
        if (error instanceof RenderBlockedError) {
            note(`[job-tailor] ${error.message}`);
            return null;
        }
        throw error;
    }
}

function reportRenderPaths(rendered: {cvPath: string; coverPath: string | null}): void {
    process.stdout.write(`${label("CV")}${rendered.cvPath}\n`);
    process.stdout.write(
        `${label("Cover letter")}${rendered.coverPath ?? "(not rendered)"}\n`,
    );
}

/* ------------------------------------------------------------------ */
/* Error handling                                                       */
/* ------------------------------------------------------------------ */

function describe(error: unknown): string {
    if (error instanceof Anthropic.AuthenticationError) {
        return "Anthropic rejected the API key. Check ANTHROPIC_API_KEY in your .env.";
    }
    if (error instanceof Anthropic.RateLimitError) {
        return "Rate limited by the Anthropic API. Wait a moment and try again.";
    }
    if (error instanceof Anthropic.APIConnectionError) {
        return "Could not reach the Anthropic API. Check your network connection.";
    }
    if (error instanceof Anthropic.NotFoundError) {
        return "Model not found. Check JOB_TAILOR_MODEL.";
    }
    return error instanceof Error ? error.message : String(error);
}

function fail(error: unknown): never {
    if (isDebug() && error instanceof Error && error.stack) {
        process.stderr.write(`${error.stack}\n`);
    } else {
        process.stderr.write(`job-tailor: ${describe(error)}\n`);
    }
    process.exit(1);
}

function guarded<A extends unknown[]>(
    action: (...args: A) => Promise<void>,
): (...args: A) => Promise<void> {
    return async (...args: A) => {
        try {
            await action(...args);
        } catch (error) {
            fail(error);
        }
    };
}

/* ------------------------------------------------------------------ */
/* Commands                                                             */
/* ------------------------------------------------------------------ */

const PROVIDER_FLAG = "--provider <name>";
const PROVIDER_HELP = "anthropic | gemini, overriding JOB_TAILOR_PROVIDER for this run";

const program = new Command();

program
    .name("job-tailor")
    .description("Tailors a CV and cover letter to a specific job description.")
    .version("0.1.0")
    .option(PROVIDER_FLAG, PROVIDER_HELP)
    .showHelpAfterError();

// Accepted before or after the subcommand; the subcommand's value wins.
program.hook("preAction", (thisCommand, actionCommand) => {
    const raw = (actionCommand.opts().provider ?? thisCommand.opts().provider) as
        | string
        | undefined;
    if (!raw) return;
    if (!isProviderName(raw)) {
        throw new ConfigError(`--provider must be "anthropic" or "gemini", got "${raw}".`);
    }
    setProviderOverride(raw);
});

program
    .command("extract")
    .description("Parse a job description into a structured JobSpec.")
    .argument("[source]", "path to a job description file, or - for stdin")
    .option("--out <path>", "also write the JobSpec to this file")
    .option(PROVIDER_FLAG, PROVIDER_HELP)
    .action(
        guarded(async (source: string | undefined, options: {out?: string}) => {
            note(`Using ${describeProvider(["extract"])}`);
            const jobSpec = await extractJobSpec(await readJobText(source));
            noteUnknownCompany(jobSpec);
            printJson(jobSpec);
            if (options.out) {
                await writeJson(options.out, jobSpec);
                note(`Wrote ${options.out}`);
            }
        }),
    );

program
    .command("tailor")
    .description("Tailor the profile to an existing JobSpec.")
    .argument("<jobspec>", "path to a jobspec.json produced by `extract`")
    .option("--profile <path>", "path to the profile YAML", readProfilePath())
    .option("--out <path>", "also write the TailoredApplication to this file")
    .option(PROVIDER_FLAG, PROVIDER_HELP)
    .action(
        guarded(async (jobspec: string, options: {profile: string; out?: string}) => {
            note(`Using ${describeProvider(["tailor"])}`);
            const [profile, jobSpec] = await Promise.all([
                loadProfile(options.profile),
                readJobSpecFile(jobspec),
            ]);
            const application = await tailorApplication(profile, jobSpec);
            printJson(application);
            if (options.out) {
                await writeJson(options.out, application);
                note(`Wrote ${options.out}`);
            }
        }),
    );

interface RunOptions {
    profile: string;
    outDir: string;
    force?: boolean;
    render: boolean;
    open?: boolean;
    from?: string;
}

/**
 * The job text for a run: pulled from a source when --from is given, otherwise
 * read from a file or stdin. A pulled posting is written to jobs/ first, so the
 * input to every run is a file on disk either way.
 */
async function resolveRunInput(
    source: string | undefined,
    from: string | undefined,
): Promise<string> {
    if (!from) return readJobText(source);

    const cache = await PostingCache.open();
    const posting = await fetchPosting(resolveSourceId(from, cache), {cache});

    warnIfTruncated(posting);
    note(`Pulled ${posting.sourceId} to ${await writePostingFile(posting)}`);
    return posting.text;
}

program
    .command("run")
    .description("Extract and tailor in one pass, writing both artefacts to output/.")
    .argument("[source]", "path to a job description file, or - for stdin")
    .option("--profile <path>", "path to the profile YAML", readProfilePath())
    .option("--out-dir <path>", "root directory for artefacts", readOutputDir())
    .option("--from <sourceId>", "pull a posting from a source instead of reading a file")
    .option("--force", "generate and render the letter past the score and refusal checks")
    .option("--no-render", "write JSON only; skip the CV and cover-letter PDFs")
    .option("--open", "open the rendered CV with the OS default handler")
    .option(PROVIDER_FLAG, PROVIDER_HELP)
    .action(
        guarded(async (source: string | undefined, options: RunOptions) => {
            const jobText = await resolveRunInput(source, options.from);
            const profile = await loadProfile(options.profile);

            const jobSpec = await extractJobSpec(jobText);
            noteUnknownCompany(jobSpec);
            const outDir = path.join(
                options.outDir,
                `${slugify(jobSpec.company)}-${slugify(jobSpec.role)}`,
            );

            // The slug only exists now, so move extraction's DEBUG transcript
            // under it before tailoring writes its own.
            await rebaseTranscript(path.join(outDir, "debug"));

            // The deterministic pre-filter: skip an obviously irrelevant posting
            // before spending the tailoring call. Disabled (0) by default.
            const preScoreMin = readPreScoreMin();
            if (preScoreMin > 0 && !options.force) {
                const pre = preScore(profile, jobSpec);
                if (pre.score < preScoreMin) {
                    await writeJson(path.join(outDir, "job.json"), jobSpec);
                    printPreScoreSkip(jobSpec, pre, preScoreMin, outDir);
                    return;
                }
            }

            const tailored = await tailorApplication(profile, jobSpec);
            const application = applyMinScore(tailored, {
                minScore: readMinScore(),
                force: options.force,
            });
            const skipped = application.flags.includes(flags.skippedLowMatch);

            await writeJson(path.join(outDir, "job.json"), jobSpec);
            await writeJson(path.join(outDir, "application.json"), application);

            const rendered =
                options.render &&
                (await renderAndReport({profile, jobSpec, application, outDir, force: options.force}));

            printSummary(jobSpec, application, outDir);
            if (rendered) reportRenderPaths(rendered);
            if (skipped) {
                process.stdout.write(
                    `\nSkipped: match below threshold (${Math.round(tailored.match_score)}/100). ` +
                        "Re-run with --force to generate anyway.\n",
                );
            }
            if (options.open && rendered) openInDefaultApp(rendered.cvPath);
        }),
    );

program
    .command("render")
    .description("Re-render the CV and cover letter from a directory's job.json and application.json.")
    .argument("<dir>", "an output directory produced by `run`")
    .option("--profile <path>", "path to the profile YAML", readProfilePath())
    .option("--force", "render past the refusal checks, stamping a draft watermark")
    .option("--open", "open the rendered CV with the OS default handler")
    .action(
        guarded(
            async (
                dir: string,
                options: {profile: string; force?: boolean; open?: boolean},
            ) => {
                const [profile, jobSpec, application] = await Promise.all([
                    loadProfile(options.profile),
                    readJobSpecFile(path.join(dir, "job.json")),
                    readStoredApplication(path.join(dir, "application.json")),
                ]);

                const rendered = await renderAndReport({
                    profile,
                    jobSpec,
                    application,
                    outDir: dir,
                    force: options.force,
                });
                if (!rendered) return;

                reportRenderPaths(rendered);
                if (options.open) openInDefaultApp(rendered.cvPath);
            },
        ),
    );

interface SearchOptions {
    source?: string[];
    country?: string;
    location?: string;
    remote?: boolean;
    postedWithin?: string;
    limit: string;
    refresh?: boolean;
    json?: boolean;
    profile: string;
}

program
    .command("search")
    .description("Search the configured job sources. Never calls the model, so it is free.")
    .argument("[keywords...]", "words that must appear in the title or description")
    .option(
        "--source <name>",
        "restrict to a source; repeatable",
        (value: string, previous: string[] = []) => {
            if (!isSourceName(value)) {
                throw new ConfigError(
                    `--source must be one of ${SOURCE_NAMES.join(", ")}, got "${value}".`,
                );
            }
            return [...previous, value];
        },
    )
    .option("--country <code>", "ISO 3166-1 alpha-2, for the aggregator sources")
    .option("--location <string>", "match postings whose location contains this")
    .option("--remote", "prefer remote postings where the source supports it")
    .option("--posted-within <days>", "only postings published in the last N days")
    .option("--limit <n>", "maximum rows", String(DEFAULT_SEARCH_LIMIT))
    .option("--refresh", "ignore the cache and refetch everything")
    .option("--json", "machine-readable output")
    .option("--profile <path>", "path to the profile YAML", readProfilePath())
    .action(
        guarded(async (keywords: string[], options: SearchOptions) => {
            const profile = await loadProfile(options.profile);
            const cache = await PostingCache.open();

            const result = await searchAll({
                query: {
                    keywords,
                    ...(options.location ? {location: options.location} : {}),
                    ...(options.country ? {country: options.country} : {}),
                    ...(options.remote ? {remote: true} : {}),
                    ...(options.postedWithin
                        ? {postedWithinDays: Number(options.postedWithin)}
                        : {}),
                },
                profile,
                sources: options.source ?? [],
                limit: Number(options.limit),
                ...(options.refresh ? {refresh: true} : {}),
                cache,
                registry: {companies: await loadCompanies(readCompaniesPath())},
            });

            // Remember the printed order so `pull 3` means the third row.
            cache.rememberSearch(result.postings.map((posting) => posting.sourceId));
            await cache.save();

            for (const warning of result.warnings) note(`[job-tailor] ${warning}`);

            if (options.json) {
                printJson(result.postings);
                return;
            }
            printSearchTable(result.postings);
        }),
    );

program
    .command("pull")
    .description("Write a posting from the last search to a job file, ready for `run`.")
    .argument("<reference>", "a sourceId, or the index from the last search")
    .action(
        guarded(async (reference: string) => {
            const cache = await PostingCache.open();
            const posting = await fetchPosting(resolveSourceId(reference, cache), {cache});

            warnIfTruncated(posting);
            trackPosting(posting);
            const filePath = await writePostingFile(posting);
            process.stdout.write(`${filePath}\n`);
        }),
    );

program
    .command("serve")
    .description("Start the local web interface on 127.0.0.1.")
    .option("--port <n>", "port to listen on", String(DEFAULT_PORT))
    .option("--open", "open the browser at the served URL")
    .action(
        guarded(async (options: {port: string; open?: boolean}) => {
            const store = openStore();
            const {url} = await startServer({store, port: Number(options.port)});

            process.stdout.write(
                `${url}\n\n` +
                    "Bound to loopback with no authentication — do not put it behind a proxy.\n" +
                    "Generation runs one at a time. Nothing is ever submitted for you.\n",
            );
            if (options.open) openInDefaultApp(url);
        }),
    );

program
    .command("stats")
    .description("Print the tracker's counts and the gaps that come up most often.")
    .action(
        guarded(async () => {
            const store = openStore();
            try {
                const stats = store.stats();
                const lines = [`${label("Postings")}${stats.total}`];

                for (const [status, count] of Object.entries(stats.byStatus)) {
                    lines.push(`  ${status.padEnd(12)}${count}`);
                }

                if (Object.keys(stats.byOutcome).length) {
                    lines.push("", "Outcomes:");
                    for (const [outcome, count] of Object.entries(stats.byOutcome)) {
                        lines.push(`  ${outcome.padEnd(12)}${count}`);
                    }
                }

                if (stats.topGaps.length) {
                    lines.push("", "Most frequent gaps:");
                    for (const {gap, count} of stats.topGaps) {
                        lines.push(`  ${String(count).padStart(3)}x  ${gap}`);
                    }
                }

                process.stdout.write(`${lines.join("\n")}\n`);
            } finally {
                store.close();
            }
        }),
    );

program
    .command("sources")
    .description("List the configured sources and whether each one can run.")
    .action(
        guarded(async () => {
            const companies = await loadCompanies(readCompaniesPath());
            const sources = await buildSources({companies});

            const available: Record<string, boolean> = {
                adzuna: Boolean(readAdzunaCredentials()),
                arbeitsagentur: Boolean(readArbeitsagenturKey()),
            };

            const lines: string[] = [];
            for (const source of sources) {
                const ready = available[source.name] ?? true;
                const status = ready ? "ready" : "needs credentials";
                lines.push(`${source.name.padEnd(16)}${source.kind.padEnd(12)}${status}`);

                const entries =
                    source.name === "greenhouse"
                        ? companies.greenhouse
                        : source.name === "lever"
                          ? companies.lever
                          : source.name === "ashby"
                            ? companies.ashby
                            : [];
                for (const entry of entries) {
                    lines.push(`  - ${entry.label ?? entry.token} (${entry.token})`);
                }
                if (source.kind === "board" && !entries.length) {
                    lines.push(`  (no tokens configured in ${readCompaniesPath()})`);
                }
            }

            lines.push(
                "",
                "Only documented public APIs are used. Sites whose terms prohibit automated",
                "access are deliberately not implemented.",
            );
            process.stdout.write(`${lines.join("\n")}\n`);
        }),
    );

try {
    await program.parseAsync(process.argv);
} catch (error) {
    fail(error);
}
