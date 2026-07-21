import {applyQuery} from "./filter.js";
import type {HttpClient} from "./http.js";
import {normaliseWhitespace, withHeader} from "./text.js";
import {SourceUnavailableError, type JobSource, type RawPosting, type SourceQuery} from "./types.js";

const RESULTS_PER_PAGE = 50;
const DEFAULT_COUNTRY = "gb";

interface AdzunaResult {
    id?: string;
    title?: string;
    description?: string;
    redirect_url?: string;
    created?: string;
    company?: {display_name?: string};
    location?: {display_name?: string};
}

interface AdzunaResponse {
    results?: AdzunaResult[];
}

export interface AdzunaCredentials {
    appId: string;
    appKey: string;
}

export interface AdzunaDeps {
    http: HttpClient;
    credentials?: AdzunaCredentials | undefined;
}

function buildUrl(query: SourceQuery, credentials: AdzunaCredentials): string {
    const country = (query.country ?? DEFAULT_COUNTRY).toLowerCase();
    const params = new URLSearchParams({
        app_id: credentials.appId,
        app_key: credentials.appKey,
        results_per_page: String(RESULTS_PER_PAGE),
        "content-type": "application/json",
    });

    if (query.keywords.length) params.set("what", query.keywords.join(" "));
    if (query.location?.trim()) params.set("where", query.location.trim());
    if (query.postedWithinDays) params.set("max_days_old", String(query.postedWithinDays));

    return `https://api.adzuna.com/v1/api/jobs/${encodeURIComponent(country)}/search/1?${params}`;
}

/**
 * Adzuna indexes many boards but returns a shortened description, so every
 * posting is marked `textTruncated`. Tailoring from a partial posting reads
 * requirements that are not all there, which the CLI warns about rather than
 * letting it pass as a complete one.
 */
export function createAdzunaSource(deps: AdzunaDeps): JobSource {
    return {
        name: "adzuna",
        requiresCredentials: true,
        kind: "aggregator",

        async search(query: SourceQuery): Promise<RawPosting[]> {
            if (!deps.credentials) {
                throw new SourceUnavailableError(
                    "adzuna",
                    "adzuna needs ADZUNA_APP_ID and ADZUNA_APP_KEY in your .env; skipping it.",
                );
            }

            const payload = await deps.http.getJson<AdzunaResponse>(
                buildUrl(query, deps.credentials),
                {label: "adzuna"},
            );

            const fetchedAt = new Date().toISOString();
            const postings = (payload.results ?? []).flatMap((result): RawPosting[] => {
                if (!result.id || !result.title) return [];

                const company = result.company?.display_name?.trim() || null;
                const location = result.location?.display_name?.trim() || null;

                return [
                    {
                        sourceId: `adzuna:${result.id}`,
                        source: "adzuna",
                        company,
                        title: result.title.trim(),
                        location,
                        url: result.redirect_url ?? "",
                        postedAt: result.created ?? null,
                        text: withHeader({
                            company,
                            location,
                            description: normaliseWhitespace(result.description ?? ""),
                        }),
                        fetchedAt,
                        textTruncated: true,
                    },
                ];
            });

            return applyQuery(postings, query);
        },
    };
}
