// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { afterAll, describe, expect, test } from "vitest";
import { classifyWorkerConfigFailure, loadWorkerConfig } from "./workerConfig";

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function workerDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pithy-worker-config-"));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content, "utf8");
  }
  return dir;
}

async function caught(promise: Promise<unknown>): Promise<PithyError> {
  const error = await promise.then(
    () => null,
    (cause: unknown) => cause,
  );
  expect(error).toBeInstanceOf(PithyError);
  return error as PithyError;
}

describe("loadWorkerConfig", () => {
  test("indexes the composed capabilities by name, app included", async () => {
    const dir = await workerDir({
      "pithy.config.ts": `
        export default {
          capabilities: [
            { name: "auth", requiredBindings: [] },
            { name: "ledger", requiredBindings: [] },
          ],
          app: { name: "api", requiredBindings: [] },
        };
      `,
    });
    const { capabilities } = await loadWorkerConfig(join(dir, "pithy.config.ts"));
    expect([...capabilities.keys()].sort()).toEqual(["api", "auth", "ledger"]);
  });

  test("loads TypeScript syntax and extensionless relative imports — what a bare import() cannot", async () => {
    const dir = await workerDir({
      "pithy.config.ts": `
        import { auth } from "./capabilities";
        interface WorkerConfig { capabilities: unknown[] }
        const config: WorkerConfig = { capabilities: [auth] };
        export default config satisfies WorkerConfig;
      `,
      "capabilities.ts": `
        export const auth = { name: "auth", requiredBindings: [] as const };
      `,
    });
    const loaded = await loadWorkerConfig(join(dir, "pithy.config.ts"));
    expect([...loaded.capabilities.keys()]).toEqual(["auth"]);
    expect(loaded.dependencies.some((file) => file.endsWith("capabilities.ts"))).toBe(true);
  });

  test("a worker with no app capability is fine", async () => {
    const dir = await workerDir({ "pithy.config.ts": "export default { capabilities: [] };" });
    const { capabilities } = await loadWorkerConfig(join(dir, "pithy.config.ts"));
    expect(capabilities.size).toBe(0);
  });

  test("a missing config names the file and the command that writes it", async () => {
    const dir = await workerDir({});
    const error = await caught(loadWorkerConfig(join(dir, "pithy.config.ts")));
    expect(error.payload.code).toBe("core/not_found");
    expect(error.payload.message).toContain("pithy.config.ts");
    expect(error.payload.action).toContain("pithy ui add");
  });

  test("a config that throws on import is reported with its cause in detail, not as a stack", async () => {
    const dir = await workerDir({ "pithy.config.ts": 'throw new Error("boom");' });
    const error = await caught(loadWorkerConfig(join(dir, "pithy.config.ts")));
    expect(error.payload.code).toBe("core/internal");
    expect(error.payload.message).toContain("Could not load");
    expect(error.payload.detail).toContain("boom");
  });

  test("a config without a capabilities array is rejected", async () => {
    const dir = await workerDir({ "pithy.config.ts": 'export default { name: "acme" };' });
    const error = await caught(loadWorkerConfig(join(dir, "pithy.config.ts")));
    expect(error.payload.action).toBe("Export default { capabilities, app }.");
  });

  test("a non-capability in the capabilities array is rejected rather than silently skipped", async () => {
    const dir = await workerDir({ "pithy.config.ts": "export default { capabilities: [undefined] };" });
    const error = await caught(loadWorkerConfig(join(dir, "pithy.config.ts")));
    expect(error.payload.message).toContain("isn't a capability");
  });
});

/**
 * The refusal for a config that will not load names its cause, or names nothing (#217).
 *
 * The CLI's own loader was fixed in #207; this one built the same `Could not load ${configFile}.` with
 * the same defect — *Fix the config, then run pithy dev again. Run bun install if a `@pithy-sh/*` import
 * did not resolve* — a sentence that hedges by naming both remedies, leads with the wrong one for the
 * commoner failure, and drops the only thing that would have settled it: the reason.
 *
 * The classifier is exported so it is tested against the shapes each runtime throws. `pithy dev` runs
 * this plugin under **Bun**, whose `ResolveMessage` and `BuildMessage` are their own classes and are not
 * `instanceof Error` — so these fixtures are plain objects, as they really are, never `new Error(...)`.
 */
describe("classifyWorkerConfigFailure", () => {
  test("Bun's ResolveMessage is not an Error: the specifier is named, the referrer is not", () => {
    const cause = {
      name: "ResolveMessage",
      message: "Cannot find package '@pithy-sh/auth' from '/home/a/apps/api/pithy.config.ts'",
      code: "ERR_MODULE_NOT_FOUND",
      specifier: "@pithy-sh/auth",
      referrer: "/home/a/apps/api/pithy.config.ts",
    };
    const { kind, action } = classifyWorkerConfigFailure(cause);
    expect(kind).toBe("unresolved-import");
    expect(action).toContain("@pithy-sh/auth");
    expect(action).toMatch(/bun install/i);
    expect(action).not.toContain("/home/a");
  });

  test("Bun's BuildMessage is not an Error: the parser's reason reaches the adopter, install does not", () => {
    const cause = {
      name: "BuildMessage",
      message: 'Expected identifier but found "{"',
      position: { file: "/home/a/apps/api/pithy.config.ts", line: 8, column: 3, lineText: "const x = {{" },
    };
    const { kind, action } = classifyWorkerConfigFailure(cause);
    expect(kind).toBe("parse-error");
    expect(action).toContain('Expected identifier but found "{"');
    expect(action).toContain("Line 8, column 3");
    expect(action).not.toMatch(/bun install/i);
    expect(action).not.toContain("/home/a");
    expect(action).not.toContain("const x = {{");
  });

  // **Found by running this loader on Bun, not by a fixture.** `import()` on Bun throws an
  // `AggregateError` whose `errors` hold the `BuildMessage`s; its own message is a count and an absolute
  // path. Classifying the wrapper reads a syntax error as "the config threw" and loses the position.
  test("Bun wraps BuildMessages in an AggregateError, and the position still gets through", () => {
    const cause = {
      name: "AggregateError",
      message: '2 errors building "/home/a/apps/api/pithy.config.ts"',
      errors: [
        {
          name: "BuildMessage",
          message: 'Expected identifier but found "{"',
          position: { file: "/home/a/apps/api/pithy.config.ts", line: 1, column: 24, lineText: "const x = {{" },
        },
        { name: "BuildMessage", message: 'Expected "}" but found end of file' },
      ],
    };
    const { kind, action } = classifyWorkerConfigFailure(cause);
    expect(kind).toBe("parse-error");
    expect(action).toContain('Expected identifier but found "{"');
    expect(action).toContain("Line 1, column 24");
    expect(action).not.toContain("/home/a");
  });

  // And the second import of the same broken config is a *third* shape: Bun caches the failure and
  // re-throws the wrapper with its `errors` gone, leaving only the count and the path (#223). Unwrapping
  // cannot help. The message still proves a build produced diagnostics, which is not a throw.
  test("the re-thrown wrapper has no diagnostics left, and is still a parse error", () => {
    const cause = { name: "AggregateError", message: '4 errors building "/home/a/apps/api/pithy.config.ts"' };
    const { kind, action } = classifyWorkerConfigFailure(cause);
    expect(kind).toBe("parse-error");
    expect(action).not.toMatch(/threw while loading/);
    expect(action).not.toMatch(/bun install/i);
    expect(action).not.toContain("/home/a");
    expect(action).not.toContain("4 errors building");
  });

  test("a config that throws on load gets its own reason, and neither other remedy", () => {
    const { kind, action } = classifyWorkerConfigFailure(new Error("AUTH_SECRET is required"));
    expect(kind).toBe("threw-on-load");
    expect(action).toContain("AUTH_SECRET is required");
    expect(action).not.toMatch(/bun install/i);
  });

  test("an unrecognised cause gets no remedy at all — a wrong action is worse than none", () => {
    const { kind, action } = classifyWorkerConfigFailure({ not: "an error" });
    expect(kind).toBe("unknown");
    expect(action).not.toMatch(/bun install/i);
    expect(action).not.toMatch(/does not parse/i);
  });

  test("a multi-line ANSI diagnostic contributes its position and nothing else", () => {
    const cause = new Error(
      "Transform failed with 1 error:\n\n\u001b[31m[PARSE_ERROR] \u001b[0mUnexpected token\n  ╭─[ /a/pithy.config.ts:1:17 ]",
    );
    const { kind, action } = classifyWorkerConfigFailure(cause);
    expect(kind).toBe("parse-error");
    expect(action).toContain("Line 1, column 17");
    expect(action).not.toContain("\n");
    expect(action).not.toContain("/a/pithy.config.ts");
  });

  test("the real loader carries the classified action, and the raw cause only in detail", async () => {
    const dir = await workerDir({ "pithy.config.ts": 'import "@pithy-sh/nope-does-not-exist";\nexport default {};\n' });

    await expect(loadWorkerConfig(join(dir, "pithy.config.ts"))).rejects.toSatisfy((error: PithyError) => {
      expect(error).toBeInstanceOf(PithyError);
      expect(error.payload.action).not.toBe(
        "Fix the config, then run pithy dev again. Run bun install if a @pithy-sh/* import did not resolve.",
      );
      expect(error.payload.detail).toBeTruthy();
      return true;
    });
  });
});
