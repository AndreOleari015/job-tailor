import {authenticate} from "@google-cloud/local-auth";
import {readFile, rm, writeFile} from "node:fs/promises";
import {Auth, google} from "googleapis";
import {GMAIL_CREDENTIALS_PATH, GMAIL_TOKEN_PATH} from "../../config.js";

/** Read only. The tool never modifies a message, never sends, never deletes. */
export const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];

export class GmailAuthError extends Error {
    override readonly name = "GmailAuthError";
}

async function readJson(path: string): Promise<unknown | null> {
    try {
        return JSON.parse(await readFile(path, "utf8")) as unknown;
    } catch {
        return null;
    }
}

/** An authorised client from the cached token, or null when there is none. */
async function fromSavedToken(): Promise<Auth.OAuth2Client | null> {
    const saved = await readJson(GMAIL_TOKEN_PATH);
    if (!saved) return null;
    return google.auth.fromJSON(
        saved as Parameters<typeof google.auth.fromJSON>[0],
    ) as unknown as Auth.OAuth2Client;
}

/** Persists just the refresh token, in the shape `google.auth.fromJSON` reads. */
async function saveToken(client: Auth.OAuth2Client): Promise<void> {
    const keys = (await readJson(GMAIL_CREDENTIALS_PATH)) as
        | {installed?: Record<string, string>; web?: Record<string, string>}
        | null;
    const key = keys?.installed ?? keys?.web;
    if (!key) return;

    await writeFile(
        GMAIL_TOKEN_PATH,
        JSON.stringify({
            type: "authorized_user",
            client_id: key["client_id"],
            client_secret: key["client_secret"],
            refresh_token: client.credentials.refresh_token,
        }),
        "utf8",
    );
}

/**
 * Runs the desktop OAuth flow: opens a browser, the user consents, the refresh
 * token is cached. Called only by `gmail auth`, never implicitly, so consent is
 * always a deliberate act.
 */
export async function runAuthFlow(): Promise<Auth.OAuth2Client> {
    if (!(await readJson(GMAIL_CREDENTIALS_PATH))) {
        throw new GmailAuthError(
            `No OAuth credentials at ${GMAIL_CREDENTIALS_PATH}. Create a Desktop OAuth client in ` +
                "the Google Cloud console, download the JSON, and save it there. See the README.",
        );
    }

    const client = (await authenticate({
        scopes: GMAIL_SCOPES,
        keyfilePath: GMAIL_CREDENTIALS_PATH,
    })) as unknown as Auth.OAuth2Client;
    if (client.credentials.refresh_token) await saveToken(client);
    return client;
}

/** An authorised client, or a readable error telling the user to run `gmail auth`. */
export async function loadAuth(): Promise<Auth.OAuth2Client> {
    const client = await fromSavedToken();
    if (!client) {
        throw new GmailAuthError(
            "Gmail is not authorised. Run `job-tailor gmail auth` first (read-only access).",
        );
    }
    return client;
}

export async function hasToken(): Promise<boolean> {
    return (await fromSavedToken()) !== null;
}

/** Deletes the cached token. The next fetch will need `gmail auth` again. */
export async function revokeToken(): Promise<boolean> {
    try {
        await rm(GMAIL_TOKEN_PATH);
        return true;
    } catch {
        return false;
    }
}
