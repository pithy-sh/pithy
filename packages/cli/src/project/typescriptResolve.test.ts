// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";

const run = promisify(execFile);

/**
 * **An adopter's config imports their own modules, and node has to find them.**
 *
 * `pithy.config.ts` is loaded with a plain dynamic `import()`. Under Bun — which ran the CLI until
 * #481 — `./src/secret/registry` resolved to `registry.ts`, which is how every TypeScript project is
 * written. Under node it does not, and published 0.1.4 answered every command with
 * `Nothing resolves ".../apps/board/src/secret/registry"` for a file that was sitting right there.
 *
 * **Driven in a child `node`, never in this process.** `registerHooks` is global and permanent, so a
 * test that registered it here would make every later test in this file's worker resolve TypeScript
 * whether or not the code under test did — and the assertion would hold with the hook deleted. A child
 * process is the only place the answer is about the code rather than about the runner. Vitest also
 * transforms modules itself, so the in-process resolver is not the one an adopter meets.
 */

const HOOK = fileURLToPath(new URL("./typescriptResolve.ts", import.meta.url));

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A project whose entry imports `./nested/thing` with no extension, plus whatever else `files` says. */
async function project(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pithy-tsresolve-"));
  dirs.push(dir);
  for (const [path, source] of Object.entries(files)) {
    const at = join(dir, path);
    await mkdir(dirname(at), { recursive: true });
    await writeFile(at, source);
  }
  return dir;
}

/** Import `entry` in a child node, with the hook registered exactly as `importConfig` registers it. */
async function importWithHook(dir: string, entry: string): Promise<{ ok: boolean; output: string }> {
  const runner = join(dir, "runner.mjs");
  await writeFile(
    runner,
    `import { pathToFileURL } from "node:url";\n` +
      `const { registerTypeScriptResolution } = await import(${JSON.stringify(pathToFileURLString(HOOK))});\n` +
      `await registerTypeScriptResolution();\n` +
      `const mod = await import(pathToFileURL(${JSON.stringify(join(dir, entry))}).href);\n` +
      `console.log(JSON.stringify(mod.default));\n`,
  );
  try {
    const { stdout } = await run(process.execPath, [runner], { cwd: dir });
    return { ok: true, output: stdout.trim() };
  } catch (cause) {
    const failure = cause as { stderr?: string; stdout?: string };
    return { ok: false, output: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
  }
}

/** `HOOK` as a URL string — the child imports it by path, and it is TypeScript node must strip. */
function pathToFileURLString(path: string): string {
  return new URL(`file://${path}`).href;
}

describe("the hook is optional, because the runtime that needs it is the one that has it", () => {
  // A static `import { registerHooks } from "node:module"` is a parse-time failure on a runtime that
  // does not export it, so this did not degrade under Bun — it stopped `pithy` starting there at all.
  // `bin.test.ts` spawns the CLI under Bun and reported it immediately.
  test("registering is a no-op where registerHooks does not exist", async () => {
    const dir = await project({
      "src/thing.ts": `export const which = "ts";\n`,
      "entry.ts": `import { which } from "./src/thing.ts";\nexport default { which };\n`,
    });
    const runner = join(dir, "runner.mjs");
    await writeFile(
      runner,
      `import { pathToFileURL } from "node:url";\n` +
        `const mod = await import("node:module");\n` +
        `delete mod.default?.registerHooks;\n` +
        `const { registerTypeScriptResolution } = await import(${JSON.stringify(pathToFileURLString(HOOK))});\n` +
        `await registerTypeScriptResolution();\n` +
        `const loaded = await import(pathToFileURL(${JSON.stringify(join(dir, "entry.ts"))}).href);\n` +
        `console.log(JSON.stringify(loaded.default));\n`,
    );
    const { stdout } = await run(process.execPath, [runner], { cwd: dir });
    // An explicit extension needs no hook, so this proves registration returned rather than threw.
    expect(stdout.trim()).toBe(`{"which":"ts"}`);
  });
});

describe("a config importing the adopter's own modules", () => {
  // The regression, exactly as `pithy-sh/dashboard` hit it on published 0.1.4.
  test("resolves an extensionless relative import", async () => {
    const dir = await project({
      "src/secret/registry.ts": `export const REGISTRY = { note: "theirs" };\n`,
      "pithy.config.ts": `import { REGISTRY } from "./src/secret/registry";\nexport default { registry: REGISTRY };\n`,
    });

    const result = await importWithHook(dir, "pithy.config.ts");
    expect(result.ok, result.output).toBe(true);
    expect(result.output).toContain("theirs");
  });

  // Their config has eleven of them, and adding `.ts` to one only advances the failure to the next.
  test("resolves a chain of them, not just the first", async () => {
    const dir = await project({
      "src/a.ts": `import { b } from "./b";\nexport const a = b + 1;\n`,
      "src/b.ts": `import { c } from "./nested/c";\nexport const b = c + 1;\n`,
      "src/nested/c.ts": `export const c = 1;\n`,
      "pithy.config.ts": `import { a } from "./src/a";\nexport default { a };\n`,
    });

    const result = await importWithHook(dir, "pithy.config.ts");
    expect(result.ok, result.output).toBe(true);
    expect(result.output).toBe(`{"a":3}`);
  });

  test("resolves a directory through its index", async () => {
    const dir = await project({
      "src/secret/index.ts": `export const REGISTRY = { via: "index" };\n`,
      "pithy.config.ts": `import { REGISTRY } from "./src/secret";\nexport default { registry: REGISTRY };\n`,
    });

    const result = await importWithHook(dir, "pithy.config.ts");
    expect(result.ok, result.output).toBe(true);
    expect(result.output).toContain("index");
  });

  // The hook is a fallback, so a specifier node already resolves must keep resolving to the same file.
  // Without this, a `./thing.js` beside a `./thing.ts` could start resolving to the wrong one.
  test("does not take over a relative import that already resolves", async () => {
    const dir = await project({
      "src/thing.js": `export const which = "js";\n`,
      "src/thing.ts": `export const which = "ts";\n`,
      "pithy.config.ts": `import { which } from "./src/thing.js";\nexport default { which };\n`,
    });

    const result = await importWithHook(dir, "pithy.config.ts");
    expect(result.ok, result.output).toBe(true);
    expect(result.output).toBe(`{"which":"js"}`);
  });

  // A bare specifier is a package. It belongs to node's resolver and the `exports` map — the mechanism
  // #476 put in place — and a fallback here would be guessing at somebody else's layout.
  test("leaves a bare specifier to node, and still fails when it is genuinely absent", async () => {
    const dir = await project({
      "pithy.config.ts": `import x from "not-a-real-package-xyz";\nexport default { x };\n`,
    });

    const result = await importWithHook(dir, "pithy.config.ts");
    expect(result.ok).toBe(false);
    expect(result.output).toContain("not-a-real-package-xyz");
  });

  // The floor: a relative import of something that truly is not there still fails, and says which.
  test("still fails on a relative import of a file that does not exist", async () => {
    const dir = await project({
      "pithy.config.ts": `import { gone } from "./src/gone";\nexport default { gone };\n`,
    });

    const result = await importWithHook(dir, "pithy.config.ts");
    expect(result.ok).toBe(false);
    expect(result.output).toContain("gone");
  });
});
