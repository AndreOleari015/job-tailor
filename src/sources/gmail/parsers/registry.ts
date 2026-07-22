import {genericParser} from "./generic.js";
import {indeedParser} from "./indeed.js";
import {linkedinParser} from "./linkedin.js";
import type {AlertParser} from "./types.js";
import {wttjParser} from "./wttj.js";

/** The named parsers, tried in order. The generic one is the fallback, not a member. */
export const NAMED_PARSERS: readonly AlertParser[] = [linkedinParser, indeedParser, wttjParser];

export {genericParser};

/**
 * The parser for a message, and whether it is the generic fallback. A named
 * parser matches on the sender; when none does, the generic link extractor
 * runs so a message is never dropped in silence, only marked lower-confidence.
 */
export function parserFor(from: string, subject: string): {parser: AlertParser; generic: boolean} {
    const named = NAMED_PARSERS.find((parser) => parser.matches(from, subject));
    return named ? {parser: named, generic: false} : {parser: genericParser, generic: true};
}
