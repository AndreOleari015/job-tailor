import {hostOf, jobBlocks} from "./html.js";
import type {AlertParser, ParsedLead} from "./types.js";

/** Indeed's alert links go through /rc/clk or /pagead, or straight to /viewjob. */
function isJobUrl(href: string): boolean {
    return hostOf(href).endsWith("indeed.com") && /\/(rc\/clk|pagead|viewjob)/.test(href);
}

/**
 * Indeed's card reads "Company - Location - salary/summary". The dash separates
 * the first two; the location often carries a postcode or "Remote", so only the
 * first two segments are trusted and the rest becomes the snippet.
 */
function companyAndLocation(body: string): {company: string | null; location: string | null} {
    const line = body.split("\n")[0] ?? "";
    const parts = line.split(/\s[-–]\s|·|•/).map((part) => part.trim()).filter(Boolean);
    return {company: parts[0] ?? null, location: parts[1] ?? null};
}

export const indeedParser: AlertParser = {
    name: "indeed",

    matches(from) {
        return /indeed\.com/i.test(from);
    },

    parse(html) {
        const leads: ParsedLead[] = [];
        for (const block of jobBlocks(html, isJobUrl)) {
            if (!block.title) continue;
            const {company, location} = companyAndLocation(block.body);
            leads.push({
                title: block.title,
                company,
                location,
                url: block.href,
                snippet: block.body.replace(/\n/g, " · ").slice(0, 200) || null,
            });
        }
        return leads;
    },
};
