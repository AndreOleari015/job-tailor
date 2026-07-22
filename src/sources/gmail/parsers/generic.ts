import {cleanUrl, extractLinks, hostOf} from "./html.js";
import type {AlertParser, ParsedLead} from "./types.js";

/**
 * Job-board hosts the generic parser trusts a link to be a posting on. Kept
 * deliberately short: a false positive here becomes a lead you have to dismiss
 * by hand, so the bar is "unambiguously a job board", not "might mention jobs".
 */
const JOB_HOSTS = [
    "linkedin.com",
    "indeed.com",
    "welcometothejungle.com",
    "wttj.co",
    "glassdoor.com",
    "greenhouse.io",
    "lever.co",
    "ashbyhq.com",
    "workable.com",
    "smartrecruiters.com",
    "jobs.eu",
    "stepstone.de",
    "xing.com",
];

function isJobHost(href: string): boolean {
    const host = hostOf(href);
    return JOB_HOSTS.some((known) => host === known || host.endsWith(`.${known}`));
}

/**
 * The last resort, used only when no named parser claims a message: every link
 * to a known job board, with its anchor text as the title. It cannot find a
 * company or location — that is why these leads are marked "gmail:generic", so
 * their lower reliability is visible rather than hidden.
 */
export const genericParser: AlertParser = {
    name: "generic",

    // Never matches by sender: the registry only reaches for it as a fallback.
    matches() {
        return false;
    },

    parse(html) {
        const seen = new Set<string>();
        const leads: ParsedLead[] = [];

        for (const link of extractLinks(html)) {
            if (!isJobHost(link.href) || !link.text.trim()) continue;
            const url = cleanUrl(link.href);
            if (seen.has(url)) continue;
            seen.add(url);
            leads.push({title: link.text, company: null, location: null, url, snippet: null});
        }
        return leads;
    },
};
