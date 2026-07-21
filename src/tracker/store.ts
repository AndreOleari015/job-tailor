import type {JobSpec, TailoredApplication} from "../types.js";

/** Application tracking, backed by SQLite. Phase 4. */
export type ApplicationStatus =
    | "draft"
    | "applied"
    | "screening"
    | "interview"
    | "offer"
    | "rejected"
    | "withdrawn";

export interface ApplicationRecord {
    id: string;
    company: string;
    role: string;
    status: ApplicationStatus;
    matchScore: number;
    createdAt: string;
    updatedAt: string;
    outputDir: string;
    jobSpec: JobSpec;
    application: TailoredApplication;
}

export interface Store {
    save(record: ApplicationRecord): Promise<void>;
    get(id: string): Promise<ApplicationRecord | undefined>;
    list(status?: ApplicationStatus): Promise<ApplicationRecord[]>;
    setStatus(id: string, status: ApplicationStatus): Promise<void>;
}

export function openStore(_databasePath: string): Promise<Store> {
    throw new Error("NotImplemented: phase 4");
}
