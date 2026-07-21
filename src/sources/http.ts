import pLimit from "p-limit";

/** Identifies the tool to every server it talks to. Not optional, not disguised. */
export const USER_AGENT =
    "job-tailor/0.1 (+https://github.com/AndreOleari015/job-tailor) personal job-application tool";

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 2_000;
const MAX_RETRY_AFTER_MS = 60_000;

/** One outbound-request budget shared by every source in a run. */
const GLOBAL_CONCURRENCY = 3;

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class HttpError extends Error {
    override readonly name = "HttpError";
    readonly status: number;

    constructor(status: number, url: string, body: string) {
        super(`HTTP ${status} from ${url}${body ? `: ${body.slice(0, 200)}` : ""}`);
        this.status = status;
    }
}

export interface HttpOptions {
    fetch?: FetchLike;
    /** Injectable so the backoff is tested without real waiting. */
    sleep?: (ms: number) => Promise<void>;
    concurrency?: number;
}

export interface GetJsonOptions {
    headers?: Record<string, string>;
    /** Labels the request in stderr warnings. */
    label?: string;
}

export interface HttpClient {
    getJson<T>(url: string, options?: GetJsonOptions): Promise<T>;
}

function defaultSleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function warn(message: string): void {
    process.stderr.write(`[job-tailor] ${message}\n`);
}

function isRetryable(status: number): boolean {
    return status === 429 || status >= 500;
}

/**
 * A server asking for a specific wait is obeyed over our own backoff — that is
 * the whole point of the header. Capped so a hostile value cannot stall a run.
 */
function retryAfterMs(response: Response): number | null {
    const header = response.headers.get("retry-after");
    if (!header) return null;

    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);

    const when = Date.parse(header);
    if (Number.isNaN(when)) return null;
    return Math.min(Math.max(when - Date.now(), 0), MAX_RETRY_AFTER_MS);
}

/** Exponential with jitter, so parallel retries do not resynchronise. */
function backoffMs(attempt: number): number {
    return BACKOFF_BASE_MS * 2 ** (attempt - 1) + Math.floor(Math.random() * 500);
}

export function createHttp(options: HttpOptions = {}): HttpClient {
    const doFetch: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
    const sleep = options.sleep ?? defaultSleep;
    const limit = pLimit(options.concurrency ?? GLOBAL_CONCURRENCY);

    async function attemptOnce(url: string, headers: Record<string, string>): Promise<Response> {
        return doFetch(url, {
            headers: {"user-agent": USER_AGENT, accept: "application/json", ...headers},
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
    }

    async function getJson<T>(url: string, request: GetJsonOptions = {}): Promise<T> {
        const label = request.label ?? url;

        return limit(async () => {
            let lastError: unknown;

            for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
                try {
                    const response = await attemptOnce(url, request.headers ?? {});
                    if (response.ok) return (await response.json()) as T;

                    const body = await response.text().catch(() => "");
                    if (!isRetryable(response.status) || attempt === MAX_ATTEMPTS) {
                        throw new HttpError(response.status, url, body);
                    }

                    const wait = retryAfterMs(response) ?? backoffMs(attempt);
                    warn(
                        `${label}: HTTP ${response.status}, retrying in ${Math.round(wait / 1000)}s ` +
                            `(attempt ${attempt}/${MAX_ATTEMPTS})`,
                    );
                    await sleep(wait);
                } catch (error) {
                    // A thrown HttpError on the final attempt is the real answer.
                    if (error instanceof HttpError) throw error;

                    lastError = error;
                    if (attempt === MAX_ATTEMPTS) break;

                    const wait = backoffMs(attempt);
                    const reason = error instanceof Error ? error.message : String(error);
                    warn(
                        `${label}: ${reason}, retrying in ${Math.round(wait / 1000)}s ` +
                            `(attempt ${attempt}/${MAX_ATTEMPTS})`,
                    );
                    await sleep(wait);
                }
            }

            const reason = lastError instanceof Error ? lastError.message : String(lastError);
            throw new Error(`${label}: giving up after ${MAX_ATTEMPTS} attempts — ${reason}`);
        });
    }

    return {getJson};
}
