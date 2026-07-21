/*
 * tsc only emits JavaScript. The SQL schema and the web UI are runtime assets
 * that live under src/, so a build has to carry them across or `dist/` is a
 * program missing its own files.
 */
import {cp, mkdir} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

const assets = [
    ["src/tracker/schema.sql", "dist/tracker/schema.sql"],
    ["src/server/public", "dist/server/public"],
];

for (const [from, to] of assets) {
    const target = path.join(root, to);
    await mkdir(path.dirname(target), {recursive: true});
    await cp(path.join(root, from), target, {recursive: true});
    process.stdout.write(`copied ${from} -> ${to}\n`);
}
