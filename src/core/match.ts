import {collectBullets, collectSkills, type JobSpec, type Profile} from "../types.js";

/**
 * A deterministic, zero-cost pre-filter, computed before the tailoring call so
 * an obviously irrelevant posting can be skipped without spending a request.
 *
 * It is a filter, not a judgement: it never reaches an output document, and it
 * is not the `match_score` the model returns. A high pre-score means "worth
 * asking the model about", nothing more.
 */
export interface PreScore {
    /** 0-100, the share of requirement weight backed by a term in the profile. */
    score: number;
    matchedTerms: string[];
    missingTerms: string[];
}

const REQUIRED_WEIGHT = 2;
const NICE_TO_HAVE_WEIGHT = 1;

/**
 * Spelling variants of the same term, not synonyms. Every group here is a
 * different way of writing one technology; nothing semantic belongs in it.
 * Firebase is not AWS, and no alias will ever say otherwise.
 */
const ALIASES: Record<string, string[]> = {
    "react native": ["react-native", "rn"],
    "node.js": ["node", "nodejs"],
    typescript: ["ts"],
    "ci/cd": ["ci-cd", "cicd"],
    "rest apis": ["rest"],
};

/** Every spelling of a term, keyed by each of its spellings. */
const EQUIVALENTS = new Map<string, readonly string[]>(
    Object.entries(ALIASES).flatMap(([canonical, aliases]) => {
        const group = [canonical, ...aliases];
        return group.map((form) => [form, group] as const);
    }),
);

function normalise(term: string): string {
    return term.replace(/\s+/g, " ").trim().toLowerCase();
}

/** The term itself plus its other spellings. Never a semantic expansion. */
function formsOf(term: string): readonly string[] {
    const normalised = normalise(term);
    return EQUIVALENTS.get(normalised) ?? [normalised];
}

/** Everything the profile claims: declared skills plus every bullet tag. */
function candidateTerms(profile: Profile): Set<string> {
    const terms = new Set<string>();
    const add = (term: string): void => {
        for (const form of formsOf(term)) terms.add(form);
    };

    for (const skill of collectSkills(profile)) add(skill);
    for (const bullet of collectBullets(profile).values()) {
        for (const tag of bullet.tags) add(tag);
    }
    return terms;
}

interface Requirement {
    display: string;
    weight: number;
}

/** Requirements by normalised term. A term stated twice counts once, at its heavier weight. */
function requirements(jobSpec: JobSpec): Map<string, Requirement> {
    const collected = new Map<string, Requirement>();
    const add = (term: string, weight: number): void => {
        const key = normalise(term);
        if (!key || collected.has(key)) return;
        collected.set(key, {display: term.trim(), weight});
    };

    for (const term of jobSpec.required_stack) add(term, REQUIRED_WEIGHT);
    for (const term of jobSpec.nice_to_have) add(term, NICE_TO_HAVE_WEIGHT);
    return collected;
}

/**
 * Scores the profile against a posting without calling the LLM. Exact matching
 * on normalised terms, widened only by the alias table above — no fuzzy or
 * semantic matching, because a filter that guesses is worse than no filter.
 */
export function preScore(profile: Profile, jobSpec: JobSpec): PreScore {
    const candidate = candidateTerms(profile);
    const required = requirements(jobSpec);

    const matchedTerms: string[] = [];
    const missingTerms: string[] = [];
    let matchedWeight = 0;
    let totalWeight = 0;

    for (const [term, {display, weight}] of required) {
        totalWeight += weight;
        if (formsOf(term).some((form) => candidate.has(form))) {
            matchedWeight += weight;
            matchedTerms.push(display);
        } else {
            missingTerms.push(display);
        }
    }

    // No stated requirements is no basis on which to reject a posting.
    const score = totalWeight === 0 ? 100 : Math.round((100 * matchedWeight) / totalWeight);
    return {score, matchedTerms, missingTerms};
}
