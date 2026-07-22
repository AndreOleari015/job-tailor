import {createBoardSource, type BoardAdapter, type BoardDeps} from "./board.js";
import type {BoardEntry} from "./companies.js";
import {detectLanguage} from "./language.js";
import {htmlToText, normaliseWhitespace, withHeader} from "./text.js";
import type {JobSource, RawPosting} from "./types.js";

interface LeverList {
    text?: string;
    content?: string;
}

interface LeverPosting {
    id?: string;
    text?: string;
    hostedUrl?: string;
    createdAt?: number;
    descriptionPlain?: string;
    description?: string;
    lists?: LeverList[];
    additionalPlain?: string;
    additional?: string;
    categories?: {location?: string; commitment?: string; team?: string};
    workplaceType?: string;
}

/**
 * Lever splits a posting into an intro, a set of titled lists (requirements,
 * benefits) and a closing note. Rejoining them in order is what makes the text
 * read like the posting a human sees.
 */
function fullDescription(posting: LeverPosting): string {
    const parts: string[] = [];

    const intro = posting.descriptionPlain?.trim() || htmlToText(posting.description ?? "");
    if (intro) parts.push(intro);

    for (const list of posting.lists ?? []) {
        const heading = list.text?.trim();
        const body = htmlToText(list.content ?? "");
        if (!heading && !body) continue;
        parts.push([heading, body].filter(Boolean).join("\n"));
    }

    const closing = posting.additionalPlain?.trim() || htmlToText(posting.additional ?? "");
    if (closing) parts.push(closing);

    return normaliseWhitespace(parts.join("\n\n"));
}

export const leverAdapter: BoardAdapter = {
    name: "lever",

    url(token: string): string {
        return `https://api.lever.co/v0/postings/${encodeURIComponent(token)}?mode=json`;
    },

    parse(payload: unknown, entry: BoardEntry, fetchedAt: string): RawPosting[] {
        const postings = Array.isArray(payload) ? (payload as LeverPosting[]) : [];

        return postings.flatMap((posting) => {
            if (!posting.id || !posting.text) return [];
            const description = fullDescription(posting);

            // Lever's payload never names the employer; the config does.
            const company = entry.label?.trim() || entry.token;
            const location = posting.categories?.location?.trim() || null;

            return [
                {
                    sourceId: `lever:${entry.token}:${posting.id}`,
                    source: "lever",
                    company,
                    title: posting.text.trim(),
                    location,
                    url: posting.hostedUrl ?? "",
                    postedAt: posting.createdAt
                        ? new Date(posting.createdAt).toISOString()
                        : null,
                    text: withHeader({company, location, description}),
                    language: detectLanguage(description, posting.text),
                    fetchedAt,
                },
            ];
        });
    },
};

export function createLeverSource(deps: BoardDeps): JobSource {
    return createBoardSource(leverAdapter, deps);
}
