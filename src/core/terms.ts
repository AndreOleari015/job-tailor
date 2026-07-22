/**
 * One place that decides whether a technology term appears in a piece of text.
 *
 * Matching is on whole tokens, never substrings: "react" must not be found
 * inside "Reactivation", which is how a CRM role reached the top of a search
 * for React Native work. Tokens are Unicode letter/digit runs — `\b` is
 * ASCII-only in JavaScript and would break on the German half of this market,
 * the same reason the language detector tokenises rather than using it.
 */

/**
 * Spelling variants of the same term, not synonyms. Every group here is a
 * different way of writing one technology; nothing semantic belongs in it.
 * Firebase is not AWS, and no alias will ever say otherwise.
 */
const ALIASES: Record<string, string[]> = {
    "react native": ["react-native", "rn"],
    react: ["reactjs", "react.js"],
    "node.js": ["node", "nodejs"],
    typescript: ["ts"],
    "ci/cd": ["ci-cd", "cicd"],
    "rest apis": ["rest"],
};

/** Every spelling of a term, keyed by each of its spellings. */
const EQUIVALENTS = new Map<string, readonly string[]>(
    Object.entries(ALIASES).flatMap(([canonical, aliases]) => {
        const group = [canonical, ...aliases];
        return group.map((form) => [form, group] as const);
    }),
);

/**
 * Technology names whose meaning lives in a symbol. Tokenising would erase
 * them — "C#" and "C++" would both become "c" and match each other, ".NET"
 * would become "net". Each is rewritten to a spelled-out token, delimited so
 * "ASP.NET" still yields a "dotnet" token of its own.
 *
 * Longest first, so "c++" is taken before any shorter overlap.
 */
const SYMBOL_TERMS: readonly (readonly [string, string])[] = [
    [".net", "dotnet"],
    ["c++", "cplusplus"],
    ["f#", "fsharp"],
    ["c#", "csharp"],
];

export function normaliseTerm(term: string): string {
    return term.replace(/\s+/g, " ").trim().toLowerCase();
}

/** The term itself plus its other spellings. Never a semantic expansion. */
export function formsOf(term: string): readonly string[] {
    const normalised = normaliseTerm(term);
    return EQUIVALENTS.get(normalised) ?? [normalised];
}

/** Unicode letter/digit runs, with symbol-bearing technology names preserved. */
export function tokenise(text: string): string[] {
    let protectedText = text.toLowerCase();
    for (const [symbol, replacement] of SYMBOL_TERMS) {
        if (protectedText.includes(symbol)) {
            protectedText = protectedText.split(symbol).join(` ${replacement} `);
        }
    }
    return protectedText.match(/[\p{L}\p{N}]+/gu) ?? [];
}

export function tokenSet(text: string): Set<string> {
    return new Set(tokenise(text));
}

/**
 * Whether a term appears in an already-tokenised text.
 *
 * A single-token term must appear as a whole token. A multi-token term needs
 * all of its tokens present in any order — German word order separates them
 * ("Entwickler für mobile Systeme" for "mobile entwickler") — or the tokens
 * run together as one word, which is how "Node.js" and "nodejs" are the same
 * technology written two ways.
 */
export function matchesTerm(tokens: ReadonlySet<string>, term: string): boolean {
    for (const form of formsOf(term)) {
        const parts = tokenise(form);
        if (!parts.length) continue;
        if (parts.every((part) => tokens.has(part))) return true;
        if (parts.length > 1 && tokens.has(parts.join(""))) return true;
    }
    return false;
}

/** Convenience for a single check against raw text. */
export function textMatchesTerm(text: string, term: string): boolean {
    return matchesTerm(tokenSet(text), term);
}
