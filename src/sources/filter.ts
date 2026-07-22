import {matchesTerm, tokenSet} from "../core/terms.js";
import {matchesLocation as locationContains} from "./location.js";
import type {RawPosting, SourceQuery} from "./types.js";

function fold(value: string): string {
    return value.toLowerCase();
}

function isWordChar(char: string | undefined): boolean {
    return char !== undefined && /[a-z0-9]/i.test(char);
}

/**
 * Whole-token containment, so "Java" does not match "JavaScript" and "go" does
 * not match "going". The same rule reconcile() uses on the cover letter.
 */
export function containsWholeTerm(haystack: string, term: string): boolean {
    const needle = fold(term.trim());
    if (!needle) return false;

    const text = fold(haystack);
    for (let from = 0; ; ) {
        const index = text.indexOf(needle, from);
        if (index === -1) return false;
        if (!isWordChar(text[index - 1]) && !isWordChar(text[index + needle.length])) return true;
        from = index + 1;
    }
}

/**
 * At least one keyword in the title or the body. No keywords means no filter.
 *
 * Whole tokens, never substrings: `search react native typescript` was
 * returning "Senior CRM Strategy Manager, Reactivation" because "react" is a
 * substring of "Reactivation", "proactive" and "reactive". A multi-word keyword
 * keeps its order-independent semantic — German word order separates the words
 * of "mobile entwickler" — but every one of them must now land on a whole token.
 */
export function matchesKeywords(posting: RawPosting, keywords: readonly string[]): boolean {
    const terms = keywords.map((term) => term.trim()).filter(Boolean);
    if (!terms.length) return true;

    const tokens = tokenSet(`${posting.title}\n${posting.text}`);
    return terms.some((term) => matchesTerm(tokens, term));
}

/** Substring match, which is all a free-text location field supports honestly. */
export function matchesLocation(posting: RawPosting, location: string | undefined): boolean {
    if (!location?.trim()) return true;
    return locationContains(posting.location, location);
}

export function withinDays(postedAt: string | null, days: number | undefined, now = new Date()): boolean {
    if (!days || !postedAt) return true;

    const posted = Date.parse(postedAt);
    if (!Number.isFinite(posted)) return true;
    return now.getTime() - posted <= days * 24 * 60 * 60 * 1000;
}

/**
 * The client-side filter every source applies to its own results. Board APIs
 * have no query parameters worth the name, so the filtering happens here where
 * it is the same for all of them.
 */
export function applyQuery(
    postings: readonly RawPosting[],
    query: SourceQuery,
    now = new Date(),
): RawPosting[] {
    return postings.filter(
        (posting) =>
            matchesKeywords(posting, query.keywords) &&
            matchesLocation(posting, query.location) &&
            withinDays(posting.postedAt, query.postedWithinDays, now),
    );
}
