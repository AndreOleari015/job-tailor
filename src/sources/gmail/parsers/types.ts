/**
 * One lead extracted from an alert email: enough to recognise the job and open
 * it, but not the description. That is what makes it a lead — the alert never
 * carries the full text, so a human pastes it in before anything is generated.
 */
export interface ParsedLead {
    company: string | null;
    title: string;
    location: string | null;
    url: string;
    snippet: string | null;
}

/**
 * A reader for one alert provider's email template. `matches` decides from the
 * sender and subject alone; `parse` runs only after it claims the message.
 *
 * These templates change without notice, and a parser that silently returns
 * nothing is the failure mode of the whole feature — so a parser that matches
 * but yields zero leads from a non-empty body is reported loudly by the fetch
 * layer, which is where the message id is known.
 */
export interface AlertParser {
    readonly name: string;
    matches(from: string, subject: string): boolean;
    parse(html: string, text: string): ParsedLead[];
}
