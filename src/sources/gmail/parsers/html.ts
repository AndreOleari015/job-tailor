/**
 * Just enough HTML handling to read a job-alert email, by regex rather than a
 * parser dependency — the same choice the rest of `sources/` makes. Alert
 * emails are anchor tags and table cells, not documents, so this is adequate
 * and keeps the surface small.
 */

const ENTITIES: Record<string, string> = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#39;": "'",
    "&apos;": "'",
    "&nbsp;": " ",
    "&middot;": "·",
    "&bull;": "•",
    "&ndash;": "–",
    "&mdash;": "—",
};

export function decodeEntities(text: string): string {
    return text
        .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
        .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
        .replace(/&[a-z]+;/gi, (entity) => ENTITIES[entity.toLowerCase()] ?? entity);
}

/** Strips tags and collapses whitespace: the readable text inside a fragment. */
export function stripTags(html: string): string {
    return decodeEntities(html.replace(/<[^>]*>/g, " "))
        .replace(/\s+/g, " ")
        .trim();
}

/**
 * Like `stripTags`, but block-level boundaries become newlines, so the lines a
 * card lays out in separate cells stay separate. Without this, "Company" and
 * the next row's "Actively recruiting" collapse onto one line and pollute the
 * location.
 */
export function blockText(html: string): string {
    return decodeEntities(
        html
            .replace(/<\s*br\s*\/?>/gi, "\n")
            .replace(/<\/(div|td|tr|p|li|h[1-6]|table)\s*>/gi, "\n")
            .replace(/<[^>]*>/g, " "),
    )
        .split("\n")
        .map((line) => line.replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .join("\n");
}

export interface Link {
    href: string;
    text: string;
}

/** Every `<a href>` in the fragment, with its href cleaned and text stripped. */
export function extractLinks(html: string): Link[] {
    const links: Link[] = [];
    const anchor = /<a\b[^>]*?\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;

    for (let match = anchor.exec(html); match; match = anchor.exec(html)) {
        const href = decodeEntities(match[2] ?? "").trim();
        const text = stripTags(match[3] ?? "");
        if (href) links.push({href, text});
    }
    return links;
}

/**
 * Tracking parameters carried by alert links. Removed so the same job does not
 * arrive twice under two tracking ids, and so the stored url is the one a human
 * would recognise. Redirects are never followed here — only the query is cleaned.
 */
const TRACKING_PARAMS = new Set(["trk", "refid", "trackingid", "midtoken", "eid", "lipi"]);

export function cleanUrl(raw: string): string {
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        return raw.trim();
    }

    for (const key of [...url.searchParams.keys()]) {
        const lower = key.toLowerCase();
        if (lower.startsWith("utm_") || TRACKING_PARAMS.has(lower)) {
            url.searchParams.delete(key);
        }
    }
    // Trailing "?" once every param is gone.
    url.search = url.searchParams.toString();
    return url.toString();
}

/** The host of a url, or "" when it does not parse. */
export function hostOf(raw: string): string {
    try {
        return new URL(raw).host.toLowerCase().replace(/^www\./, "");
    } catch {
        return "";
    }
}

export interface JobBlock {
    href: string;
    /** The anchor text of the job link — the title in every template seen. */
    title: string;
    /** Readable text from this job link up to the next one: the card's body. */
    body: string;
}

/**
 * A job card per matching link: the link's anchor text as the title, and the
 * text between it and the next matching link as the body, which the caller
 * mines for company and location. Anything but the first job link of a template
 * has a well-defined block; the last runs to the end of the message.
 */
export function jobBlocks(html: string, isJobUrl: (href: string) => boolean): JobBlock[] {
    const anchor = /<a\b[^>]*?\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;

    const hits: {href: string; title: string; start: number; end: number}[] = [];
    for (let match = anchor.exec(html); match; match = anchor.exec(html)) {
        const href = cleanUrl(decodeEntities(match[2] ?? "").trim());
        if (!isJobUrl(href)) continue;
        hits.push({
            href,
            title: stripTags(match[3] ?? ""),
            start: match.index,
            end: match.index + match[0].length,
        });
    }

    // The card body runs from this job link's end to the *start* of the next —
    // ending at the next link's end would fold its title into this card.
    return hits.map((hit, index) => ({
        href: hit.href,
        title: hit.title,
        body: blockText(html.slice(hit.end, hits[index + 1]?.start ?? html.length)),
    }));
}
