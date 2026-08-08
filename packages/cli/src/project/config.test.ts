// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { PithyError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  allCapabilities,
  classifyConfigLoadFailure,
  loadProject,
  loadProjectCloudflare,
  loadWorkerConfig,
  projectCloudflareAccount,
  requireProjectName,
  resolveProjectName,
} from "./config";

// In-package temp dirs (not the OS tmpdir): vitest can only transform the
// TS config files it imports when they live under the project root.
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(import.meta.dirname, "..", "..", ".smoke-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Write a worker at `apps/<name>/pithy.config.ts` and return its directory. */
async function writeWorkerConfig(name: string, source: string): Promise<string> {
  const workerDir = join(dir, "apps", name);
  await mkdir(workerDir, { recursive: true });
  await writeFile(join(workerDir, "pithy.config.ts"), source);
  return workerDir;
}

describe("loadProject", () => {
  test("a directory without pithy.config.ts points at pithy init", async () => {
    const error = await loadProject(dir).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(PithyError);
    expect((error as PithyError).payload.action).toContain("pithy init");
  });

  test("loads the project's identity and policy", async () => {
    await writeFile(
      join(dir, "pithy.config.ts"),
      'export default { name: "acme", seed: { includeExamples: true } };\n',
    );
    const config = await loadProject(dir);
    expect(config.name).toBe("acme");
    expect(config.seed?.includeExamples).toBe(true);
  });

  test("a config that omits seed defaults to no example seeds", async () => {
    await writeFile(join(dir, "pithy.config.ts"), 'export default { name: "acme" };\n');
    const config = await loadProject(dir);
    expect(config.seed?.includeExamples ?? false).toBe(false);
  });

  test("a config that can't be imported reports an actionable error, not a module-resolution stack", async () => {
    await writeFile(join(dir, "pithy.config.ts"), 'import "@pithy-sh/does-not-exist";\nexport default {};\n');
    const error = await loadProject(dir).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(PithyError);
    expect((error as PithyError).payload.action).toContain("dependencies");
  });
});

/**
 * #207: a config that will not load must say **why**. Before this, a stray brace and an uninstalled
 * dependency produced byte-identical output — `Could not load <path>.` plus "Install the project's
 * dependencies (e.g. bun install), then check the config for errors." — because the real cause went
 * into `detail`, which the CLI renderer never prints. `bun install` is confidently wrong for a syntax
 * error, and an adopter follows it.
 *
 * #172 was the same defect: a config that would not load named the wrong cause, and the diagnosis was
 * wrong twice before someone traced the import edge.
 */
describe("a config that will not load names its own cause (#207)", () => {
  /** The payload from loading a root config with this source. */
  async function refusal(source: string): Promise<{ message: string; action?: string; detail?: string }> {
    // A fresh directory per case: `importConfig` imports live, and a module-cache hit would answer with
    // another case's config.
    const projectDir = join(dir, `p${Math.random().toString(36).slice(2)}`);
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, "pithy.config.ts"), source);
    const error = await loadProject(projectDir).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(PithyError);
    const payload = (error as PithyError).payload;
    // The one thing `message` is allowed to say, exactly. Asserted per case rather than once, because
    // this is the security boundary and each cause is a different chance to breach it.
    expect(payload.message).toBe(`Could not load ${join(projectDir, "pithy.config.ts")}.`);
    return payload;
  }

  const UNRESOLVED = 'import "@pithy-sh/does-not-exist";\nexport default { name: "acme" };\n';
  const SYNTAX = "export default {{ name: 'acme' };\n";
  const THROWS = 'throw new Error("the config threw");\nexport default {};\n';

  test("an unresolved import names the specifier and says to install", async () => {
    const payload = await refusal(UNRESOLVED);
    expect(payload.action).toContain("@pithy-sh/does-not-exist");
    expect(payload.action).toMatch(/install/i);
  });

  test("a syntax error says the file does not parse, and never says to install", async () => {
    const payload = await refusal(SYNTAX);
    expect(payload.action).toMatch(/does not parse/i);
    // The whole point: `bun install` cannot fix a stray brace, and an action that says so is followed.
    expect(payload.action).not.toMatch(/\binstall the project's dependencies\b/i);
    expect(payload.action).not.toMatch(/\bbun install\b/i);
  });

  test("a config that throws while loading says so, and never says to install", async () => {
    const payload = await refusal(THROWS);
    expect(payload.action).toContain("the config threw");
    expect(payload.action).not.toMatch(/\bbun install\b/i);
  });

  test("the three causes no longer produce identical output — the defect in one assertion", async () => {
    const actions = [await refusal(UNRESOLVED), await refusal(SYNTAX), await refusal(THROWS)].map(
      (payload) => payload.action,
    );
    expect(new Set(actions).size).toBe(3);
  });

  test("no throw-site context reaches message or action — not a stack, not a path, not an escape code", async () => {
    // Under vitest the transform's own parse diagnostic is a multi-line, ANSI-coloured box that quotes
    // the file's path and source; under Bun it is a clean one-liner. Neither may be pasted through.
    for (const source of [UNRESOLVED, SYNTAX, THROWS]) {
      const payload = await refusal(source);
      const action = payload.action ?? "";
      expect(action).not.toContain("\n");
      // biome-ignore lint/suspicious/noControlCharactersInRegex: an escape code is exactly what must not leak.
      expect(action).not.toMatch(/\u001b\[/);
      expect(action).not.toMatch(/\bat .*:\d+:\d+/); // a stack frame
      expect(action).not.toContain(dir); // any absolute path from this run
      expect(action.length).toBeLessThan(300);
      // The raw cause is still captured — it just stays where the renderer cannot print it.
      expect(payload.detail).toBeTruthy();
    }
  });
});

/**
 * The classifier itself, against the error shapes each runtime actually throws. The CLI's `bin` runs on
 * **Bun**, whose `ResolveMessage`/`BuildMessage` these tests reconstruct — vitest runs on Node, so the
 * runtime that adopters use is otherwise the one runtime the suite could not reach.
 */
describe("classifyConfigLoadFailure", () => {
  // Not `new Error(...)`. Bun's ResolveMessage and BuildMessage are their OWN classes and are NOT
  // `instanceof Error` — checked against Bun 1.3. Fixtures built on `Error` passed while the shipping
  // runtime silently lost the parser's own sentence, so they are plain objects here, as they really are.
  test("Bun's ResolveMessage is not an Error: the specifier is still named, the referrer path is not", () => {
    const cause = {
      name: "ResolveMessage",
      message: "Cannot find module '@pithy-sh/core/src/x' from '/home/a/pithy.config.ts'",
      code: "ERR_MODULE_NOT_FOUND",
      specifier: "@pithy-sh/core/src/x",
      referrer: "/home/a/pithy.config.ts",
    };
    const { kind, action } = classifyConfigLoadFailure(cause);
    expect(kind).toBe("unresolved-import");
    expect(action).toContain("@pithy-sh/core/src/x");
    expect(action).not.toContain("/home/a/pithy.config.ts");
    expect(action).toMatch(/install/i);
  });

  test("Node's ERR_MODULE_NOT_FOUND: the specifier is parsed out, the 'imported from' path is dropped", () => {
    const cause = Object.assign(
      new Error("Cannot find package '@pithy-sh/does-not-exist' imported from /home/a/pithy.config.ts"),
      { code: "ERR_MODULE_NOT_FOUND" },
    );
    const { kind, action } = classifyConfigLoadFailure(cause);
    expect(kind).toBe("unresolved-import");
    expect(action).toContain("@pithy-sh/does-not-exist");
    expect(action).not.toContain("/home/a");
  });

  test("Bun's BuildMessage is not an Error: the parser's own reason and position still reach the adopter", () => {
    const cause = {
      name: "BuildMessage",
      message: 'Expected identifier but found "{"',
      position: { file: "/home/a/pithy.config.ts", line: 31, column: 17, lineText: "const config = {{" },
    };
    const { kind, action } = classifyConfigLoadFailure(cause);
    expect(kind).toBe("parse-error");
    expect(action).toContain('Expected identifier but found "{"');
    expect(action).toContain("Line 31, column 17");
    expect(action).not.toContain("/home/a");
    expect(action).not.toContain("const config = {{"); // the source line is throw-site context
    expect(action).not.toMatch(/\bbun install\b/i);
  });

  test("a multi-line diagnostic contributes its position and nothing else", () => {
    const cause = new Error(
      "Transform failed with 1 error:\n\n[31m[PARSE_ERROR] [0mUnexpected token\n  ╭─[ .smoke-x/pithy.config.ts:1:17 ]",
    );
    const { kind, action } = classifyConfigLoadFailure(cause);
    expect(kind).toBe("parse-error");
    expect(action).toContain("Line 1, column 17");
    expect(action).not.toContain("\n");
    expect(action).not.toContain("PARSE_ERROR");
    expect(action).not.toContain("pithy.config.ts:1:17");
  });

  test("an unrecognised cause gets no remedy at all — a wrong action is worse than none", () => {
    const { kind, action } = classifyConfigLoadFailure({ not: "an error" });
    expect(kind).toBe("unknown");
    expect(action).not.toMatch(/\bbun install\b/i);
    expect(action).not.toMatch(/does not parse/i);
  });
});

describe("loadWorkerConfig", () => {
  test("loads a worker's capabilities and composes its app last", async () => {
    const workerDir = await writeWorkerConfig(
      "api",
      'export default { capabilities: [{ name: "auth", requiredBindings: [] }], app: { name: "app", requiredBindings: [] } };\n',
    );
    const config = await loadWorkerConfig(workerDir);
    expect(allCapabilities(config).map((cap) => cap.name)).toEqual(["auth", "app"]);
  });

  test("a worker without a config points at pithy worker add", async () => {
    const workerDir = join(dir, "apps", "ghost");
    await mkdir(workerDir, { recursive: true });
    const error = await loadWorkerConfig(workerDir).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(PithyError);
    expect((error as PithyError).payload.action).toContain("pithy worker add");
  });

  test("a worker config that doesn't default-export { capabilities } fails with the expected shape", async () => {
    const workerDir = await writeWorkerConfig("bad", "export default { nope: true };\n");
    await expect(loadWorkerConfig(workerDir)).rejects.toThrow(/default-export/);
  });
});

describe("allCapabilities", () => {
  test("no app means libraries only", () => {
    const auth = defineCapability({ name: "auth", requiredBindings: [] });
    expect(allCapabilities({ capabilities: [auth] })).toEqual([auth]);
  });
});

describe("resolveProjectName", () => {
  test("prefers the configured name, kebab-normalized", async () => {
    expect(await resolveProjectName({ name: "Acme Corp" }, dir)).toBe("acme-corp");
  });

  test("falls back to the project directory's basename when no name and no workers are discoverable", async () => {
    const expected = basename(dir)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    expect(await resolveProjectName({}, dir)).toBe(expected);
  });
});

describe("requireProjectName", () => {
  test("returns the configured name, kebab-normalized", () => {
    expect(requireProjectName({ name: "Acme Corp" })).toBe("acme-corp");
  });

  test("throws an actionable PithyError when `name` is absent — never guesses", () => {
    const error = ((): unknown => {
      try {
        requireProjectName({});
        return undefined;
      } catch (thrown) {
        return thrown;
      }
    })();
    expect(error).toBeInstanceOf(PithyError);
    expect((error as PithyError).payload.message).toContain("name");
    expect((error as PithyError).payload.action).toContain("name");
  });

  test("refuses a name the deploy-time namer would reject, so no command half-provisions under it", () => {
    // `1password-clone` used to sail through here: D1, KV, and R2 were created for real, `pithy migrate`
    // ran, and only then did the first host-worker deploy throw `core/internal`. It fails on the first
    // command instead, as a 400 the adopter can act on.
    const error = ((): unknown => {
      try {
        requireProjectName({ name: "1password-clone" });
        return undefined;
      } catch (thrown) {
        return thrown;
      }
    })();
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as PithyError).payload.status).toBe(400);
    expect((error as PithyError).payload.action).toContain("starting with a letter");
  });
});

/**
 * The `cloudflare` block: which account this project belongs to (#206). It is the one setting here that
 * reaches outside the checkout — `accountName` becomes a file name in the config directory — so it is
 * validated on load rather than trusted off the import, exactly as `domains` is.
 */
describe("the project's cloudflare block", () => {
  async function project(source: string): Promise<string> {
    // A fresh module specifier per test: `loadProject` imports the config live, and a Node module cache
    // hit would answer with the previous test's block.
    const projectDir = join(dir, `p${Math.random().toString(36).slice(2)}`);
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, "pithy.config.ts"), source);
    return projectDir;
  }

  test("reads accountName and accountId, and publishes them for every later credential resolution", async () => {
    const dirA = await project(
      'export default { name: "acme", cloudflare: { accountName: "leed", accountId: "a1" } };\n',
    );
    const config = await loadProject(dirA);
    expect(loadProjectCloudflare(config)).toEqual({ accountName: "leed", accountId: "a1" });
    expect(await projectCloudflareAccount(dirA)).toEqual({ accountName: "leed", accountId: "a1" });
  });

  test("a project with no cloudflare block answers null, so cloudflare.json resolves as before", async () => {
    const dirA = await project('export default { name: "acme" };\n');
    expect(loadProjectCloudflare(await loadProject(dirA))).toBeUndefined();
    expect(await projectCloudflareAccount(dirA)).toBeNull();
  });

  test("an accountName that is not a bare token is refused on load, naming the config and the value", async () => {
    const dirA = await project('export default { name: "acme", cloudflare: { accountName: "../../etc/passwd" } };\n');
    const error = await loadProject(dirA).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(PithyError);
    const payload = (error as PithyError).payload;
    expect(`${payload.message} ${payload.detail ?? ""}`).toContain("cloudflare.accountName");
    expect(`${payload.message} ${payload.detail ?? ""}`).toContain("../../etc/passwd");
  });

  test.each([["a/b"], [""], ["Leed"], [".."]])("refuses the accountName %j on load", async (name) => {
    const dirA = await project(
      `export default { name: "acme", cloudflare: { accountName: ${JSON.stringify(name)} } };\n`,
    );
    await expect(loadProject(dirA)).rejects.toBeInstanceOf(PithyError);
  });

  test("a misspelled key is refused rather than ignored — a silently dropped pin is the fault, not a typo", async () => {
    const dirA = await project('export default { name: "acme", cloudflare: { accountid: "a1" } };\n');
    await expect(loadProject(dirA)).rejects.toBeInstanceOf(PithyError);
  });

  test("an accountId alone is legitimate: a single-account machine pinning the account it deploys to", async () => {
    const dirA = await project('export default { name: "acme", cloudflare: { accountId: "a1" } };\n');
    expect(loadProjectCloudflare(await loadProject(dirA))).toEqual({ accountId: "a1" });
    expect(await projectCloudflareAccount(dirA)).toEqual({ accountId: "a1" });
  });
});
