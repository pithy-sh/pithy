// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { afterAll, describe, expect, test } from "vitest";
import { loadWorkerConfig } from "./config";

const run = promisify(execFile);

/**
 * **Three causes, three remedies — #489.**
 *
 * A config that will not resolve an import used to get one sentence whatever went wrong: *Install the
 * project's dependencies (bun install), or correct that import.* For a missing dependency that is
 * right. For the other two `bun install` is **guaranteed** to be a no-op, which is what makes the
 * sentence unfollowable rather than merely unhelpful — and the caller it is written for is the one with
 * no human attached, which follows it exactly and has no next move.
 *
 * **The causes are produced, never hand-built.** A fabricated `Error` with a chosen `code` and message
 * tests the classifier against this file's belief about two runtimes rather than against the runtimes,
 * and the whole discriminator is a fact about what they actually emit. So each case builds a real
 * project on disk and asks `loadWorkerConfig` to load it.
 */

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A worker directory whose `pithy.config.ts` is `config`, plus any other files given. */
async function worker(config: string, files: Record<string, string> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pithy-unresolved-"));
  dirs.push(dir);
  await writeFile(join(dir, "pithy.config.ts"), config);
  for (const [path, source] of Object.entries(files)) {
    const at = join(dir, path);
    await mkdir(join(at, ".."), { recursive: true });
    await writeFile(at, source);
  }
  return dir;
}

/** The refusal `loadWorkerConfig` raises for this worker. */
async function refusal(dir: string): Promise<PithyError> {
  return (await loadWorkerConfig(dir, { fresh: true }).catch((error: unknown) => error)) as PithyError;
}

describe("an import that does not resolve", () => {
  test("a package that is not installed says to install", async () => {
    const dir = await worker(`import x from "a-package-that-does-not-exist-xyz";\nexport default { x };\n`);
    const action = (await refusal(dir)).payload.action ?? "";

    expect(action).toContain("a-package-that-does-not-exist-xyz");
    expect(action).toMatch(/install/i);
  });

  // The adopter's own file. `bun install` cannot create it, and saying so is the point.
  test("a relative import of a file that is not there says so, and says installing will not help", async () => {
    const dir = await worker(`import { gone } from "./src/gone";\nexport default { gone };\n`);
    const action = (await refusal(dir)).payload.action ?? "";

    expect(action).toContain("installing dependencies will not help");
    expect(action).toMatch(/create that file|correct the import/i);
  });

  /**
   * The rule the rest of this module keeps, and that this message broke on node.
   *
   * Node's "specifier" is an already-resolved absolute path, so the old sentence printed `/home/…` into
   * a line an adopter is meant to act on — while `safeReason` beside it refuses absolute paths and the
   * suite asserts an action never carries one.
   *
   * **Driven in a child node, because this suite runs on Bun and Bun cannot see the defect.** Bun's
   * `ResolveMessage` carries the specifier *as written*, so `readable` is a no-op there and the
   * assertion holds however the code behaves. Measured: deleting the call to `readable` left this test
   * green in-process, and red here. A check that cannot fail on the thing it names is worse than none.
   */
  test("names the file the way it was written, not as a resolved absolute path", async () => {
    const dir = await worker(`import { gone } from "./src/gone";\nexport default { gone };\n`);
    const runner = join(dir, "runner.mjs");
    await writeFile(
      runner,
      // The **built** module, not this source: the CLI's own imports are extensionless, which node
      // resolves only through the build. That is also what an adopter runs.
      `const { loadWorkerConfig } = await import(${JSON.stringify(new URL("../../dist/project/config.js", import.meta.url).href)});\n` +
        `try { await loadWorkerConfig(${JSON.stringify(dir)}, { fresh: true }); }\n` +
        `catch (error) { console.log(error.payload.action ?? ""); }\n`,
    );

    const { stdout } = await run(process.execPath, [runner], { cwd: dir });
    const action = stdout.trim();

    expect(action).toContain("./src/gone");
    expect(action).not.toContain(dir);
    expect(action).not.toMatch(/(^|\s)\/(home|Users|tmp|var)\//);
  });

  // The remedy for a real dependency is still the one that works: nothing above narrowed it away.
  test("still tells you to install when installing is the answer", async () => {
    const dir = await worker(`import x from "another-absent-package-abc";\nexport default { x };\n`);
    const action = (await refusal(dir)).payload.action ?? "";

    expect(action).not.toContain("will not help");
    expect(action).toMatch(/bun install/);
  });

  // The floor. Every case above asserts about a sentence, and a sentence that never arrived would
  // satisfy `not.toContain` for free.
  test("each of these actually refuses, with an action to read", async () => {
    for (const config of [
      `import x from "absent-package-def";\nexport default { x };\n`,
      `import { gone } from "./nope";\nexport default { gone };\n`,
    ]) {
      const error = await refusal(await worker(config));
      expect(error.payload.action ?? "").not.toBe("");
      expect(error.payload.message).toContain("pithy.config.ts");
    }
  });
});
