import type Anthropic from "@anthropic-ai/sdk";
import {readFile} from "node:fs/promises";
import {parse as parseYaml} from "yaml";
import {getCountryProfile, readCountriesPath, resolveWorkAuthorisation} from "../config.js";
import {callJson} from "../llm/client.js";
import type {LlmProvider} from "../llm/providers/index.js";
import {tailoringPrompt} from "../llm/prompts.js";
import {
    collectBullets,
    collectSkills,
    flags,
    profileSchema,
    tailoredApplicationSchema,
    type JobSpec,
    type Profile,
    type TailoredApplication,
} from "../types.js";

export interface TailorOptions {
    provider?: LlmProvider;
    client?: Anthropic;
    model?: string;
    maxRetries?: number;
}

/** True when a profile still carries the pre-3.6 `basics.work_authorisation` map. */
function hasLegacyWorkAuthorisation(parsed: unknown): boolean {
    if (!parsed || typeof parsed !== "object") return false;
    const {basics} = parsed as {basics?: unknown};
    if (!basics || typeof basics !== "object") return false;
    return "work_authorisation" in basics;
}

/** Reads and validates the YAML profile. Throws a readable error on any failure. */
export async function loadProfile(profilePath: string): Promise<Profile> {
    let raw: string;
    try {
        raw = await readFile(profilePath, "utf8");
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`Could not read the profile at "${profilePath}": ${reason}`);
    }

    let parsed: unknown;
    try {
        parsed = parseYaml(raw);
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`"${profilePath}" is not valid YAML: ${reason}`);
    }

    // Zod strips unknown keys, so a profile still holding the phase-1.6 map
    // would parse cleanly and silently stop saying anything about visas. The
    // statement has moved; say where, rather than losing it quietly.
    if (hasLegacyWorkAuthorisation(parsed)) {
        throw new Error(
            `"${profilePath}" still has basics.work_authorisation. It moved to ` +
                `${readCountriesPath()}, one statement per country under ` +
                "countries.<CODE>.work_authorisation. Copy each entry across and delete " +
                "the block from the profile.",
        );
    }

    const result = profileSchema.safeParse(parsed);
    if (!result.success) {
        const issues = result.error.issues
            .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
            .join("\n");
        throw new Error(`"${profilePath}" does not match the Profile schema:\n${issues}`);
    }
    return result.data;
}

/** Flags derived from the JobSpec and score, computed here rather than trusted from the model. */
export function computeFlags(jobSpec: JobSpec, matchScore: number): string[] {
    const computed: string[] = [];
    if (matchScore < 50) computed.push(flags.lowMatch);
    if (jobSpec.visa_sponsorship === "explicit_no") computed.push(flags.noSponsorship);
    if (jobSpec.language !== "en" && jobSpec.language !== "pt") computed.push(flags.languageRisk);

    // The threshold is a property of the country, not of the tool. Without a
    // figure for this one there is nothing to compare against, and a missing
    // figure is never read as zero — silence beats a number nobody checked.
    const country = getCountryProfile(jobSpec.country);
    const salary = jobSpec.salary_min_eur;
    if (salary !== null && country.salary_min !== null) {
        // No currency on the spec means it predates country profiles, when EUR
        // was the only figure that could arrive.
        const currency = (jobSpec.salary_currency ?? country.currency).trim().toUpperCase();
        if (currency !== country.currency.trim().toUpperCase()) {
            // Converting would invent a rate the posting never stated, so the
            // comparison is handed back to the operator instead.
            computed.push(flags.salaryCurrencyMismatch);
        } else if (salary < country.salary_min) {
            computed.push(flags.salaryBelowThreshold);
        }
    }
    return computed;
}

/**
 * Terms that indicate the letter is making a work-authorisation claim. Checked
 * only to detect a claim that should not be there; never used to write one.
 */
const AUTHORISATION_TERMS = [
    "blue card",
    "aufenthg",
    "visa",
    "work permit",
    "sponsorship",
    "right to work",
    "residence permit",
];

function normalise(text: string): string {
    return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function isWordChar(char: string | undefined): boolean {
    return char !== undefined && /[a-z0-9]/i.test(char);
}

/**
 * Case-insensitive whole-token containment. "Java" does not match
 * "JavaScript"; "React Native" does match "using React Native and Expo".
 */
function mentions(haystack: string, term: string): boolean {
    const needle = term.trim().toLowerCase();
    if (!needle) return false;

    const text = haystack.toLowerCase();
    for (let from = 0; ; ) {
        const index = text.indexOf(needle, from);
        if (index === -1) return false;
        if (!isWordChar(text[index - 1]) && !isWordChar(text[index + needle.length])) return true;
        from = index + 1;
    }
}

const COVER_LETTER_WORD_LIMIT = 200;
const COVER_LETTER_PARAGRAPH_BREAKS = 2;

function wordCount(text: string): number {
    const trimmed = text.trim();
    return trimmed ? trimmed.split(/\s+/).length : 0;
}

/** The first sentence making an authorisation claim, for the operator to read. */
function authorisationSentence(letter: string): string | undefined {
    for (const sentence of letter.split(/(?<=[.!?])\s+/)) {
        const lower = sentence.toLowerCase();
        if (AUTHORISATION_TERMS.some((term) => lower.includes(term))) return sentence.trim();
    }
    return undefined;
}

function warn(message: string): void {
    process.stderr.write(`[job-tailor] ${message}\n`);
}

/**
 * Enforces the rules the model cannot be trusted to enforce itself: every
 * selected bullet id must exist in the profile, bullet_order must contain
 * exactly the selected ids, the letter cites only selected bullets, its work
 * authorisation claim matches the job's country, and flags are recomputed.
 *
 * Nothing here rewrites the letter. Anything touching a factual claim in a
 * document sent to an employer is flagged for a human, not silently repaired.
 */
export function reconcile(
    application: TailoredApplication,
    profile: Profile,
    jobSpec: JobSpec,
): TailoredApplication {
    const bullets = collectBullets(profile);
    const known = new Set(bullets.keys());
    const letter = application.cover_letter;

    const selected: string[] = [];
    let droppedInvalid = false;
    for (const id of application.selected_bullet_ids) {
        if (!known.has(id)) {
            droppedInvalid = true;
            continue;
        }
        if (!selected.includes(id)) selected.push(id);
    }

    // Keep the model's ordering for ids it selected, then append anything it
    // selected but forgot to order.
    const ordered: string[] = [];
    for (const id of application.bullet_order) {
        if (selected.includes(id) && !ordered.includes(id)) ordered.push(id);
        else if (!known.has(id)) droppedInvalid = true;
    }
    for (const id of selected) {
        if (!ordered.includes(id)) ordered.push(id);
    }

    const merged = new Set(computeFlags(jobSpec, application.match_score));
    if (droppedInvalid) merged.add(flags.invalidBulletIdsDropped);

    // The letter may only cite bullets that were actually selected. Offending
    // refs are reported, never dropped: the letter itself needs review.
    const badRefs = application.cover_letter_bullet_refs.filter((id) => !selected.includes(id));
    if (badRefs.length) {
        merged.add(flags.coverLetterRefMismatch);
        warn(
            `cover letter cites bullets that were not selected: ${badRefs.join(", ")} ` +
                "— check the letter for facts taken from the wrong entry",
        );
    }

    // A requirement term may only reach the letter if something in the profile
    // backs it. Catches the job's own vocabulary leaking in unsupported — the
    // common shape of a re-characterisation, not a semantic check.
    const supporting = [
        ...selected.map((id) => bullets.get(id)?.text ?? ""),
        ...collectSkills(profile),
    ].join(" ");
    const unsupported = [
        ...new Set([...jobSpec.required_stack, ...jobSpec.nice_to_have]),
    ].filter((term) => mentions(letter, term) && !mentions(supporting, term));
    if (unsupported.length) {
        merged.add(flags.unsupportedTechClaim);
        warn(
            `cover letter claims "${unsupported.join('", "')}" with nothing in the ` +
                "selected bullets or the skills map behind it",
        );
    }

    const words = wordCount(letter);
    if (words > COVER_LETTER_WORD_LIMIT) {
        merged.add(flags.coverLetterTooLong);
        warn(`cover letter is ${words} words; the limit is ${COVER_LETTER_WORD_LIMIT}`);
    }

    if (letter.split("\n\n").length - 1 < COVER_LETTER_PARAGRAPH_BREAKS) {
        merged.add(flags.coverLetterNotParagraphed);
    }

    // A work-authorisation statement must match the job's country exactly, or
    // be absent entirely. Saying nothing is always safe; saying the wrong
    // thing is a false claim on a document sent to an employer.
    const expected = resolveWorkAuthorisation(jobSpec.country);
    if (expected) {
        if (!normalise(letter).includes(normalise(expected))) {
            merged.add(flags.missingAuthorisationClaim);
            warn(
                `cover letter omits the work authorisation statement for ` +
                    `${jobSpec.country ?? "this country"}`,
            );
        }
    } else {
        const claim = authorisationSentence(letter);
        if (claim) {
            merged.add(flags.unexpectedAuthorisationClaim);
            warn(
                `cover letter claims work authorisation but none applies to ` +
                    `${jobSpec.country ?? "an unknown country"}: "${claim}"`,
            );
        }
    }

    return {
        ...application,
        selected_bullet_ids: selected,
        bullet_order: ordered,
        flags: [...merged],
    };
}

/**
 * Below the threshold the letter is not worth the candidate's attention, but
 * the gaps are exactly what they need in order to move on. Keep those, drop
 * the letter. `force` bypasses the check entirely.
 */
export function applyMinScore(
    application: TailoredApplication,
    options: {minScore: number; force?: boolean},
): TailoredApplication {
    if (options.force || application.match_score >= options.minScore) return application;
    return {
        ...application,
        cover_letter: "",
        flags: [...application.flags, flags.skippedLowMatch],
    };
}

/** Produces a tailored application from the profile and a target role. */
export async function tailorApplication(
    profile: Profile,
    jobSpec: JobSpec,
    options: TailorOptions = {},
): Promise<TailoredApplication> {
    const {system, user} = tailoringPrompt(profile, jobSpec);
    const application = await callJson({
        system,
        user,
        schema: tailoredApplicationSchema,
        task: "tailor",
        ...options,
    });
    return reconcile(application, profile, jobSpec);
}
