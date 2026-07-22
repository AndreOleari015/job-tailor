import {createBoardSource, type BoardAdapter, type BoardDeps} from "./board.js";
import type {BoardEntry} from "./companies.js";
import {detectLanguage} from "./language.js";
import {htmlToText, normaliseWhitespace, withHeader} from "./text.js";
import type {JobSource, RawPosting} from "./types.js";

interface AshbyJob {
    id?: string;
    title?: string;
    location?: string;
    secondaryLocations?: {location?: string}[];
    publishedAt?: string;
    jobUrl?: string;
    descriptionPlain?: string;
    descriptionHtml?: string;
    isListed?: boolean;
    isRemote?: boolean;
    employmentType?: string;
}

interface AshbyBoard {
    jobs?: AshbyJob[];
}

/** Primary location plus any secondaries, which Ashby lists separately. */
function locationOf(job: AshbyJob): string | null {
    const all = [job.location, ...(job.secondaryLocations ?? []).map((one) => one.location)]
        .map((one) => one?.trim())
        .filter((one): one is string => Boolean(one));

    const unique = [...new Set(all)];
    return unique.length ? unique.join(", ") : null;
}

export const ashbyAdapter: BoardAdapter = {
    name: "ashby",

    url(token: string): string {
        return `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(token)}?includeCompensation=true`;
    },

    parse(payload: unknown, entry: BoardEntry, fetchedAt: string): RawPosting[] {
        const board = (payload ?? {}) as AshbyBoard;

        return (board.jobs ?? []).flatMap((job) => {
            if (!job.id || !job.title) return [];
            // A job Ashby has unlisted is not open; do not surface it.
            if (job.isListed === false) return [];

            const company = entry.label?.trim() || entry.token;
            const location = locationOf(job);
            const description = job.descriptionPlain?.trim()
                ? normaliseWhitespace(job.descriptionPlain)
                : htmlToText(job.descriptionHtml ?? "");

            return [
                {
                    sourceId: `ashby:${entry.token}:${job.id}`,
                    source: "ashby",
                    company,
                    title: job.title.trim(),
                    location,
                    url: job.jobUrl ?? "",
                    postedAt: job.publishedAt ?? null,
                    text: withHeader({company, location, description}),
                    language: detectLanguage(description, job.title),
                    fetchedAt,
                },
            ];
        });
    },
};

export function createAshbySource(deps: BoardDeps): JobSource {
    return createBoardSource(ashbyAdapter, deps);
}
