/**
 * The two ways the same job arrives twice, normalised identically wherever
 * dedup happens: the tracker computing what it already holds, and the Gmail
 * fetch deciding what is new. They must agree, so they share this one module.
 */

export function normaliseUrl(url: string): string {
    return url.trim().toLowerCase().replace(/\/+$/, "");
}

export function identityKey(
    company: string | null,
    title: string | null,
    location: string | null,
): string {
    return [company, title, location]
        .map((part) => (part ?? "").toLowerCase().replace(/\s+/g, " ").trim())
        .join("|");
}
