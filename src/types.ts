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
    /**
     * Annual gross, in `salary_currency`. The name predates country profiles
     * and is kept so job.json files already on disk still parse; the figure is
     * no longer converted to EUR, because a conversion the posting did not
     * state is a number nobody can check.
     */
    salary_min_eur: z.number().nullable(),
    /**
     * ISO 4217 code of the figure above. Absent on stored specs written before
     * country profiles existed, where EUR was the only possibility.
     */
    salary_currency: z.string().nullable().default(null),
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
/* Country profiles                                                     */
/* ------------------------------------------------------------------ */

/**
 * What one target market needs, and what cannot be inferred for it: the salary
 * an offer has to clear, and the sentence the letter may say about the right to
 * work there.
 *
 * `salary_min: null` disables the threshold check for that country. It is never
 * read as zero: no figure means no claim, which is the only safe reading of an
 * immigration number nobody has looked up.
 */
export const countryProfileSchema = z.object({
    label: nonEmpty,
    /** ISO 4217. A posting quoted in anything else is never converted. */
    currency: nonEmpty,
    salary_min: z.number().positive().nullable(),
    salary_note: z.string().nullable().default(null),
    /** Empty means the letter says nothing about visas, permits or residence. */
    work_authorisation: z.string().default(""),
});

export const countriesFileSchema = z
    .object({
        /** The market targeted when nothing names one. */
        default: z.string().regex(/^[A-Za-z]{2}$/, "must be an ISO 3166-1 alpha-2 code"),
        countries: z.record(
            z.string().regex(/^[A-Za-z]{2}$/, "must be an ISO 3166-1 alpha-2 code"),
            countryProfileSchema,
        ),
    })
    .superRefine((file, context) => {
        const configured = Object.keys(file.countries).map((code) => code.toUpperCase());
        if (!configured.includes(file.default.toUpperCase())) {
            context.addIssue({
                code: "custom",
                path: ["default"],
                message: `"${file.default}" is not one of the configured countries (${
                    configured.join(", ") || "none"
                }).`,
            });
        }
    });

export type CountryProfile = z.infer<typeof countryProfileSchema>;
export type CountriesFile = z.infer<typeof countriesFileSchema>;

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

export const certificationEntrySchema = z.object({
    name: nonEmpty,
    issuer: z.string().optional(),
    year: z.string().optional(),
});

export const profileSchema = z.object({
    basics: basicsSchema,
    experience: z.array(experienceEntrySchema),
    projects: z.array(projectEntrySchema),
    skills: z.record(z.string(), z.array(z.string())),
    education: z.array(educationEntrySchema),
    languages: z.array(languageEntrySchema),
    certifications: z.array(certificationEntrySchema).optional(),
});

export type Bullet = z.infer<typeof bulletSchema>;
export type ExperienceEntry = z.infer<typeof experienceEntrySchema>;
export type ProjectEntry = z.infer<typeof projectEntrySchema>;
export type Basics = z.infer<typeof basicsSchema>;
export type EducationEntry = z.infer<typeof educationEntrySchema>;
export type LanguageEntry = z.infer<typeof languageEntrySchema>;
export type CertificationEntry = z.infer<typeof certificationEntrySchema>;
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

/**
 * The read schema for an `application.json` already on disk, which is
 * deliberately looser than the write schema: below `JOB_TAILOR_MIN_SCORE` the
 * cover letter is blanked on purpose, so a skipped application does not
 * satisfy `cover_letter: nonEmpty` and would fail to parse against the schema
 * that produced it. Relax the reader, never the writer.
 */
export const storedApplicationSchema = tailoredApplicationSchema.extend({
    cover_letter: z.string(),
});

/** Flags recomputed deterministically after the model responds. */
export const flags = {
    lowMatch: "LOW_MATCH",
    noSponsorship: "NO_SPONSORSHIP",
    languageRisk: "LANGUAGE_RISK",
    salaryBelowThreshold: "SALARY_BELOW_THRESHOLD",
    salaryCurrencyMismatch: "SALARY_CURRENCY_MISMATCH",
    invalidBulletIdsDropped: "INVALID_BULLET_IDS_DROPPED",
    unexpectedAuthorisationClaim: "UNEXPECTED_AUTHORISATION_CLAIM",
    missingAuthorisationClaim: "MISSING_AUTHORISATION_CLAIM",
    coverLetterRefMismatch: "COVER_LETTER_REF_MISMATCH",
    unsupportedTechClaim: "UNSUPPORTED_TECH_CLAIM",
    coverLetterTooLong: "COVER_LETTER_TOO_LONG",
    coverLetterNotParagraphed: "COVER_LETTER_NOT_PARAGRAPHED",
    skippedLowMatch: "SKIPPED_LOW_MATCH",
} as const;

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
