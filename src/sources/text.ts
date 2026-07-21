/**
 * HTML to the plain text the extraction prompt was tuned on: paragraphs
 * separated by a blank line, list items as "- " lines. Every source funnels
 * through here so an automated posting has the same shape as a pasted one.
 */

const NAMED_ENTITIES: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    ndash: "–",
    mdash: "—",
    hellip: "…",
    rsquo: "’",
    lsquo: "‘",
    ldquo: "“",
    rdquo: "”",
    eacute: "é",
    uuml: "ü",
    ouml: "ö",
    auml: "ä",
    szlig: "ß",
};

/** Decodes named and numeric entities. Applied twice for escaped-HTML sources. */
export function decodeEntities(input: string): string {
    return input.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, body: string) => {
        if (body.startsWith("#")) {
            const isHex = body[1] === "x" || body[1] === "X";
            const code = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
            return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : match;
        }
        return NAMED_ENTITIES[body.toLowerCase()] ?? match;
    });
}

/** Block-level tags whose close ends a paragraph. */
const BLOCK_CLOSE = /<\/(p|div|section|article|h[1-6]|ul|ol|table|tr|blockquote|pre)\s*>/gi;

/**
 * Strips markup to readable plain text. Deliberately a small, predictable
 * transform rather than a full HTML parser: postings are simple documents, and
 * a surprising parse is worse than a plain one.
 */
export function htmlToText(input: string): string {
    // Sources such as Greenhouse return HTML that is itself escaped, so the
    // first pass turns "&lt;p&gt;" back into real markup before it is stripped.
    let text = decodeEntities(input);

    text = text
        .replace(/<(script|style)[\s\S]*?<\/\1\s*>/gi, "")
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<li[^>]*>/gi, "\n- ")
        .replace(/<\/li\s*>/gi, "\n")
        .replace(BLOCK_CLOSE, "\n\n")
        .replace(/<[^>]+>/g, "");

    // Entities that were themselves escaped in the source survive the strip.
    text = decodeEntities(text);

    return normaliseWhitespace(text);
}

/** Collapses runs of spaces and blank lines without losing paragraph breaks. */
export function normaliseWhitespace(input: string): string {
    return input
        .replace(/\r\n?/g, "\n")
        .replace(/ /g, " ")
        .split("\n")
        .map((line) => line.replace(/[ \t]+/g, " ").trim())
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

export interface PostingHeader {
    company: string | null;
    location: string | null;
    description: string;
}

/**
 * The header the extractor reads deterministically. `companyFromHeader()` in
 * core/extract.ts overrides whatever the model infers from a "Company:" line,
 * so every automated posting gets the same guarantee a hand-added one does.
 */
export function withHeader({company, location, description}: PostingHeader): string {
    const lines: string[] = [];
    if (company?.trim()) lines.push(`Company: ${company.trim()}`);
    if (location?.trim()) lines.push(`Location: ${location.trim()}`);

    const body = normaliseWhitespace(description);
    return lines.length ? `${lines.join("\n")}\n\n${body}\n` : `${body}\n`;
}
