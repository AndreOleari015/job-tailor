import {hostOf, jobBlocks} from "./html.js";
import type {AlertParser, ParsedLead} from "./types.js";

/** A LinkedIn job view, however the alert wraps it in tracking. */
function isJobUrl(href: string): boolean {
    return hostOf(href).endsWith("linkedin.com") && /\/jobs\/view\//.test(href);
}

/**
 * LinkedIn puts "Company · Location" on the line under the title. The middle dot
 * is the reliable separator; when it is missing, the first line is taken as the
 * company and the location left null rather than guessed.
 */
function companyAndLocation(body: string): {company: string | null; location: string | null} {
    const line = body.split("\n")[0] ?? "";
    const parts = line.split(/·|•|\|/).map((part) => part.trim()).filter(Boolean);
    return {company: parts[0] ?? null, location: parts[1] ?? null};
}

export const linkedinParser: AlertParser = {
    name: "linkedin",

    matches(from) {
        return /linkedin\.com/i.test(from);
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
