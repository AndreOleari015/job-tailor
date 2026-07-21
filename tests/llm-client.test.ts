import type Anthropic from "@anthropic-ai/sdk";
import {mkdtemp, readdir, readFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {afterEach, describe, expect, it, vi} from "vitest";
import {z} from "zod";
import {callJson, LlmValidationError, stripCodeFences} from "../src/llm/client.js";

const schema = z.object({company: z.string(), score: z.number()});

/** Minimal stand-in for an Anthropic message response. */
function reply(text: string) {
    return {
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5",
        stop_reason: "end_turn",
        stop_sequence: null,
        content: [{type: "text", text, citations: null}],
        usage: {input_tokens: 10, output_tokens: 20},
    };
}

/** Returns a fake client that replays the given responses in order. */
function fakeClient(...texts: string[]) {
    const create = vi.fn();
    for (const text of texts) create.mockResolvedValueOnce(reply(text));
    const client = {messages: {create}} as unknown as Anthropic;
    return {client, create};
}

describe("stripCodeFences", () => {
    it("removes a tagged fence", () => {
        expect(stripCodeFences('```json\n{"a":1}\n```')).toBe('{"a":1}');
    });

    it("removes an untagged fence", () => {
        expect(stripCodeFences('```\n{"a":1}\n```')).toBe('{"a":1}');
    });

    it("leaves bare JSON untouched", () => {
        expect(stripCodeFences('{"a":1}')).toBe('{"a":1}');
    });
});

describe("callJson", () => {
    it("parses a fenced JSON response on the first attempt", async () => {
        const {client, create} = fakeClient('```json\n{"company":"Acme","score":80}\n```');

        const result = await callJson({system: "s", user: "u", schema, client});

        expect(result).toEqual({company: "Acme", score: 80});
        expect(create).toHaveBeenCalledTimes(1);
    });

    it("retries after invalid JSON and succeeds on the second attempt", async () => {
        const {client, create} = fakeClient(
            "Sure! Here you go: {company: Acme,,}",
            '{"company":"Acme","score":80}',
        );

        const result = await callJson({system: "s", user: "u", schema, client});

        expect(result).toEqual({company: "Acme", score: 80});
        expect(create).toHaveBeenCalledTimes(2);

        // The repair turn must carry the validation error back to the model.
        const secondCall = create.mock.calls[1]?.[0] as {messages: Anthropic.MessageParam[]};
        expect(secondCall.messages).toHaveLength(3);
        expect(secondCall.messages[2]?.content).toContain("JSON.parse failed");
    });

    it("retries after a schema violation and succeeds on the second attempt", async () => {
        const {client, create} = fakeClient(
            '{"company":"Acme","score":"eighty"}',
            '{"company":"Acme","score":80}',
        );

        const result = await callJson({system: "s", user: "u", schema, client});

        expect(result).toEqual({company: "Acme", score: 80});
        expect(create).toHaveBeenCalledTimes(2);
    });

    it("throws LlmValidationError after exhausting retries", async () => {
        const {client, create} = fakeClient("nope", "still nope", "nope again");

        await expect(callJson({system: "s", user: "u", schema, client})).rejects.toBeInstanceOf(
            LlmValidationError,
        );
        expect(create).toHaveBeenCalledTimes(3);
    });

    it("honours a maxRetries of 0", async () => {
        const {client, create} = fakeClient("nope");

        await expect(
            callJson({system: "s", user: "u", schema, client, maxRetries: 0}),
        ).rejects.toBeInstanceOf(LlmValidationError);
        expect(create).toHaveBeenCalledTimes(1);
    });

    it("never reaches the network", async () => {
        const {client, create} = fakeClient('{"company":"Acme","score":1}');
        await callJson({system: "s", user: "u", schema, client});
        expect(create).toHaveBeenCalledWith(expect.objectContaining({system: "s"}));
    });
});

describe("debug transcript", () => {
    const created: string[] = [];

    afterEach(async () => {
        delete process.env.DEBUG;
        delete process.env.JOB_TAILOR_OUTPUT_DIR;
        for (const dir of created.splice(0)) await rm(dir, {recursive: true, force: true});
        vi.restoreAllMocks();
    });

    async function useTempOutputDir(): Promise<string> {
        const dir = await mkdtemp(path.join(tmpdir(), "job-tailor-debug-"));
        created.push(dir);
        process.env.JOB_TAILOR_OUTPUT_DIR = dir;
        return dir;
    }

    /** Resolves the single session directory under {root}/_debug. */
    async function sessionDir(root: string): Promise<string> {
        const sessions = await readdir(path.join(root, "_debug"));
        expect(sessions).toHaveLength(1);
        return path.join(root, "_debug", sessions[0] as string);
    }

    it("writes request, response and error files under DEBUG=1", async () => {
        const root = await useTempOutputDir();
        process.env.DEBUG = "1";
        vi.spyOn(process.stderr, "write").mockReturnValue(true);

        const {client} = fakeClient(
            "here you go: {broken,,}",
            '```json\n{"company":"Acme","score":80}\n```',
        );

        await callJson({system: "sys", user: "usr", schema, client, task: "extract"});

        const dir = await sessionDir(root);
        const files = (await readdir(dir)).sort();

        expect(files).toEqual([
            "extract-1-error.txt",
            "extract-1-request.json",
            "extract-1-response.txt",
            "extract-2-request.json",
            "extract-2-response.txt",
        ]);

        // The successful attempt produced no error file.
        expect(files).not.toContain("extract-2-error.txt");

        const request = JSON.parse(await readFile(path.join(dir, "extract-1-request.json"), "utf8"));
        expect(request).toMatchObject({
            provider: "anthropic",
            model: "claude-sonnet-4-5",
            system: "sys",
            user: "usr",
            history: [],
            jsonSchema: null,
        });

        // Raw text, before fence stripping.
        const response = await readFile(path.join(dir, "extract-2-response.txt"), "utf8");
        expect(response).toBe('```json\n{"company":"Acme","score":80}\n```');

        expect(await readFile(path.join(dir, "extract-1-error.txt"), "utf8")).toContain(
            "JSON.parse failed",
        );

        // The repair attempt records the conversation it was sent.
        const repair = JSON.parse(await readFile(path.join(dir, "extract-2-request.json"), "utf8"));
        expect(repair.history).toHaveLength(2);
        expect(repair.history[1].text).toContain("JSON.parse failed");
    });

    it("writes nothing when DEBUG is unset", async () => {
        const root = await useTempOutputDir();
        delete process.env.DEBUG;

        const {client} = fakeClient('{"company":"Acme","score":80}');
        await callJson({system: "sys", user: "usr", schema, client, task: "extract"});

        expect(await readdir(root)).toEqual([]);
    });
});
