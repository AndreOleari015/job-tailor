import {containsWholeTerm} from "./filter.js";

/**
 * What a country looks like in a posting's location field: its own names, and
 * the cities that actually appear there. A posting says "Munich", never "DE".
 *
 * `regions` are the wider areas a remote posting may name instead of the
 * country — "Remote (EMEA)". `exclude` wins over `terms`, which is how Ireland
 * avoids claiming "Northern Ireland".
 *
 * This is a vocabulary, not a gazetteer. It covers the markets in
 * data/countries.yaml plus the ones postings for them commonly name, and it is
 * meant to be extended by hand when a real search misses something.
 */
interface CountryVocabulary {
    label: string;
    regions: readonly string[];
    /** The country's own names, as a posting spells them. */
    names: readonly string[];
    /**
     * Cities and sub-national regions. Matched exactly like the names above:
     * what settles an ambiguous place name is any *other* name in the string,
     * not whether this one happens to be a country or a city.
     */
    cities: readonly string[];
    exclude?: readonly string[];
}

const COUNTRIES: Record<string, CountryVocabulary> = {
    DE: {
        label: "Germany",
        regions: ["europe", "european", "eu", "eea", "emea", "dach"],
        names: ["germany", "deutschland"],
        cities: [
            "berlin", "munich", "münchen", "hamburg", "cologne", "köln", "frankfurt",
            "stuttgart", "düsseldorf", "leipzig", "dresden", "bremen", "hannover", "hanover",
            "nuremberg", "nürnberg", "karlsruhe", "mannheim", "bonn", "dortmund", "essen",
            "münster",
            // All sixteen Bundesländer. The Bundesagentur writes its locations
            // as "Ort, Bundesland", so the state is the only token that is
            // always there — without them "Burgwedel, Niedersachsen" reads as
            // nowhere, and a real German posting is dropped from a German search.
            "baden-württemberg", "bayern", "bavaria", "brandenburg", "hessen",
            "mecklenburg-vorpommern", "niedersachsen", "nordrhein-westfalen",
            "rheinland-pfalz", "saarland", "sachsen", "sachsen-anhalt",
            "schleswig-holstein", "thüringen",
            // Also a Swiss canton and city. Ambiguous on its own, settled by
            // anything else in the string that names a country.
            "freiburg",
        ],
    },
    AT: {
        label: "Austria",
        regions: ["europe", "european", "eu", "eea", "emea", "dach"],
        names: ["austria", "österreich"],
        cities: [
            "wien", "vienna", "graz", "linz", "salzburg", "innsbruck", "klagenfurt", "villach",
            "steiermark", "kärnten", "tirol", "oberösterreich", "niederösterreich",
            "burgenland", "vorarlberg",
        ],
    },
    CH: {
        label: "Switzerland",
        // Not "eu" or "eea": Switzerland is in neither.
        regions: ["europe", "european", "emea", "dach"],
        names: ["switzerland", "schweiz", "suisse"],
        cities: [
            "zürich", "zurich", "genf", "geneva", "genève", "basel", "bern", "lausanne",
            "luzern", "lucerne", "winterthur", "zug", "st. gallen", "aargau", "thurgau",
            "graubünden", "solothurn", "schwyz", "wallis", "waadt", "vaud", "ticino",
            // Fribourg in French, Freiburg in German — and Freiburg im Breisgau
            // is a different city in Germany. Claimed by both on purpose: that
            // is what an ambiguous place name is, and the resolver handles it.
            "freiburg",
        ],
    },
    IE: {
        label: "Ireland",
        regions: ["europe", "european", "eu", "eea", "emea"],
        names: ["ireland", "éire"],
        cities: [
            "dublin", "cork", "galway", "limerick", "waterford", "athlone", "sligo",
            "kilkenny", "dundalk", "drogheda",
        ],
        // Belfast is in the UK, however the location field spells it.
        exclude: ["northern ireland"],
    },
    NL: {
        label: "Netherlands",
        regions: ["europe", "european", "eu", "eea", "emea", "benelux"],
        names: ["netherlands", "nederland", "holland"],
        cities: [
            "amsterdam", "rotterdam", "utrecht", "the hague", "den haag", "eindhoven",
            "groningen", "tilburg", "almere", "delft", "leiden", "haarlem", "amersfoort",
        ],
    },
    PT: {
        label: "Portugal",
        regions: ["europe", "european", "eu", "eea", "emea", "iberia"],
        names: ["portugal"],
        cities: [
            "lisbon", "lisboa", "porto", "oporto", "braga", "coimbra", "faro", "aveiro",
            "funchal", "guimarães",
        ],
    },
    ES: {
        label: "Spain",
        regions: ["europe", "european", "eu", "eea", "emea", "iberia"],
        names: ["spain", "españa"],
        cities: [
            "madrid", "barcelona", "valencia", "seville", "sevilla", "bilbao", "málaga",
            "zaragoza", "alicante", "murcia", "granada", "palma", "san sebastián", "donostia",
        ],
    },
    GB: {
        label: "United Kingdom",
        // Not "eu" or "eea": a posting restricted to those is not open here.
        regions: ["europe", "european", "emea"],
        names: [
            "united kingdom", "uk", "great britain", "britain", "england", "scotland", "wales",
            "northern ireland",
        ],
        cities: [
            "london", "manchester", "birmingham", "edinburgh", "glasgow", "bristol", "leeds",
            "cambridge", "oxford", "brighton", "sheffield", "liverpool", "cardiff", "belfast",
            "newcastle",
        ],
    },
    SE: {
        label: "Sweden",
        regions: ["europe", "european", "eu", "eea", "emea", "nordics", "nordic", "scandinavia"],
        names: ["sweden", "sverige"],
        cities: [
            "stockholm", "gothenburg", "göteborg", "malmö", "uppsala", "lund", "linköping",
            "västerås", "helsingborg",
        ],
    },
    EE: {
        label: "Estonia",
        regions: ["europe", "european", "eu", "eea", "emea", "baltics", "baltic"],
        names: ["estonia", "eesti"],
        cities: ["tallinn", "tartu", "pärnu", "narva"],
    },
};

/** Remote scopes that include every country, so they satisfy any --country. */
const GLOBAL_TERMS = ["worldwide", "global", "anywhere", "international"];

const REMOTE_TERMS = ["remote", "anywhere", "distributed"];

/**
 * Case-folded and stripped of diacritics, so "München" and "Munchen" are the
 * same place and neither depends on how the board spelled it.
 */
function fold(value: string): string {
    return value
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")
        .toLowerCase();
}

function mentions(location: string, terms: readonly string[]): boolean {
    const haystack = fold(location);
    return terms.some((term) => containsWholeTerm(haystack, fold(term)));
}

export function isKnownCountry(code: string): boolean {
    return Boolean(COUNTRIES[code.trim().toUpperCase()]);
}

/** The country's display name, or the code itself when it is not in the map. */
export function countryLabel(code: string): string {
    return COUNTRIES[code.trim().toUpperCase()]?.label ?? code.trim().toUpperCase();
}

export interface CountryResolution {
    /** Every country the location names outright. */
    countries: string[];
    /**
     * Countries that only an ambiguous place name pointed at, withheld because
     * nothing in the location said which one was meant.
     */
    withheld: string[];
}

/**
 * Which countries a location names.
 *
 * Ambiguity is a property of a **place name**, not of a location string. A
 * posting listing "Berlin, Germany; Dublin, Ireland" is not ambiguous — it is
 * open in two countries, and it matches both. Only a single name that genuinely
 * belongs to more than one country is ambiguous, and only while nothing else in
 * the string settles it: "Freiburg" alone could be either, "Freiburg im
 * Breisgau, Baden-Württemberg" is German because the state says so.
 */
export function resolveCountry(location: string | null): CountryResolution {
    if (!location?.trim()) return {countries: [], withheld: []};

    // Which countries each matched place name belongs to. A name claimed by one
    // country is evidence; a name claimed by two is a question.
    const claimants = new Map<string, string[]>();

    for (const [code, country] of Object.entries(COUNTRIES)) {
        if (country.exclude && mentions(location, country.exclude)) continue;
        for (const term of [...country.names, ...country.cities]) {
            if (!mentions(location, [term])) continue;
            claimants.set(term, [...(claimants.get(term) ?? []), code]);
        }
    }

    const countries = new Set<string>();
    const contested: string[][] = [];
    for (const [, codes] of claimants) {
        if (codes.length === 1) countries.add(codes[0] as string);
        else contested.push(codes);
    }

    // An ambiguous name is settled if one of its countries is named elsewhere in
    // the string; otherwise every country it could mean is withheld.
    const withheld = new Set<string>();
    for (const codes of contested) {
        if (codes.some((code) => countries.has(code))) continue;
        for (const code of codes) withheld.add(code);
    }

    return {countries: [...countries], withheld: [...withheld]};
}

/**
 * Whether a posting's location is in a country. A null or empty location never
 * matches: an unstated location is not evidence of anything, and treating it as
 * a match is how a search for German roles returns Warsaw and San Francisco.
 */
export function matchesCountry(location: string | null, code: string): boolean {
    return resolveCountry(location).countries.includes(code.trim().toUpperCase());
}

/**
 * True when only an ambiguous place name pointed at this country, so the
 * posting was withheld for want of an answer rather than judged to be elsewhere.
 */
export function isAmbiguousFor(location: string | null, code: string): boolean {
    return resolveCountry(location).withheld.includes(code.trim().toUpperCase());
}

/** Substring, case- and diacritic-insensitive: all a free-text field supports. */
export function matchesLocation(location: string | null, needle: string): boolean {
    if (!needle.trim()) return true;
    return fold(location ?? "").includes(fold(needle.trim()));
}

export function isRemote(location: string | null): boolean {
    if (!location?.trim()) return false;
    return mentions(location, REMOTE_TERMS);
}

/**
 * A remote posting someone in `code` could actually take: it either names the
 * country, or names a wider area containing it. "Remote (Europe)" and "EMEA
 * Remote" qualify for Germany; a bare "Remote — US" does not, which is the
 * whole point of asking.
 */
export function isRemoteIn(location: string | null, code: string): boolean {
    if (!isRemote(location)) return false;
    if (matchesCountry(location, code)) return true;

    const country = COUNTRIES[code.trim().toUpperCase()];
    if (!country) return false;
    return mentions(location ?? "", [...country.regions, ...GLOBAL_TERMS]);
}
