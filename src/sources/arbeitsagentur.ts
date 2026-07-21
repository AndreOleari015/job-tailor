import pLimit from "p-limit";
import type {PostingCache} from "./cache.js";
import {applyQuery} from "./filter.js";
import type {HttpClient} from "./http.js";
import {normaliseWhitespace, withHeader} from "./text.js";
import {SourceUnavailableError, type JobSource, type RawPosting, type SourceQuery} from "./types.js";

const BASE = "https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v4";
const PAGE_SIZE = 50;
const DETAIL_CONCURRENCY = 3;

interface SearchHit {
    refnr?: string;
    titel?: string;
    beruf?: string;
    arbeitgeber?: string;
    aktuelleVeroeffentlichungsdatum?: string;
    arbeitsort?: {ort?: string; region?: string; land?: string};
}

interface SearchResponse {
    stellenangebote?: SearchHit[];
}

interface DetailResponse {
    stellenangebotsBeschreibung?: string;
    stellenangebotsTitel?: string;
    firma?: string;
    datumErsteVeroeffentlichung?: string;
}

export interface ArbeitsagenturDeps {
    http: HttpClient;
    /**
     * The static client header the API requires. Read from config rather than
     * hardcoded, so a change on their side is a config edit, not a release.
     */
    apiKey?: string | undefined;
    /** Consulted before each detail fetch; a posting seen before is not fetched twice. */
    cache?: PostingCache | undefined;
}

function locationOf(hit: SearchHit): string | null {
    const parts = [hit.arbeitsort?.ort, hit.arbeitsort?.region]
        .map((part) => part?.trim())
        .filter((part): part is string => Boolean(part) && part !== "null");

    const unique = [...new Set(parts)];
    return unique.length ? unique.join(", ") : null;
}

/** The detail endpoint addresses a posting by its base64-encoded reference number. */
function detailUrl(refnr: string): string {
    return `${BASE}/jobdetails/${encodeURIComponent(Buffer.from(refnr, "utf8").toString("base64"))}`;
}

function searchUrl(query: SourceQuery): string {
    const params = new URLSearchParams({size: String(PAGE_SIZE), page: "1"});
    if (query.keywords.length) params.set("was", query.keywords.join(" "));
    if (query.location?.trim()) params.set("wo", query.location.trim());
    // 1 = the API's "published within the last N days" bucket parameter.
    if (query.postedWithinDays) params.set("veroeffentlichtseit", String(query.postedWithinDays));
    if (query.remote) params.set("arbeitszeit", "ho");

    return `${BASE}/jobs?${params}`;
}

function warn(message: string): void {
    process.stderr.write(`[job-tailor] ${message}\n`);
}

/**
 * The German federal employment agency's public job board — the highest-value
 * source for this profile's target market. Search returns metadata only, so
 * each result needs a second request for its description.
 */
export function createArbeitsagenturSource(deps: ArbeitsagenturDeps): JobSource {
    const limit = pLimit(DETAIL_CONCURRENCY);

    function headers(): Record<string, string> {
        if (!deps.apiKey?.trim()) {
            throw new SourceUnavailableError(
                "arbeitsagentur",
                "arbeitsagentur needs ARBEITSAGENTUR_API_KEY in your .env (the public " +
                    'jobsuche client key, currently "jobboerse-jobsuche"); skipping it.',
            );
        }
        return {"X-API-Key": deps.apiKey.trim()};
    }

    async function hydrate(hit: SearchHit, fetchedAt: string): Promise<RawPosting | null> {
        const refnr = hit.refnr?.trim();
        if (!refnr || !hit.titel) return null;

        const sourceId = `arbeitsagentur:${refnr}`;
        const cached = deps.cache?.get(sourceId);
        if (cached) return cached;

        let detail: DetailResponse = {};
        try {
            detail = await deps.http.getJson<DetailResponse>(detailUrl(refnr), {
                headers: headers(),
                label: `arbeitsagentur:${refnr}`,
            });
        } catch (error) {
            // A posting whose detail 404s is gone; the rest of the page stands.
            const reason = error instanceof Error ? error.message : String(error);
            warn(`arbeitsagentur:${refnr} detail failed, skipping — ${reason}`);
            return null;
        }

        const company = (detail.firma ?? hit.arbeitgeber)?.trim() || null;
        const location = locationOf(hit);
        const title = (detail.stellenangebotsTitel ?? hit.titel).trim();

        return {
            sourceId,
            source: "arbeitsagentur",
            company,
            title,
            location,
            url: `https://www.arbeitsagentur.de/jobsuche/jobdetail/${encodeURIComponent(refnr)}`,
            postedAt:
                detail.datumErsteVeroeffentlichung ?? hit.aktuelleVeroeffentlichungsdatum ?? null,
            text: withHeader({
                company,
                location,
                description: normaliseWhitespace(detail.stellenangebotsBeschreibung ?? ""),
            }),
            fetchedAt,
        };
    }

    return {
        name: "arbeitsagentur",
        requiresCredentials: false,
        kind: "aggregator",

        async search(query: SourceQuery): Promise<RawPosting[]> {
            const payload = await deps.http.getJson<SearchResponse>(searchUrl(query), {
                headers: headers(),
                label: "arbeitsagentur",
            });

            const fetchedAt = new Date().toISOString();
            const hydrated = await Promise.all(
                (payload.stellenangebote ?? []).map((hit) => limit(() => hydrate(hit, fetchedAt))),
            );

            return applyQuery(
                hydrated.filter((posting): posting is RawPosting => posting !== null),
                query,
            );
        },

        async fetchOne(sourceId: string): Promise<RawPosting> {
            const refnr = sourceId.slice("arbeitsagentur:".length);
            const posting = await hydrate({refnr, titel: refnr}, new Date().toISOString());
            if (!posting) throw new Error(`${sourceId} could not be fetched`);
            return posting;
        },
    };
}
