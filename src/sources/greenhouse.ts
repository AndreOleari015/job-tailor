import {createBoardSource, type BoardAdapter, type BoardDeps} from "./board.js";
import type {BoardEntry} from "./companies.js";
import {detectLanguage} from "./language.js";
import {htmlToText, withHeader} from "./text.js";
import type {JobSource, RawPosting} from "./types.js";

interface GreenhouseJob {
    id?: number | string;
    title?: string;
    content?: string;
    absolute_url?: string;
    company_name?: string;
    updated_at?: string;
    first_published?: string;
    location?: {name?: string} | null;
}

interface GreenhouseBoard {
    jobs?: GreenhouseJob[];
}

export const greenhouseAdapter: BoardAdapter = {
    name: "greenhouse",

    url(token: string): string {
        return `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs?content=true`;
    },

    parse(payload: unknown, entry: BoardEntry, fetchedAt: string): RawPosting[] {
        const board = (payload ?? {}) as GreenhouseBoard;

        return (board.jobs ?? []).flatMap((job) => {
            const id = job.id;
            if (id === undefined || !job.title) return [];

            // Greenhouse ships the description as escaped HTML inside JSON.
            const description = htmlToText(job.content ?? "");
            const company = job.company_name?.trim() || entry.label?.trim() || entry.token;
            const location = job.location?.name?.trim() || null;

            return [
                {
                    sourceId: `greenhouse:${entry.token}:${id}`,
                    source: "greenhouse",
                    company,
                    title: job.title.trim(),
                    location,
                    url: job.absolute_url ?? "",
                    postedAt: job.first_published ?? job.updated_at ?? null,
                    text: withHeader({company, location, description}),
                    language: detectLanguage(description, job.title),
                    fetchedAt,
                },
            ];
        });
    },
};

export function createGreenhouseSource(deps: BoardDeps): JobSource {
    return createBoardSource(greenhouseAdapter, deps);
}
