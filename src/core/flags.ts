import {flags} from "../types.js";

/**
 * What each flag means in words, and what to do about it.
 *
 * The constants themselves never change — they are the contract between
 * `reconcile()`, the renderer, the tracker and `--json`, and they are what the
 * README documents. This is the layer that turns them into something a person
 * reads at 9pm before deciding whether to send an application.
 *
 * One table, shared: the CLI imports it, and the web UI fetches it from
 * `/api/flags` rather than keeping a second copy that would drift.
 */
export interface FlagInfo {
    label: string;
    detail: string;
    /** True when the renderer refuses to produce a PDF while it is present. */
    blocking?: boolean;
}

export const FLAG_INFO: Record<string, FlagInfo> = {
    [flags.unsupportedTechClaim]: {
        label: "Unbacked tech claim",
        detail:
            "The letter names a technology from the posting that no selected bullet and no " +
            "skill in your profile backs up. Cut it, or replace it with work you have really done.",
        blocking: true,
    },
    [flags.unexpectedAuthorisationClaim]: {
        label: "Wrong visa claim",
        detail:
            "The letter says something about visas, permits or residence that does not apply in " +
            "this country. Delete the sentence — saying nothing is always safe.",
        blocking: true,
    },
    [flags.coverLetterRefMismatch]: {
        label: "Cites unselected bullets",
        detail:
            "The letter draws on CV bullets that were not selected for it, which usually means a " +
            "fact was taken from the wrong job or project. Check every claim against your profile.",
        blocking: true,
    },
    [flags.invalidBulletIdsDropped]: {
        label: "Invented bullets dropped",
        detail:
            "The model referred to CV bullets that do not exist in your profile. They were " +
            "removed, but read the letter: the prose around them may be invented too.",
        blocking: true,
    },
    [flags.missingAuthorisationClaim]: {
        label: "Visa line missing",
        detail:
            "You have a work-authorisation statement for this country and the letter leaves it " +
            "out. Paste it into the closing paragraph.",
    },
    [flags.coverLetterTooLong]: {
        label: "Letter too long",
        detail: "Over 200 words. Cut it back, or it will not fit on one page.",
    },
    [flags.coverLetterNotParagraphed]: {
        label: "Not paragraphed",
        detail:
            "The letter is fewer than three paragraphs. Split it into opening, evidence and " +
            "close with blank lines between them.",
    },
    [flags.lowMatch]: {
        label: "Low match",
        detail: "The model scored this under 50. Read the gaps before spending time on it.",
    },
    [flags.skippedLowMatch]: {
        label: "Letter skipped",
        detail:
            "The match was below your minimum, so no letter was written. The gaps are still " +
            "worth reading. Re-run with --force if you want one anyway.",
    },
    [flags.noSponsorship]: {
        label: "No sponsorship",
        detail:
            "The posting states it does not sponsor visas. Nothing is wrong with the letter — " +
            "the job may simply not be open to you.",
    },
    [flags.languageRisk]: {
        label: "Other language",
        detail:
            "The letter is not in English or Portuguese. The authorisation checks only read " +
            "English, so they stayed silent here: review those sentences yourself.",
    },
    [flags.salaryBelowThreshold]: {
        label: "Salary below threshold",
        detail: "The stated salary is under the figure set for this country in countries.yaml.",
    },
    [flags.salaryCurrencyMismatch]: {
        label: "Other currency",
        detail:
            "The salary is quoted in a different currency, so it was not compared. No rate was " +
            "invented — check it by hand.",
    },
};

/** The flags that stop a PDF being produced, in the order they are checked. */
export const BLOCKING_FLAG_CODES: readonly string[] = Object.entries(FLAG_INFO)
    .filter(([, info]) => info.blocking)
    .map(([code]) => code);

/**
 * A flag as words. An unmapped code degrades to its own words rather than
 * appearing as a constant, so a flag added later can never regress the output.
 */
export function flagLabel(code: string): string {
    return FLAG_INFO[code]?.label ?? code.toLowerCase().replace(/_/g, " ");
}

/** The label with the sentence explaining it, when there is one. */
export function describeFlag(code: string): string {
    const info = FLAG_INFO[code];
    return info ? `${info.label} — ${info.detail}` : flagLabel(code);
}
