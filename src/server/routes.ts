import type {FastifyInstance} from "fastify";
import {createReadStream} from "node:fs";
import {readdir, stat} from "node:fs/promises";
import path from "node:path";
import {
    isPostingLanguage,
    loadCompanies,
    type PostingLanguage,
    type ScoredPosting,
} from "../sources/index.js";
import {FLAG_INFO} from "../core/flags.js";
import {gmailStatus, runGmailFetch} from "./gmail.js";
import {isOutcome, isStatus, TrackerError} from "../tracker/store.js";
import {
    generateForPosting,
    readArtefacts,
    saveCoverLetter,
    type PipelineContext,
} from "./pipeline.js";
import type {GenerationQueue} from "./queue.js";

interface SearchBody {
    keywords?: string[];
    country?: string;
    /** One code, or several. "any" is expressed by leaving it out. */
    language?: string | string[];
    location?: string;
    remote?: boolean;
    postedWithinDays?: number;
    sources?: string[];
}

/** Only the two documents a generation produces may be served. */
const SERVABLE = new Set([".pdf", ".html"]);

/**
 * A filename from the URL must never be able to leave the output directory.
 * Checked twice: the name itself is rejected if it contains a separator or a
 * parent reference, and the resolved path is then proven to sit inside outDir.
 */
export function resolveArtefactPath(outDir: string, name: string): string | null {
    if (!name || name.includes("/") || name.includes("\\") || name.includes("..")) return null;
    if (path.isAbsolute(name)) return null;
    if (!SERVABLE.has(path.extname(name).toLowerCase())) return null;

    const root = path.resolve(outDir);
    const resolved = path.resolve(root, name);
    return resolved === root || resolved.startsWith(`${root}${path.sep}`) ? resolved : null;
}

const CONTENT_TYPES: Record<string, string> = {
    ".pdf": "application/pdf",
    ".html": "text/html; charset=utf-8",
};

export function registerRoutes(
    app: FastifyInstance,
    context: PipelineContext,
    queue: GenerationQueue,
): void {
    const {store} = context;

    app.get("/api/status", async () => {
        const {entries} = queue.status();
        const [running, ...waiting] = entries;

        // The stage and its clock come from the database, which the pipeline
        // stamps as it goes; the queue only knows what is running, not where
        // it has got to.
        const record = running ? store.getPosting(running.sourceId) : undefined;
        const startedAt = record?.stageStartedAt ? Date.parse(record.stageStartedAt) : NaN;

        return {
            running: running
                ? {
                      sourceId: running.sourceId,
                      company: running.company,
                      title: running.title,
                      stage: record?.stage ?? "queued",
                      stageStartedAt: record?.stageStartedAt ?? null,
                      elapsedMs: Number.isFinite(startedAt) ? Date.now() - startedAt : 0,
                  }
                : null,
            queue: waiting,
            queueLength: waiting.length,
        };
    });

    app.get("/api/stats", async () => store.stats());

    // The UI reads its flag wording from here rather than keeping a copy, so
    // the page and the terminal can never disagree about what a flag means.
    app.get("/api/flags", async () => FLAG_INFO);

    app.get("/api/gmail/status", async () => gmailStatus());

    app.post<{Body: {sinceDays?: number; max?: number}}>(
        "/api/gmail/fetch",
        async (request, reply) => {
            const body = request.body ?? {};
            try {
                const outcome = await runGmailFetch(store, {
                    ...(body.sinceDays !== undefined ? {sinceDays: body.sinceDays} : {}),
                    ...(body.max !== undefined ? {max: body.max} : {}),
                });
                return reply.send({
                    added: outcome.added,
                    leads: outcome.leads.length,
                    messagesRead: outcome.messagesRead,
                    unparsed: outcome.unparsed,
                    label: outcome.label,
                });
            } catch (error) {
                return reply
                    .code(400)
                    .send({error: error instanceof Error ? error.message : String(error)});
            }
        },
    );

    app.get("/api/sources", async () => {
        const companies = await loadCompanies();
        return {
            boards: companies,
            names: ["greenhouse", "lever", "ashby", "adzuna", "arbeitsagentur"],
        };
    });

    app.get<{
        Querystring: {
            status?: string;
            country?: string;
            language?: string;
            source?: string;
            q?: string;
        };
    }>(
        "/api/postings",
        async (request) => {
            const {status, country, language, source, q} = request.query;
            return store.listPostings({
                ...(status ? {status} : {}),
                ...(country ? {country} : {}),
                ...(language ? {language} : {}),
                ...(source ? {source} : {}),
                ...(q ? {q} : {}),
            });
        },
    );

    app.get<{Params: {id: string}}>("/api/postings/:id", async (request, reply) => {
        const posting = store.getPosting(request.params.id);
        if (!posting) return reply.code(404).send({error: "No such posting."});
        return posting;
    });

    /** Search never calls the model, so it is safe to run as often as you like. */
    app.post<{Body: SearchBody}>("/api/search", async (request, reply) => {
        const body = request.body ?? {};
        const profile = await context.pipeline.loadProfile(context.profilePath);

        // An unrecognised code filters nothing rather than silently emptying
        // the result — the same rule the CLI applies to an unknown --language.
        const languages = [body.language ?? []]
            .flat()
            .filter((code): code is PostingLanguage => isPostingLanguage(code));

        const result = await context.pipeline.search({
            query: {
                keywords: body.keywords ?? [],
                ...(body.location ? {location: body.location} : {}),
                ...(body.country ? {country: body.country} : {}),
                ...(body.remote ? {remote: true} : {}),
                ...(languages.length ? {languages} : {}),
                ...(body.postedWithinDays ? {postedWithinDays: body.postedWithinDays} : {}),
            },
            profile,
            ...(body.sources?.length ? {sources: body.sources} : {}),
        });

        const counts = store.upsertPostings(
            result.postings.map((posting: ScoredPosting) => ({
                sourceId: posting.sourceId,
                source: posting.source,
                company: posting.company,
                title: posting.title,
                location: posting.location,
                url: posting.url,
                postedAt: posting.postedAt,
                fetchedAt: posting.fetchedAt,
                text: posting.text,
                preScore: posting.preScore,
                language: posting.language,
            })),
        );

        return reply.send({...counts, warnings: result.warnings});
    });

    // The paste step: a lead's missing description arrives here, is stored, and
    // the lead becomes a `new` posting ready to generate. No model call.
    app.post<{Params: {id: string}; Body: {description?: string}}>(
        "/api/postings/:id/description",
        async (request, reply) => {
            const description = request.body?.description;
            if (typeof description !== "string" || !description.trim()) {
                return reply.code(400).send({error: "description must be a non-empty string."});
            }
            try {
                return reply.send(store.saveDescription(request.params.id, description));
            } catch (error) {
                const code = error instanceof TrackerError ? 409 : 404;
                return reply
                    .code(code)
                    .send({error: error instanceof Error ? error.message : String(error)});
            }
        },
    );

    app.post<{Params: {id: string}}>("/api/postings/:id/generate", async (request, reply) => {
        const id = request.params.id;
        const posting = store.getPosting(id);
        if (!posting) return reply.code(404).send({error: "No such posting."});
        if (posting.status === "lead") {
            return reply.code(409).send({
                error: "This is a lead with no job description yet. Paste the description first.",
            });
        }
        if (queue.isQueued(id)) return reply.code(409).send({error: "Already queued."});

        try {
            const outcome = await queue.enqueue(
                id,
                {company: posting.company, title: posting.title ?? id},
                () => {
                    // Only now, when its turn has actually come. A posting that
                    // is merely waiting stays `new`, so cancelling it is a
                    // matter of dropping it from the queue and nothing else.
                    store.setStatus(id, "generating");
                    return generateForPosting(context, id);
                },
            );
            return reply.send(outcome);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            store.recordFailure(id, message);
            return reply.code(500).send({error: message});
        }
    });

    app.post<{Params: {id: string}}>("/api/postings/:id/cancel", async (request, reply) => {
        const id = request.params.id;
        if (!store.getPosting(id)) return reply.code(404).send({error: "No such posting."});

        try {
            if (!queue.cancel(id)) {
                return reply.code(404).send({error: `"${id}" is not queued.`});
            }
        } catch (error) {
            // Already running: say so rather than pretending to stop a model
            // call that is already in flight.
            return reply
                .code(409)
                .send({error: error instanceof Error ? error.message : String(error)});
        }

        // It never left `new` — waiting in the queue is not a status — so there
        // is nothing to undo beyond removing it.
        return reply.send(store.getPosting(id));
    });

    app.get<{Params: {id: string}}>("/api/postings/:id/application", async (request, reply) => {
        try {
            return await readArtefacts(context, request.params.id);
        } catch (error) {
            return reply
                .code(404)
                .send({error: error instanceof Error ? error.message : String(error)});
        }
    });

    /** The hand-edit loop: re-checks and re-renders, never calls the model. */
    app.put<{Params: {id: string}; Body: {cover_letter?: string}}>(
        "/api/postings/:id/cover-letter",
        async (request, reply) => {
            const letter = request.body?.cover_letter;
            if (typeof letter !== "string") {
                return reply.code(400).send({error: "cover_letter must be a string."});
            }

            try {
                return await saveCoverLetter(context, request.params.id, letter);
            } catch (error) {
                return reply
                    .code(400)
                    .send({error: error instanceof Error ? error.message : String(error)});
            }
        },
    );

    app.post<{Params: {id: string}; Body: {status?: string}}>(
        "/api/postings/:id/status",
        async (request, reply) => {
            const status = request.body?.status ?? "";
            if (!isStatus(status)) {
                return reply.code(400).send({error: `"${status}" is not a status.`});
            }

            try {
                return store.setStatus(request.params.id, status);
            } catch (error) {
                const code = error instanceof TrackerError ? 409 : 500;
                return reply
                    .code(code)
                    .send({error: error instanceof Error ? error.message : String(error)});
            }
        },
    );

    app.post<{Params: {id: string}; Body: {outcome?: string | null}}>(
        "/api/postings/:id/outcome",
        async (request, reply) => {
            const raw = request.body?.outcome ?? null;
            if (raw !== null && !isOutcome(raw)) {
                return reply.code(400).send({error: `"${raw}" is not an outcome.`});
            }

            try {
                return store.setOutcome(request.params.id, raw);
            } catch (error) {
                const code = error instanceof TrackerError ? 409 : 500;
                return reply
                    .code(code)
                    .send({error: error instanceof Error ? error.message : String(error)});
            }
        },
    );

    app.post<{Params: {id: string}; Body: {notes?: string}}>(
        "/api/postings/:id/notes",
        async (request, reply) => {
            const notes = request.body?.notes;
            if (typeof notes !== "string") {
                return reply.code(400).send({error: "notes must be a string."});
            }

            try {
                return store.setNotes(request.params.id, notes);
            } catch (error) {
                return reply
                    .code(404)
                    .send({error: error instanceof Error ? error.message : String(error)});
            }
        },
    );

    /**
     * The documents that actually exist. The client must not have to guess
     * filenames — that would mean reimplementing the renderer's naming rule in
     * two places, and it would drift.
     */
    app.get<{Params: {id: string}}>("/api/postings/:id/files", async (request, reply) => {
        const posting = store.getPosting(request.params.id);
        if (!posting?.outDir) return reply.code(404).send({error: "Nothing generated yet."});

        let entries: string[];
        try {
            entries = await readdir(posting.outDir);
        } catch {
            return reply.send({files: []});
        }

        const files = entries
            .filter((name) => path.extname(name).toLowerCase() === ".pdf")
            .filter((name) => resolveArtefactPath(posting.outDir as string, name) !== null)
            .sort();

        return reply.send({files});
    });

    app.get<{Params: {id: string; name: string}}>(
        "/api/postings/:id/files/:name",
        async (request, reply) => {
            const posting = store.getPosting(request.params.id);
            if (!posting?.outDir) return reply.code(404).send({error: "Nothing generated yet."});

            const resolved = resolveArtefactPath(posting.outDir, request.params.name);
            if (!resolved) return reply.code(400).send({error: "Invalid file name."});

            try {
                await stat(resolved);
            } catch {
                return reply.code(404).send({error: "No such file."});
            }

            const type = CONTENT_TYPES[path.extname(resolved).toLowerCase()] ?? "application/octet-stream";
            return reply.type(type).send(createReadStream(resolved));
        },
    );
}
