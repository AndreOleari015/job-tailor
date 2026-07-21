import pLimit from "p-limit";
import type {BoardEntry, BoardName} from "./companies.js";
import {applyQuery} from "./filter.js";
import type {HttpClient} from "./http.js";
import type {JobSource, RawPosting, SourceQuery} from "./types.js";

/** Per-company boards are fetched whole; three at a time is polite and enough. */
const TOKEN_CONCURRENCY = 3;

/**
 * The part of a board that differs: where its JSON lives and how to read it.
 * Everything else — iterating tokens, tolerating a failure, filtering — is the
 * same for all three, so it lives here once.
 */
export interface BoardAdapter {
    readonly name: BoardName;
    url(token: string): string;
    parse(payload: unknown, entry: BoardEntry, fetchedAt: string): RawPosting[];
}

export interface BoardDeps {
    http: HttpClient;
    entries: readonly BoardEntry[];
}

function warn(message: string): void {
    process.stderr.write(`[job-tailor] ${message}\n`);
}

export function createBoardSource(adapter: BoardAdapter, deps: BoardDeps): JobSource {
    const limit = pLimit(TOKEN_CONCURRENCY);

    async function fetchToken(entry: BoardEntry): Promise<RawPosting[]> {
        const payload = await deps.http.getJson<unknown>(adapter.url(entry.token), {
            label: `${adapter.name}:${entry.token}`,
        });
        return adapter.parse(payload, entry, new Date().toISOString());
    }

    return {
        name: adapter.name,
        requiresCredentials: false,
        kind: "board",

        async search(query: SourceQuery): Promise<RawPosting[]> {
            const perToken = await Promise.all(
                deps.entries.map((entry) =>
                    limit(async () => {
                        try {
                            return await fetchToken(entry);
                        } catch (error) {
                            // One dead token must not cost the whole search.
                            const reason = error instanceof Error ? error.message : String(error);
                            warn(`${adapter.name}:${entry.token} failed, skipping — ${reason}`);
                            return [] as RawPosting[];
                        }
                    }),
                ),
            );
            return applyQuery(perToken.flat(), query);
        },

        async fetchOne(sourceId: string): Promise<RawPosting> {
            const [, token] = sourceId.split(":");
            const entry =
                deps.entries.find((candidate) => candidate.token === token) ??
                (token ? {token} : undefined);
            if (!entry) throw new Error(`${sourceId} does not name a ${adapter.name} board`);

            const posting = (await fetchToken(entry)).find((one) => one.sourceId === sourceId);
            if (!posting) throw new Error(`${sourceId} is no longer listed on ${adapter.name}`);
            return posting;
        },
    };
}
