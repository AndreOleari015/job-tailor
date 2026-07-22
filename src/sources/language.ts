export type PostingLanguage = "de" | "en" | "unknown";

/**
 * Function words, which is what makes this work at all: they are the highest
 * frequency tokens in any prose and they are not shared between the two
 * languages. Content words are useless here — a German software posting is
 * full of "Developer", "Cloud" and "Agile".
 */
const GERMAN_WORDS = new Set([
    "und", "oder", "mit", "für", "von", "dem", "den", "das", "die", "der", "ist", "sind",
    "werden", "wir", "sowie", "bei", "nach", "über", "unter", "durch", "kann", "sollte",
]);

const ENGLISH_WORDS = new Set([
    "and", "or", "with", "for", "of", "the", "is", "are", "will", "we", "as", "at", "after",
    "over", "under", "through", "can", "should",
]);

/** Below this, there is not enough prose to call it either way. */
const MINIMUM_HITS = 5;

/** Closer than this and the two counts are not telling us anything. */
const DECISIVE_MARGIN = 0.2;

/**
 * "(m/w/d)" and "(w/m/d)" are the German gender markers. They are strong
 * evidence and weak proof: German employers put them in the titles of English
 * postings too, so this only tips a count that is already close.
 */
const GENDER_MARKER = /\(\s*(?:m\s*\/\s*w\s*\/\s*d|w\s*\/\s*m\s*\/\s*d)\s*\)/i;
const GENDER_MARKER_WEIGHT = 3;

/**
 * Unicode-aware tokenisation. `\b` in JavaScript is ASCII-only, so a regex
 * boundary around "über" does not assert where you would expect — splitting on
 * letters is the only way to count "für" and "über" correctly.
 */
function tokenise(text: string): string[] {
    return text.toLowerCase().match(/\p{L}+/gu) ?? [];
}

export interface LanguageEvidence {
    language: PostingLanguage;
    german: number;
    english: number;
}

/**
 * Which language a posting is written in, deterministically and for free: this
 * runs on every search result, so it can never be a model call.
 */
export function detectLanguageWithEvidence(text: string, title = ""): LanguageEvidence {
    let german = 0;
    let english = 0;

    for (const token of tokenise(`${title}\n${text}`)) {
        if (GERMAN_WORDS.has(token)) german += 1;
        else if (ENGLISH_WORDS.has(token)) english += 1;
    }

    // Weighted, not decisive: worth about three function words.
    if (GENDER_MARKER.test(title) || GENDER_MARKER.test(text)) german += GENDER_MARKER_WEIGHT;

    if (german < MINIMUM_HITS && english < MINIMUM_HITS) {
        return {language: "unknown", german, english};
    }

    const highest = Math.max(german, english);
    if (Math.abs(german - english) / highest < DECISIVE_MARGIN) {
        return {language: "unknown", german, english};
    }

    return {language: german > english ? "de" : "en", german, english};
}

export function detectLanguage(text: string, title = ""): PostingLanguage {
    return detectLanguageWithEvidence(text, title).language;
}

export function isPostingLanguage(value: string): value is PostingLanguage {
    return value === "de" || value === "en" || value === "unknown";
}
