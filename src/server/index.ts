import fastifyStatic from "@fastify/static";
import Fastify, {type FastifyInstance} from "fastify";
import path from "node:path";
import {fileURLToPath} from "node:url";
import type {TrackerStore} from "../tracker/store.js";
import {createContext, type Pipeline} from "./pipeline.js";
import {GenerationQueue} from "./queue.js";
import {registerRoutes} from "./routes.js";

export const DEFAULT_PORT = 4321;

/**
 * Loopback only, never 0.0.0.0. There is no authentication, and the bind
 * address is what stands in for it: the UI reads your profile, your postings
 * and your generated letters, none of which belong on a network interface.
 */
export const HOST = "127.0.0.1";

const PUBLIC_DIR = fileURLToPath(new URL("./public/", import.meta.url));

export interface ServerOptions {
    store: TrackerStore;
    pipeline?: Pipeline;
    profilePath?: string;
    outputRoot?: string;
    /** Serve the static UI. Off in tests, which only exercise the API. */
    serveStatic?: boolean;
    logger?: boolean;
}

export async function createServer(options: ServerOptions): Promise<FastifyInstance> {
    const app = Fastify({logger: options.logger ?? false});

    // Several routes take no body at all. Fastify's default JSON parser rejects
    // an empty one outright, which turns a legitimate "just do it" POST into a
    // 400 before any handler sees it. Treat empty as {}.
    app.addContentTypeParser(
        "application/json",
        {parseAs: "string"},
        (_request, body: string, done) => {
            if (!body || !body.trim()) return done(null, {});
            try {
                done(null, JSON.parse(body) as unknown);
            } catch {
                // Malformed JSON is the client's mistake, not the server's.
                const failure = Object.assign(new Error("Body is not valid JSON."), {
                    statusCode: 400,
                });
                done(failure, undefined);
            }
        },
    );

    const context = createContext(options.store, {
        ...(options.pipeline ? {pipeline: options.pipeline} : {}),
        ...(options.profilePath ? {profilePath: options.profilePath} : {}),
        ...(options.outputRoot ? {outputRoot: options.outputRoot} : {}),
    });

    // The queue is in memory, so a process that stopped mid-generation left
    // rows in `generating` with nothing behind them. `generating` only exits
    // via the run that died, so they would be stranded there permanently.
    const stranded = options.store.resetInterruptedGenerations();
    if (stranded) {
        process.stderr.write(
            `[job-tailor] reset ${stranded} posting${stranded === 1 ? "" : "s"} left ` +
                "generating by a previous run\n",
        );
    }

    registerRoutes(app, context, new GenerationQueue());

    if (options.serveStatic ?? true) {
        await app.register(fastifyStatic, {root: PUBLIC_DIR, index: ["index.html"]});
    }

    return app;
}

export interface ServeOptions extends ServerOptions {
    port?: number;
}

export async function startServer(options: ServeOptions): Promise<{app: FastifyInstance; url: string}> {
    const app = await createServer(options);
    const port = options.port ?? DEFAULT_PORT;

    await app.listen({host: HOST, port});
    return {app, url: `http://${HOST}:${port}`};
}

export {GenerationQueue} from "./queue.js";
export {defaultPipeline, type Pipeline} from "./pipeline.js";
