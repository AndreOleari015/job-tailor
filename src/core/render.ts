import Handlebars from "handlebars";
import {readFileSync} from "node:fs";
import {mkdir, writeFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import puppeteer, {type Browser, type Page} from "puppeteer";
import {flags, type JobSpec, type Profile, type TailoredApplication} from "../types.js";
import {slugify} from "./slug.js";

/* ------------------------------------------------------------------ */
/* Errors                                                               */
/* ------------------------------------------------------------------ */

/**
 * Raised instead of producing a PDF from an application carrying a factual
 * flag. A flagged application is a draft, and a PDF in a folder is one drag
 * away from being attached to a real application. JSON is where drafts live.
 */
export class RenderBlockedError extends Error {
    override readonly name = "RenderBlockedError";
    readonly blockingFlags: readonly string[];

    constructor(blocking: readonly string[]) {
        super(
            `Refusing to render: the application is flagged ${blocking.join(", ")}. ` +
                "Read application.json, fix the letter, then re-render — or pass --force " +
                "to produce a watermarked draft.",
        );
        this.blockingFlags = blocking;
    }
}

/** A cover letter that does not fit one page is a content problem, not a layout one. */
export class RenderOverflowError extends Error {
    override readonly name = "RenderOverflowError";
}

/**
 * Flags that stop a render. Each one means a factual claim in the document is
 * unverified. MISSING_AUTHORISATION_CLAIM is deliberately absent: a letter that
 * omits a statement is incomplete, not false.
 */
const BLOCKING_FLAGS: readonly string[] = [
    flags.unexpectedAuthorisationClaim,
    flags.coverLetterRefMismatch,
    flags.unsupportedTechClaim,
    flags.invalidBulletIdsDropped,
];

export const WATERMARK = "DRAFT — UNVERIFIED CLAIMS";

/** The blocking flags this application carries, in the order they are checked. */
export function blockingFlags(application: TailoredApplication): string[] {
    return BLOCKING_FLAGS.filter((flag) => application.flags.includes(flag));
}

/** Throws unless the application is clean, or the caller has forced the render. */
export function assertRenderable(application: TailoredApplication, force = false): void {
    const blocking = blockingFlags(application);
    if (blocking.length && !force) throw new RenderBlockedError(blocking);
}

/* ------------------------------------------------------------------ */
/* Templates                                                            */
/* ------------------------------------------------------------------ */

const TEMPLATE_DIR = fileURLToPath(new URL("../../templates/", import.meta.url));

function readTemplate(name: string): string {
    return readFileSync(path.join(TEMPLATE_DIR, name), "utf8");
}

/** Compiled once per process; the templates never change at runtime. */
const compiled = new Map<string, HandlebarsTemplateDelegate>();

function template(name: string): HandlebarsTemplateDelegate {
    let known = compiled.get(name);
    if (!known) {
        if (!compiled.size) {
            Handlebars.registerPartial("baseStyles", readTemplate("base-styles.hbs"));
        }
        known = Handlebars.compile(readTemplate(name), {strict: false});
        compiled.set(name, known);
    }
    return known;
}

/* ------------------------------------------------------------------ */
/* Formatting                                                           */
/* ------------------------------------------------------------------ */

const LETTER_DATE = new Intl.DateTimeFormat("en-IE", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
});

const ENTRY_MONTH = new Intl.DateTimeFormat("en-IE", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
});

const MONTH_KEY = /^(\d{4})-(\d{2})$/;

/** "2024-11" -> "Nov 2024", "present" -> "Present", anything else verbatim. */
function formatMonth(value: string): string {
    const trimmed = value.trim();
    if (trimmed.toLowerCase() === "present") return "Present";

    const match = MONTH_KEY.exec(trimmed);
    if (!match) return trimmed;

    const year = Number(match[1]);
    const month = Number(match[2]);
    return ENTRY_MONTH.format(new Date(Date.UTC(year, month - 1, 1)));
}

function formatRange(from: string, to: string): string {
    return `${formatMonth(from)} – ${formatMonth(to)}`;
}

/** "web_backend" -> "Web backend". */
function humanise(key: string): string {
    const spaced = key.replace(/[_-]+/g, " ").trim();
    return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : key;
}

function isUnknownCompany(company: string): boolean {
    const trimmed = company.trim();
    return !trimmed || trimmed.toLowerCase() === "unknown";
}

function asUrl(value: string): string {
    return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

interface ContactItem {
    text: string;
    href?: string;
}

function contactItem(text: string, href?: string): ContactItem[] {
    const trimmed = text.trim();
    if (!trimmed) return [];
    return href ? [{text: trimmed, href}] : [{text: trimmed}];
}

/* ------------------------------------------------------------------ */
/* View models                                                          */
/* ------------------------------------------------------------------ */

interface EntryView {
    title: string;
    org: string | null;
    meta: string | null;
    sub: string | null;
    bullets: string[];
}

interface RankedEntry {
    rank: number;
    view: EntryView;
}

/**
 * An entry's bullets, restricted to the selected ids and ordered by their
 * position in `bullet_order`, plus the entry's own rank: the earliest position
 * any of its bullets holds, so the most relevant experience leads the CV.
 *
 * The application layer selects and orders. Bullet prose comes from the
 * profile, verbatim, always.
 */
function selectBullets(
    entryBullets: readonly {id: string; text: string}[],
    order: readonly string[],
    selected: ReadonlySet<string>,
): {bullets: string[]; rank: number} | null {
    const ranked = entryBullets
        .filter((bullet) => selected.has(bullet.id))
        .map((bullet) => {
            const position = order.indexOf(bullet.id);
            return {text: bullet.text, position: position === -1 ? order.length : position};
        })
        .sort((a, b) => a.position - b.position);

    if (!ranked.length) return null;
    return {
        bullets: ranked.map((bullet) => bullet.text),
        rank: ranked[0]?.position ?? Number.MAX_SAFE_INTEGER,
    };
}

function sortByRank(entries: RankedEntry[]): EntryView[] {
    return [...entries].sort((a, b) => a.rank - b.rank).map((entry) => entry.view);
}

function experienceViews(profile: Profile, application: TailoredApplication): EntryView[] {
    const selected = new Set(application.selected_bullet_ids);
    const entries: RankedEntry[] = [];

    for (const entry of profile.experience) {
        const chosen = selectBullets(entry.bullets, application.bullet_order, selected);
        if (!chosen) continue;

        entries.push({
            rank: chosen.rank,
            view: {
                title: entry.role,
                org: entry.company,
                meta: formatRange(entry.from, entry.to),
                sub: entry.location?.trim() || null,
                bullets: chosen.bullets,
            },
        });
    }
    return sortByRank(entries);
}

function projectViews(profile: Profile, application: TailoredApplication): EntryView[] {
    const selected = new Set(application.selected_bullet_ids);
    const entries: RankedEntry[] = [];

    for (const project of profile.projects) {
        const chosen = selectBullets(project.bullets, application.bullet_order, selected);
        if (!chosen) continue;

        entries.push({
            rank: chosen.rank,
            view: {
                title: project.name,
                org: project.description.trim() || null,
                meta: null,
                sub: project.url?.trim() || null,
                bullets: chosen.bullets,
            },
        });
    }
    return sortByRank(entries);
}

function cvContact(profile: Profile): ContactItem[] {
    const {location, email, phone, github, linkedin} = profile.basics;
    return [
        ...contactItem(location),
        ...contactItem(email, `mailto:${email.trim()}`),
        ...contactItem(phone),
        ...contactItem(github, github.trim() ? asUrl(github) : undefined),
        ...contactItem(linkedin, linkedin.trim() ? asUrl(linkedin) : undefined),
    ];
}

export interface RenderInput {
    profile: Profile;
    jobSpec: JobSpec;
    application: TailoredApplication;
    outDir: string;
    /** Renders despite blocking flags, stamping the documents as an unverified draft. */
    force?: boolean;
    /** Injectable so a rendered letter's date is reproducible in tests. */
    now?: Date;
}

function watermarkFor(application: TailoredApplication, force: boolean): string | null {
    // Only an actually-bypassed refusal is a draft. A clean application forced
    // past the min-score check has no unverified claim to warn about.
    return force && blockingFlags(application).length ? WATERMARK : null;
}

function cvHtml(input: RenderInput): string {
    const {profile, application} = input;
    const watermark = watermarkFor(application, input.force ?? false);

    return template("cv.hbs")({
        name: profile.basics.name,
        displayName: profile.basics.name.toUpperCase(),
        headline: application.headline,
        summary: application.profile_summary,
        contact: cvContact(profile),
        projects: projectViews(profile, application),
        experience: experienceViews(profile, application),
        skills: Object.entries(profile.skills)
            .filter(([, items]) => items.length)
            .map(([key, items]) => ({label: humanise(key), items: items.join(", ")})),
        certifications: (profile.certifications ?? []).map((entry) => ({
            name: entry.name,
            issuer: entry.issuer ?? null,
            meta: entry.year ?? null,
        })),
        education: profile.education.map((entry) => ({
            degree: entry.degree,
            institution: entry.institution,
            meta: formatRange(entry.from, entry.to),
            note: entry.note ?? null,
        })),
        languages: profile.languages,
        watermark,
    });
}

/** Paragraphs as the model wrote them: split on blank lines, nothing rewritten. */
function letterParagraphs(letter: string): string[] {
    return letter
        .split("\n\n")
        .map((paragraph) => paragraph.trim())
        .filter(Boolean);
}

function coverLetterHtml(input: RenderInput): string {
    const {profile, jobSpec, application} = input;
    const {name, location, email, phone} = profile.basics;

    return template("cover-letter.hbs")({
        name,
        displayName: name.toUpperCase(),
        contact: [
            ...contactItem(location),
            ...contactItem(email, `mailto:${email.trim()}`),
            ...contactItem(phone),
        ],
        date: LETTER_DATE.format(input.now ?? new Date()),
        // No employer name is worth less than a wrong one: print no block at all.
        recipient: isUnknownCompany(jobSpec.company)
            ? null
            : {company: jobSpec.company.trim(), location: jobSpec.location.trim() || null},
        salutation: "Dear Hiring Team,",
        paragraphs: letterParagraphs(application.cover_letter),
        signOff: "Kind regards,",
        watermark: watermarkFor(application, input.force ?? false),
    });
}

export interface RenderedDocuments {
    cv: string;
    /** Null when the letter was skipped or blanked; there is nothing to render. */
    cover: string | null;
}

/**
 * The exact HTML both documents are rendered from. Pure and synchronous: no
 * browser, no filesystem, so the output can be asserted on directly.
 */
export function renderDocuments(input: RenderInput): RenderedDocuments {
    assertRenderable(input.application, input.force);

    const skipped = input.application.flags.includes(flags.skippedLowMatch);
    const hasLetter = input.application.cover_letter.trim().length > 0;

    return {
        cv: cvHtml(input),
        cover: skipped || !hasLetter ? null : coverLetterHtml(input),
    };
}

/* ------------------------------------------------------------------ */
/* PDF                                                                  */
/* ------------------------------------------------------------------ */

const A4_HEIGHT_MM = 297;
const A4_WIDTH_MM = 210;
const PAGE_MARGIN_Y_MM = 14;
const PAGE_MARGIN_X_MM = 16;
/** Sub-pixel layout rounding, not a licence to overflow. */
const OVERFLOW_TOLERANCE_MM = 2;

const PRINTABLE_HEIGHT_MM = A4_HEIGHT_MM - 2 * PAGE_MARGIN_Y_MM;
const PRINTABLE_WIDTH_MM = A4_WIDTH_MM - 2 * PAGE_MARGIN_X_MM;

function mmToPx(mm: number): number {
    return (mm * 96) / 25.4;
}

/** The name a recruiter receives. "cv.pdf" tells them nothing. */
function documentName(profile: Profile, jobSpec: JobSpec, kind: "cv" | "cover"): string {
    const fallback = kind === "cv" ? "cv.pdf" : "cover-letter.pdf";
    if (isUnknownCompany(jobSpec.company)) return fallback;

    const parts = profile.basics.name.trim().split(/\s+/);
    const surname = slugify(parts[parts.length - 1] ?? "");
    return `${surname}-${kind}-${slugify(jobSpec.company)}.pdf`;
}

async function loadPage(browser: Browser, html: string): Promise<Page> {
    const page = await browser.newPage();
    // Match the viewport to the printable column so scrollHeight reflects the
    // real print layout, which is what the overflow check reads.
    await page.setViewport({
        width: Math.round(mmToPx(PRINTABLE_WIDTH_MM)),
        height: Math.round(mmToPx(PRINTABLE_HEIGHT_MM)),
    });
    await page.emulateMediaType("print");
    // No network is involved: the templates inline every style and load no font.
    await page.setContent(html, {waitUntil: "load"});
    return page;
}

/** Throws if the laid-out content is taller than one printable page. */
async function assertSinglePage(page: Page, documentName: string): Promise<void> {
    // Evaluated as a string so `document` resolves in the browser context
    // rather than needing the DOM lib in this Node project's tsconfig.
    const heightPx = Number(await page.evaluate("document.documentElement.scrollHeight"));
    const limitPx = mmToPx(PRINTABLE_HEIGHT_MM + OVERFLOW_TOLERANCE_MM);
    if (heightPx <= limitPx) return;

    const overflowMm = Math.ceil(((heightPx - mmToPx(PRINTABLE_HEIGHT_MM)) * 25.4) / 96);
    throw new RenderOverflowError(
        `The ${documentName} overflows one page by about ${overflowMm}mm. ` +
            "Shorten the letter rather than the type: it is a content problem.",
    );
}

async function writePdf(page: Page, filePath: string): Promise<void> {
    await page.pdf({
        path: filePath,
        printBackground: true,
        preferCSSPageSize: true,
    });
}

export interface RenderResult {
    cvPath: string;
    /** Null when no cover letter was rendered. */
    coverPath: string | null;
}

/**
 * Writes cv.html and cover-letter.html — the exact HTML handed to the renderer,
 * which is what makes a bad document debuggable — then the PDFs beside them.
 */
export async function renderApplication(input: RenderInput): Promise<RenderResult> {
    const documents = renderDocuments(input);
    const outDir = path.resolve(input.outDir);
    await mkdir(outDir, {recursive: true});

    await writeFile(path.join(outDir, "cv.html"), documents.cv, "utf8");
    if (documents.cover) {
        await writeFile(path.join(outDir, "cover-letter.html"), documents.cover, "utf8");
    }

    const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH?.trim();
    const browser = await puppeteer.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-dev-shm-usage"],
        ...(executablePath ? {executablePath} : {}),
    });

    try {
        const cvPath = path.join(outDir, documentName(input.profile, input.jobSpec, "cv"));
        const cvPage = await loadPage(browser, documents.cv);
        await writePdf(cvPage, cvPath);

        if (!documents.cover) return {cvPath, coverPath: null};

        const coverPath = path.join(outDir, documentName(input.profile, input.jobSpec, "cover"));
        const coverPage = await loadPage(browser, documents.cover);
        await assertSinglePage(coverPage, "cover letter");
        await writePdf(coverPage, coverPath);

        return {cvPath, coverPath};
    } finally {
        await browser.close();
    }
}
