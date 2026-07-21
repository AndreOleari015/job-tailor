#!/usr/bin/env node
import Anthropic from "@anthropic-ai/sdk";
import {Command} from "commander";
import {spawn} from "node:child_process";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import path from "node:path";
import {
    ConfigError,
    isDebug,
    isProviderName,
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
}

program
    .command("run")
    .description("Extract and tailor in one pass, writing both artefacts to output/.")
    .argument("[source]", "path to a job description file, or - for stdin")
    .option("--profile <path>", "path to the profile YAML", readProfilePath())
    .option("--out-dir <path>", "root directory for artefacts", readOutputDir())
    .option("--force", "generate and render the letter past the score and refusal checks")
    .option("--no-render", "write JSON only; skip the CV and cover-letter PDFs")
    .option("--open", "open the rendered CV with the OS default handler")
    .option(PROVIDER_FLAG, PROVIDER_HELP)
    .action(
        guarded(async (source: string | undefined, options: RunOptions) => {
            const jobText = await readJobText(source);
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

try {
    await program.parseAsync(process.argv);
} catch (error) {
    fail(error);
}
