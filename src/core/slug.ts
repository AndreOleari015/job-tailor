/** Lowercase, ASCII, hyphenated. Used for both artefact directories and filenames. */
export function slugify(value: string): string {
    const slug = value
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .slice(0, 60)
        .replace(/^-+|-+$/g, "");
    return slug || "unknown";
}
