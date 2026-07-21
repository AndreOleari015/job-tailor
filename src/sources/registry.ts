import {readAdzunaCredentials, readArbeitsagenturKey} from "../config.js";
import {createAdzunaSource} from "./adzuna.js";
import {createArbeitsagenturSource} from "./arbeitsagentur.js";
import {createAshbySource} from "./ashby.js";
import type {PostingCache} from "./cache.js";
import {loadCompanies, type CompanyConfig} from "./companies.js";
import {createGreenhouseSource} from "./greenhouse.js";
import {createHttp, type HttpClient} from "./http.js";
import {createLeverSource} from "./lever.js";
import type {JobSource} from "./types.js";

export const SOURCE_NAMES = [
    "greenhouse",
    "lever",
    "ashby",
    "adzuna",
    "arbeitsagentur",
] as const;

export type SourceName = (typeof SOURCE_NAMES)[number];

export function isSourceName(value: string): value is SourceName {
    return (SOURCE_NAMES as readonly string[]).includes(value);
}

export interface RegistryOptions {
    http?: HttpClient;
    companies?: CompanyConfig;
    cache?: PostingCache;
}

/**
 * Builds every source. Construction never touches the network and never
 * throws for a missing credential — a source that cannot run says so when it
 * is asked to search, so `sources` can list it as unavailable instead.
 */
export async function buildSources(options: RegistryOptions = {}): Promise<JobSource[]> {
    const http = options.http ?? createHttp();
    const companies = options.companies ?? (await loadCompanies());

    return [
        createGreenhouseSource({http, entries: companies.greenhouse}),
        createLeverSource({http, entries: companies.lever}),
        createAshbySource({http, entries: companies.ashby}),
        createAdzunaSource({http, credentials: readAdzunaCredentials()}),
        createArbeitsagenturSource({
            http,
            apiKey: readArbeitsagenturKey(),
            cache: options.cache,
        }),
    ];
}

/** The named sources, or all of them when nothing is named. */
export async function resolveSources(
    names: readonly string[] = [],
    options: RegistryOptions = {},
): Promise<JobSource[]> {
    const all = await buildSources(options);
    if (!names.length) return all;

    const wanted = new Set(names);
    return all.filter((source) => wanted.has(source.name));
}
