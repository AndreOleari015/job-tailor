import {SALARY_THRESHOLD_EUR} from "../config.js";
import type {JobSpec, Profile} from "../types.js";

export interface Prompt {
    system: string;
    user: string;
}

const JOB_SPEC_SCHEMA = `{
  "company": string,
  "role": string,
  "location": string,
  "country": string | null,
  "remote": "onsite" | "hybrid" | "remote" | "unknown",
  "language": "en" | "de" | "pt" | "other",
  "seniority": "junior" | "mid" | "senior" | "lead" | "unknown",
  "required_stack": string[],
  "nice_to_have": string[],
  "salary_min_eur": number | null,
  "visa_sponsorship": "explicit_yes" | "explicit_no" | "not_mentioned",
  "key_responsibilities": string[],
  "tone": "corporate" | "startup" | "agency"
}`;

const TAILORED_APPLICATION_SCHEMA = `{
  "selected_bullet_ids": string[],
  "bullet_order": string[],
  "cover_letter_bullet_refs": string[],
  "headline": string,
  "profile_summary": string,
  "cover_letter": string,
  "match_score": number,
  "gaps": string[],
  "flags": string[]
}`;

export function extractionPrompt(jobText: string): Prompt {
    const system =
        "You parse job descriptions into structured data. You return only valid JSON " +
        "matching the requested schema. You never infer facts that are not present in " +
        "the source text.";

    const user = `Return ONLY valid JSON matching this schema:
${JOB_SPEC_SCHEMA}

Rules:
- Do not infer facts not present in the text. Use null / "unknown" /
  "not_mentioned" when the information is absent.
- company: the hiring organisation's name. Look in the document title, header
  lines, "About [X]" sections, "at [X] we..." phrasing, and email domains. If a
  line of the form "Company: X" appears anywhere in the input, use X verbatim
  and do not override it from elsewhere in the text. Only return "unknown" if
  no organisation name appears anywhere in the input.
- required_stack: only technologies stated as requirements, not nice-to-haves.
- nice_to_have: technologies described as a plus, bonus or desirable.
- salary_min_eur: annual gross in EUR. Convert monthly figures (x12).
  Convert other currencies only if a rate is stated; otherwise null.
- country: infer the ISO 3166-1 alpha-2 code from the stated location. If the
  location is ambiguous or absent, return null. Do not guess from company name
  or language.
- visa_sponsorship: return "explicit_yes" ONLY if the text explicitly offers
  sponsorship, relocation support or states that visa applicants are welcome.
  Return "explicit_no" ONLY if the text explicitly states that sponsorship is
  not available, or that applicants must already hold the right to work.
  Requirements such as nationality, security clearance, or being locally based
  are NOT sponsorship statements. In every other case, including total silence
  on the subject, return "not_mentioned". Silence is not a refusal.
- language: the language the application should be written in, inferred from
  the posting language and any explicit requirement.
- tone: infer from the writing style of the posting.

JOB DESCRIPTION:
"""
${jobText}
"""`;

    return {system, user};
}

export function tailoringPrompt(profile: Profile, jobSpec: JobSpec): Prompt {
    const system =
        "You tailor job applications. You may only use facts present in the candidate " +
        "profile provided. You never invent experience, employers, dates, numbers or " +
        "technologies. You return only valid JSON.";

    const user = `CANDIDATE PROFILE (the only facts you may use):
${JSON.stringify(profile, null, 2)}

TARGET ROLE:
${JSON.stringify(jobSpec, null, 2)}

Return ONLY valid JSON matching this schema:
${TAILORED_APPLICATION_SCHEMA}

HARD RULES:
- selected_bullet_ids MUST be ids that exist in the profile. Never invent
  bullets. Never alter the factual content of a bullet.
- From each experience entry, select 3-5 bullets, prioritising overlap with
  required_stack and key_responsibilities.
- From projects, select 1-3 bullets total, choosing those most relevant to the
  role. Projects demonstrate independent delivery and should be included
  unless entirely irrelevant to the target role.
- bullet_order: the selected ids, ordered most to least relevant. It may
  interleave experience and project bullets by relevance.
- headline: max 8 words, describing the candidate's actual profile, not the
  posting's title. Never assert a seniority level ("Senior", "Lead",
  "Principal", "Staff") unless the profile itself states it. Mirror the domain
  and stack of the target role, not its rank.
- profile_summary: max 3 sentences, rewritten only from profile facts. Written
  in implicit first person, CV register. Never use the candidate's name, "he",
  "she", or "I". Begin with the professional identity, e.g. "Software Engineer
  with four years...".
- cover_letter: 150-200 words, hard maximum 200. Count them. Written in
  ${jobSpec.language}, tone matching ${jobSpec.tone}. No em dashes.
- Structure the letter as exactly three paragraphs separated by a blank line
  ("\\n\\n"):
  1. Opening: the company, its product, or the problem the role solves.
     2-3 sentences. Never about the candidate.
  2. Evidence: two concrete achievements from cover_letter_bullet_refs, with
     their numbers, chosen for relevance to key_responsibilities.
     3-4 sentences.
  3. Close: one sentence on why this role specifically, then the work
     authorisation statement if one applies. 2 sentences maximum.
- Banned phrases anywhere in the letter, including paraphrases: "I am adept
  at", "proven track record", "demonstrating a consistent ability", "strong
  background in", "passionate about", "leverage", "robust solutions",
  "seamless", "cutting-edge", "fast-paced environment".
- The first sentence must state something specific about the company, its
  product, or one of the key_responsibilities. It must not be about the
  candidate.
- The letter must not open with any variant of: "I am writing", "I am excited",
  "I am keen", "I would like to express", "I am reaching out", "I am
  delighted", "As a [role] with N years". These are banned openings, including
  paraphrases.
- If the JobSpec contains no company-specific detail (company is "unknown" and
  key_responsibilities are generic), open with a concrete statement about the
  problem the role exists to solve, still not about the candidate.
- cover_letter_bullet_refs: the ids of every profile bullet whose factual
  content appears in the cover letter. Must be a subset of selected_bullet_ids.
- Every factual claim in the letter must come from a bullet listed in
  cover_letter_bullet_refs. Do not reference achievements, numbers, employers
  or projects that are not in that list.
- If any project bullet is in selected_bullet_ids and is relevant to the role,
  at least one project bullet must appear in cover_letter_bullet_refs. An
  independently shipped and published product is stronger evidence than a
  contribution to an employer's codebase.
- Do not re-attribute a project bullet to an employment entry, or vice versa.
  Bullets belong to the entry they are nested under.
- Do not re-characterise a technology, tool or achievement to make it match a
  job requirement. Describe each item as the profile describes it. If the
  profile says "RevenueCat subscription flows", the letter may not call it
  "payment platform integration", "payments experience" or similar.
- Where the candidate lacks a required technology, say nothing about it. Do not
  substitute an adjacent technology and imply equivalence.
- Adjacency is not experience. Firebase is not AWS. Firestore is not MongoDB.
  Subscription billing is not payment processing. CI/CD is not DevOps
  ownership.
- Work authorisation: look up work_authorisation[jobSpec.country]. If it exists
  and is a non-empty string, close the letter with that statement verbatim,
  unaltered. If jobSpec.country is null, or there is no entry, or the entry is
  empty, DO NOT mention work authorisation, visas, permits or residence status
  anywhere in the letter. Say nothing rather than something inapplicable.
- match_score: 0-100, honest assessment of fit against required_stack and
  seniority.
- gaps: requirements in the posting the candidate does not meet. Be blunt.
  This field is for the candidate's own decision-making, never shown to the
  employer.
- flags: include "LOW_MATCH" if match_score < 50, "NO_SPONSORSHIP" if
  visa_sponsorship is "explicit_no", "LANGUAGE_RISK" if language is neither
  "en" nor "pt", "SALARY_BELOW_THRESHOLD" if salary_min_eur is not null and
  below ${SALARY_THRESHOLD_EUR}.`;

    return {system, user};
}
