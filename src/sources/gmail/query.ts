/**
 * Every Gmail query this tool issues is built here, and it is not possible to
 * build one without the label. `gmail.readonly` opens the whole mailbox; this
 * function is the boundary that keeps the tool inside the one label the user
 * created for it. There is no code path that reads mail outside it.
 */
export function buildQuery(label: string, sinceDays?: number): string {
    const clean = label.trim();
    if (!clean) {
        throw new Error("A Gmail label is required; the tool never searches the whole mailbox.");
    }

    // Quote the label so one containing a space is still a single term.
    const parts = [`label:${clean.includes(" ") ? `"${clean}"` : clean}`];
    if (sinceDays && sinceDays > 0) parts.push(`newer_than:${Math.floor(sinceDays)}d`);
    return parts.join(" ");
}
