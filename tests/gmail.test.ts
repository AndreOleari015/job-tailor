import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {afterEach, describe, expect, it, vi} from "vitest";
import {normaliseUrl} from "../src/core/dedupe.js";
import {cleanUrl} from "../src/sources/gmail/parsers/html.js";
import {genericParser} from "../src/sources/gmail/parsers/generic.js";
import {indeedParser} from "../src/sources/gmail/parsers/indeed.js";
import {linkedinParser} from "../src/sources/gmail/parsers/linkedin.js";
import {parserFor} from "../src/sources/gmail/parsers/registry.js";
import {wttjParser} from "../src/sources/gmail/parsers/wttj.js";
import {buildQuery} from "../src/sources/gmail/query.js";
import {
    fetchLeads,
    GmailLabelError,
    type GmailClient,
    type GmailMessage,
} from "../src/sources/gmail/index.js";

afterEach(() => vi.restoreAllMocks());

function fixture(name: string): string {
    return readFileSync(fileURLToPath(new URL(`./fixtures/gmail/${name}`, import.meta.url)), "utf8");
}

/* ------------------------------------------------------------------ */
/* Parsers                                                              */
/* ------------------------------------------------------------------ */

describe("linkedinParser", () => {
    const leads = linkedinParser.parse(fixture("linkedin.html"), "");

    it("extracts every job with company, title and location", () => {
        expect(leads).toHaveLength(3);
        expect(leads[0]).toMatchObject({
            company: "Trade Republic",
            title: "Senior React Native Engineer",
            location: "Berlin, Germany (Hybrid)",
        });
        expect(leads[1]?.company).toBe("N26");
        expect(leads[2]?.company).toBe("SumUp");
    });

    it("does not fold the next card's title into the location", () => {
        expect(leads[0]?.location).not.toMatch(/Actively recruiting/);
        expect(leads[1]?.location).not.toMatch(/TypeScript/);
    });
});

describe("indeedParser", () => {
    it("reads Company - Location from the card", () => {
        const leads = indeedParser.parse(fixture("indeed.html"), "");
        expect(leads).toHaveLength(2);
        expect(leads[0]).toMatchObject({company: "Adyen", location: "Amsterdam, Netherlands"});
        expect(leads[1]).toMatchObject({company: "Mollie", title: "Frontend Engineer"});
    });
});

describe("wttjParser", () => {
    it("reads Company · City from the card", () => {
        const leads = wttjParser.parse(fixture("wttj.html"), "");
        expect(leads).toHaveLength(2);
        expect(leads[0]).toMatchObject({company: "Feedzai", location: "Lisbon"});
        expect(leads[1]?.company).toBe("Glovo");
    });
});

describe("genericParser", () => {
    it("extracts only links to known job boards, using anchor text as the title", () => {
        const leads = genericParser.parse(fixture("generic.html"), "");
        expect(leads.map((l) => l.title)).toEqual(["Backend Engineer at Acme", "Platform Engineer"]);
        // The blog link and the twitter link are not job boards.
        expect(leads.every((l) => l.company === null)).toBe(true);
    });
});

describe("tracking parameters", () => {
    it("are stripped from every extracted url", () => {
        const urls = [
            ...linkedinParser.parse(fixture("linkedin.html"), ""),
            ...indeedParser.parse(fixture("indeed.html"), ""),
            ...wttjParser.parse(fixture("wttj.html"), ""),
        ].map((lead) => lead.url);

        for (const url of urls) {
            expect(url).not.toMatch(/utm_|trackingId|refId|trk=|midToken|[?&]eid=/i);
        }
        expect(urls[0]).toBe("https://www.linkedin.com/comm/jobs/view/3891234567/");
    });

    it("cleanUrl keeps a real query parameter while dropping tracking", () => {
        expect(cleanUrl("https://www.indeed.com/viewjob?jk=abc&utm_source=x&trk=y")).toBe(
            "https://www.indeed.com/viewjob?jk=abc",
        );
    });
});

describe("parserFor", () => {
    it("routes by sender and falls back to generic", () => {
        expect(parserFor("jobalerts-noreply@linkedin.com", "x").parser.name).toBe("linkedin");
        expect(parserFor("alert@indeed.com", "x").parser.name).toBe("indeed");
        expect(parserFor("jobs@welcometothejungle.com", "x").parser.name).toBe("wttj");

        const unknown = parserFor("careers@somejobboard.io", "x");
        expect(unknown.parser.name).toBe("generic");
        expect(unknown.generic).toBe(true);
    });
});

/* ------------------------------------------------------------------ */
/* Query builder — the label boundary                                   */
/* ------------------------------------------------------------------ */

describe("buildQuery", () => {
    it("always prefixes the label", () => {
        expect(buildQuery("job-alerts")).toBe("label:job-alerts");
        expect(buildQuery("job-alerts", 7)).toBe("label:job-alerts newer_than:7d");
    });

    it("quotes a label containing a space", () => {
        expect(buildQuery("Job Alerts", 3)).toBe('label:"Job Alerts" newer_than:3d');
    });

    it("refuses to build a query with no label — the mailbox is never searched whole", () => {
        expect(() => buildQuery("")).toThrow(/label is required/i);
        expect(() => buildQuery("   ")).toThrow(/label is required/i);
    });
});

/* ------------------------------------------------------------------ */
/* fetchLeads                                                           */
/* ------------------------------------------------------------------ */

function message(over: Partial<GmailMessage> & {id: string}): GmailMessage {
    return {
        from: "jobalerts-noreply@linkedin.com",
        subject: "Your job alert for react native",
        date: "2026-07-20T09:00:00.000Z",
        html: fixture("linkedin.html"),
        text: "",
        ...over,
    };
}

/** A Gmail client backed by a fixed set of messages. */
function fakeClient(messages: GmailMessage[], labelExists = true): GmailClient {
    return {
        profileEmail: async () => "me@example.com",
        resolveLabel: async () => (labelExists ? {id: "Label_1", messagesTotal: messages.length} : null),
        listMessageIds: async (_query, max) => messages.slice(0, max).map((m) => m.id),
        getMessage: async (id) => {
            const found = messages.find((m) => m.id === id);
            if (!found) throw new Error(`no message ${id}`);
            return found;
        },
    };
}

describe("fetchLeads", () => {
    it("turns a linkedin alert into leads with provenance", async () => {
        const result = await fetchLeads({client: fakeClient([message({id: "m1"})]), label: "job-alerts"});

        expect(result.messagesRead).toBe(1);
        expect(result.leads).toHaveLength(3);
        expect(result.leads[0]).toMatchObject({
            leadSource: "gmail:linkedin",
            emailId: "m1",
            emailDate: "2026-07-20T09:00:00.000Z",
        });
    });

    it("stops with a readable error when the label does not exist", async () => {
        const client = fakeClient([message({id: "m1"})], false);
        await expect(fetchLeads({client, label: "missing"})).rejects.toBeInstanceOf(GmailLabelError);
        await expect(fetchLeads({client, label: "missing"})).rejects.toThrow(/never searches the whole mailbox/i);
    });

    it("warns and counts a named parser that yields nothing from a non-empty body", async () => {
        const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
        const broken = message({id: "b1", html: fixture("linkedin-broken.html")});

        const result = await fetchLeads({client: fakeClient([broken]), label: "job-alerts"});

        expect(result.leads).toHaveLength(0);
        expect(result.unparsed).toBe(1);
        const logged = stderr.mock.calls.map(([c]) => String(c)).join("");
        expect(logged).toContain("linkedin matched");
        expect(logged).toContain("b1");
    });

    it("dedupes the same url arriving in two messages", async () => {
        const twice = [message({id: "m1"}), message({id: "m2"})]; // identical body
        const result = await fetchLeads({client: fakeClient(twice), label: "job-alerts"});

        // Three distinct jobs across two identical emails, not six.
        expect(result.leads).toHaveLength(3);
        expect(result.messagesRead).toBe(2);
    });

    it("never re-parses a message whose id is already recorded", async () => {
        const client = fakeClient([message({id: "seen-1"})]);
        const getMessage = vi.spyOn(client, "getMessage");

        const result = await fetchLeads({
            client,
            label: "job-alerts",
            seen: {urls: new Set(), identities: new Set(), emailIds: new Set(["seen-1"])},
        });

        expect(result.leads).toHaveLength(0);
        expect(result.messagesRead).toBe(0);
        expect(getMessage).not.toHaveBeenCalled();
    });

    it("skips a job already in the database by url", async () => {
        const result = await fetchLeads({
            client: fakeClient([message({id: "m1"})]),
            label: "job-alerts",
            // The set store.dedupeIndex() produces is already normalised.
            seen: {
                urls: new Set([normaliseUrl("https://www.linkedin.com/comm/jobs/view/3891234567/")]),
                identities: new Set(),
                emailIds: new Set(),
            },
        });
        // One of the three is a known url; two remain.
        expect(result.leads).toHaveLength(2);
    });
});

/* ------------------------------------------------------------------ */
/* The secrets never enter git                                          */
/* ------------------------------------------------------------------ */

describe(".gitignore", () => {
    it("ignores the Gmail credentials and token", () => {
        const gitignore = readFileSync(
            fileURLToPath(new URL("../.gitignore", import.meta.url)),
            "utf8",
        );
        expect(gitignore).toMatch(/^data\/gmail-credentials\.json$/m);
        expect(gitignore).toMatch(/^data\/gmail-token\.json$/m);
    });
});
