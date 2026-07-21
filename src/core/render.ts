import type {JobSpec, Profile, TailoredApplication} from "../types.js";

/** CV and cover-letter rendering (handlebars templates, PDF via puppeteer). Phase 2. */
export type RenderFormat = "html" | "pdf" | "markdown";

export interface RenderRequest {
    profile: Profile;
    jobSpec: JobSpec;
    application: TailoredApplication;
    format: RenderFormat;
    outputDir: string;
}

export interface RenderResult {
    cvPath: string;
    coverLetterPath: string;
}

export function renderApplication(_request: RenderRequest): Promise<RenderResult> {
    throw new Error("NotImplemented: phase 2");
}
