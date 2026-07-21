import type {Bullet, JobSpec, Profile} from "../types.js";

/** Deterministic, tag-based relevance scoring. Phase 2. */
export interface ScoredBullet {
    bullet: Bullet;
    score: number;
    matchedTags: string[];
}

export interface MatchReport {
    score: number;
    covered: string[];
    missing: string[];
    ranked: ScoredBullet[];
}

/** Scores the profile against a JobSpec without calling the LLM. */
export function scoreMatch(_profile: Profile, _jobSpec: JobSpec): MatchReport {
    throw new Error("NotImplemented: phase 2");
}

/** Ranks bullets by tag overlap with the required stack and responsibilities. */
export function rankBullets(_profile: Profile, _jobSpec: JobSpec): ScoredBullet[] {
    throw new Error("NotImplemented: phase 2");
}
