import {hostOf, jobBlocks} from "./html.js";
import type {AlertParser, ParsedLead} from "./types.js";

/** Welcome to the Jungle serves jobs under welcometothejungle.com/.../jobs/. */
function isJobUrl(href: string): boolean {
    const host = hostOf(href);
    return (host.endsWith("welcometothejungle.com") || host.endsWith("wttj.co")) && /\/jobs?\//.test(href);
}

/**
 * WTTJ names the company prominently and the location beside a pin. The card
 * text reads "Company · City" or "Company — City"; the same first-two-segments
 * rule as the others, since anything past that is the teaser.
 */
function companyAndLocation(body: string): {company: string | null; location: string | null} {
    const line = body.split("\n")[0] ?? "";
    const parts = line.split(/·|•|\s[-–—]\s/).map((part) => part.trim()).filter(Boolean);
    return {company: parts[0] ?? null, location: parts[1] ?? null};
}

export const wttjParser: AlertParser = {
    name: "wttj",

    matches(from) {
        return /welcometothejungle\.com|wttj\.co/i.test(from);
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
