import {z} from "zod";

const nonEmpty = z.string().min(1);

/* ------------------------------------------------------------------ */
/* Job specification                                                    */
/* ------------------------------------------------------------------ */

export const remoteSchema = z.enum(["onsite", "hybrid", "remote", "unknown"]);
export const applicationLanguageSchema = z.enum(["en", "de", "pt", "other"]);
export const senioritySchema = z.enum(["junior", "mid", "senior", "lead", "unknown"]);
export const visaSponsorshipSchema = z.enum(["explicit_yes", "explicit_no", "not_mentioned"]);
export const toneSchema = z.enum(["corporate", "startup", "agency"]);

export const jobSpecSchema = z.object({
    company: nonEmpty,
    role: nonEmpty,
    location: z.string(),
    /** ISO 3166-1 alpha-2, derived from the location. Null when ambiguous. */
    country: z.string().nullable(),
    remote: remoteSchema,
    language: applicationLanguageSchema,
    seniority: senioritySchema,
    required_stack: z.array(z.string()),
    nice_to_have: z.array(z.string()),
    salary_min_eur: z.number().nullable(),
    visa_sponsorship: visaSponsorshipSchema,
    key_responsibilities: z.array(z.string()),
    tone: toneSchema,
});

export type JobSpec = z.infer<typeof jobSpecSchema>;
export type Remote = z.infer<typeof remoteSchema>;
export type ApplicationLanguage = z.infer<typeof applicationLanguageSchema>;
export type Seniority = z.infer<typeof senioritySchema>;
export type VisaSponsorship = z.infer<typeof visaSponsorshipSchema>;
export type Tone = z.infer<typeof toneSchema>;

/* ------------------------------------------------------------------ */
/* Candidate profile                                                    */
/* ------------------------------------------------------------------ */

export const bulletSchema = z.object({
    id: nonEmpty,
    text: nonEmpty,
    tags: z.array(z.string()),
});

export const experienceEntrySchema = z.object({
    id: nonEmpty,
    role: nonEmpty,
    company: nonEmpty,
    from: nonEmpty,
    to: nonEmpty,
    location: z.string().optional(),
    bullets: z.array(bulletSchema),
});

export const projectEntrySchema = z.object({
    id: nonEmpty,
    name: nonEmpty,
    description: z.string(),
    url: z.string().optional(),
    bullets: z.array(bulletSchema),
});

export const basicsSchema = z.object({
    name: nonEmpty,
    email: nonEmpty,
    phone: z.string(),
    github: z.string(),
    linkedin: z.string(),
    location: z.string(),
    /**
     * Work-authorisation statement per ISO 3166-1 alpha-2 country code. An empty
     * string means no statement applies there, and nothing may be said.
     */
    work_authorisation: z.record(z.string(), z.string()),
});

export const educationEntrySchema = z.object({
    degree: nonEmpty,
    institution: nonEmpty,
    from: nonEmpty,
    to: nonEmpty,
    note: z.string().optional(),
});

export const languageEntrySchema = z.object({
    language: nonEmpty,
    level: nonEmpty,
});

export const profileSchema = z.object({
    basics: basicsSchema,
    experience: z.array(experienceEntrySchema),
    projects: z.array(projectEntrySchema),
    skills: z.record(z.string(), z.array(z.string())),
    education: z.array(educationEntrySchema),
    languages: z.array(languageEntrySchema),
});

export type Bullet = z.infer<typeof bulletSchema>;
export type ExperienceEntry = z.infer<typeof experienceEntrySchema>;
export type ProjectEntry = z.infer<typeof projectEntrySchema>;
export type Basics = z.infer<typeof basicsSchema>;
export type EducationEntry = z.infer<typeof educationEntrySchema>;
export type LanguageEntry = z.infer<typeof languageEntrySchema>;
export type Profile = z.infer<typeof profileSchema>;

/* ------------------------------------------------------------------ */
/* Tailored application                                                 */
/* ------------------------------------------------------------------ */

export const tailoredApplicationSchema = z.object({
    selected_bullet_ids: z.array(z.string()),
    bullet_order: z.array(z.string()),
    /** Bullets whose factual content appears in the letter; a subset of the above. */
    cover_letter_bullet_refs: z.array(z.string()),
    headline: nonEmpty,
    profile_summary: nonEmpty,
    cover_letter: nonEmpty,
    match_score: z.number().min(0).max(100),
    gaps: z.array(z.string()),
    flags: z.array(z.string()),
});

export type TailoredApplication = z.infer<typeof tailoredApplicationSchema>;

/** Flags recomputed deterministically after the model responds. */
export const flags = {
    lowMatch: "LOW_MATCH",
    noSponsorship: "NO_SPONSORSHIP",
    languageRisk: "LANGUAGE_RISK",
    salaryBelowThreshold: "SALARY_BELOW_THRESHOLD",
    invalidBulletIdsDropped: "INVALID_BULLET_IDS_DROPPED",
    unexpectedAuthorisationClaim: "UNEXPECTED_AUTHORISATION_CLAIM",
    missingAuthorisationClaim: "MISSING_AUTHORISATION_CLAIM",
    coverLetterRefMismatch: "COVER_LETTER_REF_MISMATCH",
    unsupportedTechClaim: "UNSUPPORTED_TECH_CLAIM",
    coverLetterTooLong: "COVER_LETTER_TOO_LONG",
    coverLetterNotParagraphed: "COVER_LETTER_NOT_PARAGRAPHED",
    skippedLowMatch: "SKIPPED_LOW_MATCH",
} as const;

/**
 * The work-authorisation statement that applies to a job's country, or
 * undefined when the country is unknown, absent from the profile, or blank.
 * Undefined means the letter must say nothing about authorisation at all.
 */
export function resolveWorkAuthorisation(
    profile: Profile,
    country: string | null,
): string | undefined {
    if (!country) return undefined;
    const statement = profile.basics.work_authorisation[country.trim().toUpperCase()];
    return statement && statement.trim() ? statement : undefined;
}

/** Every bullet in the profile by id, across experience and projects. */
export function collectBullets(profile: Profile): Map<string, Bullet> {
    const bullets = new Map<string, Bullet>();
    for (const entry of profile.experience) {
        for (const bullet of entry.bullets) bullets.set(bullet.id, bullet);
    }
    for (const project of profile.projects) {
        for (const bullet of project.bullets) bullets.set(bullet.id, bullet);
    }
    return bullets;
}

/** Every bullet id present in the profile, across experience and projects. */
export function collectBulletIds(profile: Profile): Set<string> {
    return new Set(collectBullets(profile).keys());
}

/** Every skill term the profile declares, flattened across categories. */
export function collectSkills(profile: Profile): string[] {
    return Object.values(profile.skills).flat();
}
