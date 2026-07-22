import {mkdir, readFile, writeFile} from "node:fs/promises";
import path from "node:path";
import {readMinScore, readOutputDir, readProfilePath} from "../config.js";
import {extractJobSpec} from "../core/extract.js";
import {renderApplication, RenderBlockedError, type RenderResult} from "../core/render.js";
import {slugify} from "../core/slug.js";
import {applyMinScore, loadProfile, reconcile, tailorApplication} from "../core/tailor.js";
import {searchAll, type SearchAllOptions, type SearchAllResult} from "../sources/index.js";
import type {TrackerStore} from "../tracker/store.js";
import {
    jobSpecSchema,
    storedApplicationSchema,
    type JobSpec,
    type Profile,
    type TailoredApplication,
} from "../types.js";

/**
 * Everything the routes need from the rest of the program, behind one seam so
 * route tests can run the real orchestration without a model call or a browser.
 */
export interface Pipeline {
    loadProfile(profilePath: string): Promise<Profile>;
    extract(jobText: string): Promise<JobSpec>;
    tailor(profile: Profile, jobSpec: JobSpec): Promise<TailoredApplication>;
    render(input: {
        profile: Profile;
        jobSpec: JobSpec;
        application: TailoredApplication;
        outDir: string;
    }): Promise<RenderResult>;
    search(options: SearchAllOptions): Promise<SearchAllResult>;
}

export const defaultPipeline: Pipeline = {
    loadProfile,
    extract: (jobText) => extractJobSpec(jobText),
    tailor: (profile, jobSpec) => tailorApplication(profile, jobSpec),
    render: (input) => renderApplication(input),
    search: (options) => searchAll(options),
};

export interface PipelineContext {
    store: TrackerStore;
    pipeline: Pipeline;
    profilePath: string;
    outputRoot: string;
}

export function createContext(
    store: TrackerStore,
    overrides: Partial<Omit<PipelineContext, "store">> = {},
): PipelineContext {
    return {
        store,
        pipeline: overrides.pipeline ?? defaultPipeline,
        profilePath: overrides.profilePath ?? readProfilePath(),
        outputRoot: overrides.outputRoot ?? readOutputDir(),
    };
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
    await mkdir(path.dirname(filePath), {recursive: true});
    await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJson<T>(filePath: string): Promise<T> {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
}

export interface GenerationOutcome {
    outDir: string;
    jobSpec: JobSpec;
    application: TailoredApplication;
    cvPath: string | null;
    coverPath: string | null;
    /** Set when the renderer refused; the JSON is still on disk. */
    renderBlocked?: string;
}

/**
 * The full pipeline for one stored posting: extract, tailor, write the JSON,
 * render. Identical to what `run` does from the CLI, including the refusal —
 * a blocked render leaves the artefacts in place and reports why.
 */
export async function generateForPosting(
    context: PipelineContext,
    sourceId: string,
): Promise<GenerationOutcome> {
    const posting = context.store.getPosting(sourceId);
    if (!posting) throw new Error(`No posting with id "${sourceId}".`);
    if (!posting.rawText?.trim()) {
        throw new Error(`"${sourceId}" has no stored job text to generate from.`);
    }

    // Each stage is stamped as it starts, so the UI counts up from the step it
    // is actually on. Tailoring dwarfs the others, and saying so beats a
    // progress bar that would have to invent a percentage.
    context.store.setStage(sourceId, "extracting");
    const profile = await context.pipeline.loadProfile(context.profilePath);
    const jobSpec = await context.pipeline.extract(posting.rawText);

    const outDir = path.join(
        context.outputRoot,
        `${slugify(jobSpec.company)}-${slugify(jobSpec.role)}`,
    );

    context.store.setStage(sourceId, "tailoring");
    const tailored = await context.pipeline.tailor(profile, jobSpec);
    const application = applyMinScore(tailored, {minScore: readMinScore()});

    await writeJson(path.join(outDir, "job.json"), jobSpec);
    await writeJson(path.join(outDir, "application.json"), application);

    let cvPath: string | null = null;
    let coverPath: string | null = null;
    let renderBlocked: string | undefined;

    context.store.setStage(sourceId, "rendering");
    try {
        const rendered = await context.pipeline.render({profile, jobSpec, application, outDir});
        cvPath = rendered.cvPath;
        coverPath = rendered.coverPath;
    } catch (error) {
        // A refusal is a normal outcome for a flagged application, not a
        // failed generation: the JSON is the draft, and it is written.
        if (!(error instanceof RenderBlockedError)) throw error;
        renderBlocked = error.message;
    }

    context.store.recordGeneration(sourceId, {
        outDir,
        matchScore: application.match_score,
        flags: application.flags,
        gaps: application.gaps,
        country: jobSpec.country,
    });

    return {
        outDir,
        jobSpec,
        application,
        cvPath,
        coverPath,
        ...(renderBlocked ? {renderBlocked} : {}),
    };
}

export interface StoredArtefacts {
    jobSpec: JobSpec;
    application: TailoredApplication;
    outDir: string;
}

/** Reads a generated posting's artefacts through the looser stored schema. */
export async function readArtefacts(
    context: PipelineContext,
    sourceId: string,
): Promise<StoredArtefacts> {
    const posting = context.store.getPosting(sourceId);
    if (!posting?.outDir) throw new Error(`"${sourceId}" has not been generated yet.`);

    const jobSpec = jobSpecSchema.parse(await readJson(path.join(posting.outDir, "job.json")));
    // Not tailoredApplicationSchema: a skipped application has cover_letter "",
    // which the write schema rejects on purpose.
    const application = storedApplicationSchema.parse(
        await readJson(path.join(posting.outDir, "application.json")),
    );

    return {jobSpec, application, outDir: posting.outDir};
}

/**
 * The hand-edit loop: replace the letter, re-check it, re-render. No model call.
 *
 * The re-check matters. Flags describe the letter that is on disk now, and an
 * edit is exactly when they stop being true — a claim removed by hand should
 * clear its flag, and a claim introduced by hand must raise one. `reconcile()`
 * is pure, so recomputing costs nothing and keeps the flags honest.
 */
export async function saveCoverLetter(
    context: PipelineContext,
    sourceId: string,
    coverLetter: string,
): Promise<GenerationOutcome> {
    const {jobSpec, application, outDir} = await readArtefacts(context, sourceId);
    const profile = await context.pipeline.loadProfile(context.profilePath);

    const edited = reconcile({...application, cover_letter: coverLetter}, profile, jobSpec);
    await writeJson(path.join(outDir, "application.json"), edited);

    let cvPath: string | null = null;
    let coverPath: string | null = null;
    let renderBlocked: string | undefined;

    try {
        const rendered = await context.pipeline.render({
            profile,
            jobSpec,
            application: edited,
            outDir,
        });
        cvPath = rendered.cvPath;
        coverPath = rendered.coverPath;
    } catch (error) {
        if (!(error instanceof RenderBlockedError)) throw error;
        renderBlocked = error.message;
    }

    context.store.recordGeneration(sourceId, {
        outDir,
        matchScore: edited.match_score,
        flags: edited.flags,
        gaps: edited.gaps,
        country: jobSpec.country,
    });

    return {
        outDir,
        jobSpec,
        application: edited,
        cvPath,
        coverPath,
        ...(renderBlocked ? {renderBlocked} : {}),
    };
}
