// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { PithyError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { sourceFiles, sourcePaths } from "../ci/sourceFiles";
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
      "Transform failed with 1 error:\n\n\u001b[31m[PARSE_ERROR] \u001b[0mUnexpected token\n  ╭─[ .smoke-x/pithy.config.ts:1:17 ]",
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

/**
 * **Two syntax errors used to classify worse than one (#223).**
 *
 * #207 fixed the rarer shape. Bun hands `import()` one build diagnostic bare and **two or more inside an
 * `AggregateError`** — and a stray brace cascades, so two-or-more is what a broken config actually looks
 * like. The wrapper's `Object.keys` is empty and its message is `N errors building "<absolute path>"`,
 * which matches no classifier test, so a parse error fell through to "the config threw while loading" and
 * the adopter was told to run the file rather than where the file is broken.
 *
 * The fixture below is **not** a synthetic one-liner. It is the shape Bun 1.3.14 really threw for a
 * `pithy.config.ts` missing one closing brace — four diagnostics, positions and all — captured verbatim,
 * because #207 survived its own Bun testing by repro'ing with a single deliberate typo.
 */
describe("Bun wraps two or more build diagnostics, and a cascade is the common case (#223)", () => {
  /** The real path Bun quoted, kept absolute: it is exactly what must not reach `action`. */
  const FILE = "/home/a/scratch/two/pithy.config.ts";

  /**
   * Verbatim from Bun 1.3.14 importing a config whose `const seed = {` is never closed. Plain objects,
   * never `new Error(...)`: `BuildMessage` is its own class and is **not** `instanceof Error`, which is
   * the trap #207 shipped. Four diagnostics, because one missing brace produces four.
   */
  const CASCADE = {
    name: "AggregateError",
    message: `4 errors building "${FILE}"`,
    errors: [
      {
        name: "BuildMessage",
        message: 'Expected identifier but found ";"',
        position: { lineText: ";", file: FILE, namespace: "file", line: 4, column: 1, length: 1, offset: 94 },
      },
      {
        name: "BuildMessage",
        message: 'Expected "}" but found "default"',
        position: {
          lineText: "export default {",
          file: FILE,
          namespace: "file",
          line: 6,
          column: 8,
          length: 7,
          offset: 104,
        },
      },
      {
        name: "BuildMessage",
        message: 'Expected ";" but found "{"',
        position: {
          lineText: "export default {",
          file: FILE,
          namespace: "file",
          line: 6,
          column: 16,
          length: 1,
          offset: 112,
        },
      },
      {
        name: "BuildMessage",
        message: "Unexpected }",
        position: { lineText: "};", file: FILE, namespace: "file", line: 9, column: 1, length: 1, offset: 138 },
      },
    ],
  };

  test("a cascading syntax error is a parse error, not a config that threw", () => {
    const { kind, action } = classifyConfigLoadFailure(CASCADE);
    expect(kind).toBe("parse-error");
    // The bug, in one line: this said "The config threw while loading. Run the file directly…".
    expect(action).not.toMatch(/threw while loading/);
    expect(action).toMatch(/does not parse/i);
  });

  test("the first diagnostic's reason and position reach the adopter — the cascade behind it does not", () => {
    const { action } = classifyConfigLoadFailure(CASCADE);
    expect(action).toContain('Expected identifier but found ";"');
    expect(action).toContain("Line 4, column 1");
    // The rest are the cascade, not the fault. Naming four positions would bury the one that matters.
    expect(action).not.toContain('Expected "}" but found "default"');
    expect(action).not.toContain("Line 6");
  });

  test("the wrapper leaks nothing #207 kept out — no path, no source line, no count, no newline", () => {
    const { action } = classifyConfigLoadFailure(CASCADE);
    expect(action).not.toContain(FILE);
    expect(action).not.toContain("/home/a");
    expect(action).not.toContain("export default {"); // `lineText` is throw-site context
    expect(action).not.toContain("4 errors building"); // the wrapper's own message
    expect(action).not.toContain("\n");
    // biome-ignore lint/suspicious/noControlCharactersInRegex: an escape code is exactly what must not leak.
    expect(action).not.toMatch(/\u001b\[/);
    expect(action).not.toMatch(/\bat .*:\d+:\d+/);
    expect(action.length).toBeLessThan(300);
  });

  test("one diagnostic and four produce the same sentence shape — the count is not the adopter's problem", () => {
    const bare = CASCADE.errors[0];
    expect(classifyConfigLoadFailure(bare).kind).toBe(classifyConfigLoadFailure(CASCADE).kind);
    expect(classifyConfigLoadFailure(bare).action).toBe(classifyConfigLoadFailure(CASCADE).action);
  });

  test("a wrapped ResolveMessage is still a resolution failure, not a parse error", () => {
    const { kind, action } = classifyConfigLoadFailure({
      name: "AggregateError",
      message: `2 errors building "${FILE}"`,
      errors: [
        { name: "ResolveMessage", message: "Cannot find package '@pithy-sh/auth'", specifier: "@pithy-sh/auth" },
        { name: "ResolveMessage", message: "Cannot find package 'zod'", specifier: "zod" },
      ],
    });
    expect(kind).toBe("unresolved-import");
    expect(action).toContain("@pithy-sh/auth");
  });

  test("an AggregateError with nothing in it is still classified on its own terms, never dropped", () => {
    const { kind } = classifyConfigLoadFailure({ name: "AggregateError", message: "boom", errors: [] });
    expect(kind).toBe("threw-on-load");
  });

  /**
   * **The second import of the same broken config is not the same error.**
   *
   * Found by running `pithy doctor` on the cascading fixture with the unwrap already in place, and
   * watching it still say "the config threw". Bun caches a failed module, and the `AggregateError` it
   * re-throws on every later `import()` of that specifier has **no `errors` at all** — just the count and
   * the path. Unwrapping cannot help; there is nothing left to unwrap.
   *
   * This is not a corner. `pithy doctor` loads the root config twice by design — `projectCloudflareAccount`
   * resolves the account before the report is built (#206) — so the *degraded* shape is what the adopter
   * actually reads. Nothing else Bun throws behaves this way: a `ResolveMessage`, a bare `BuildMessage`
   * and a config's own `Error` are all identical on every import.
   *
   * The wrapper's own message is enough to know it was a build, and a build that produced diagnostics did
   * not resolve or throw — it failed to parse. So it is named for what it is, with no position, rather
   * than mis-blamed on the config's runtime.
   */
  const STRIPPED = { name: "AggregateError", message: `4 errors building "${FILE}"` };

  test("Bun's re-thrown wrapper has no diagnostics left, and is still a parse error", () => {
    const { kind, action } = classifyConfigLoadFailure(STRIPPED);
    expect(kind).toBe("parse-error");
    expect(action).not.toMatch(/threw while loading/);
    expect(action).toMatch(/installing dependencies will not help/);
  });

  test("with the diagnostics gone it says less — no invented reason, no invented position", () => {
    const { action } = classifyConfigLoadFailure(STRIPPED);
    expect(action).toBe("The config does not parse. Fix the file — installing dependencies will not help.");
    expect(action).not.toMatch(/Line \d+/);
  });

  test("the stripped wrapper leaks neither the path it quotes nor the count", () => {
    const { action } = classifyConfigLoadFailure(STRIPPED);
    expect(action).not.toContain(FILE);
    expect(action).not.toContain("/home/a");
    expect(action).not.toContain("4 errors building");
    expect(action).not.toContain("\n");
  });

  /**
   * The wrapper's message is throw-site context in full — a count we do not report and a path that must
   * not travel — so it is suppressed by *provenance*, not left to `safeReason`'s content tests. Those
   * tests exist for a diagnostic that might be safe. This one never is, and a path Bun quotes without a
   * leading slash would sail through the absolute-path check and take a fabricated position with it.
   */
  test("nothing of the wrapper's own message is quotable, whatever shape the path it quotes has", () => {
    const { kind, action } = classifyConfigLoadFailure({ message: '2 errors building "app/config:12:5.ts"' });
    expect(kind).toBe("parse-error");
    expect(action).toBe("The config does not parse. Fix the file — installing dependencies will not help.");
    expect(action).not.toContain("app/config");
    expect(action).not.toContain("Line 12"); // never invented out of a path that happens to read like one
  });

  test("a plural-blind count is matched too, and prose that merely mentions building is not", () => {
    expect(classifyConfigLoadFailure({ message: '1 error building "/a/x.ts"' }).kind).toBe("parse-error");
    // Not a wrapper: a config that threw a sentence with the word "building" in it stays its own failure.
    expect(classifyConfigLoadFailure({ message: "Stripe is still building the account" }).kind).toBe("threw-on-load");
  });
});

/**
 * **The wrapper shape, asserted against Bun itself.**
 *
 * Everything above is a fixture, and a fixture is a claim about a runtime that the fixture cannot check.
 * That is precisely how #223 happened: #207's suite was green while the shipping runtime disagreed with
 * it. So this spawns the runtime that ships — `bin` runs on Bun — imports a genuinely broken config, and
 * asserts what actually comes back.
 *
 * It is written to fail **loudly** in both directions. If a future Bun stops wrapping, the cascade case
 * fails here rather than silently reverting `classifyConfigLoadFailure` to today's bug; if Bun starts
 * wrapping the single-diagnostic case too, that fails here as well. Either way the fact in core's
 * `rootCause` is revisited by whoever changes Bun, not discovered by an adopter with a stray brace.
 *
 * vitest runs these on Node, so `bun` is spawned. Every job in CI installs it (`oven-sh/setup-bun`), and
 * the repo mandates it for everything in dev, so a missing `bun` is a broken environment and this says so
 * rather than skipping.
 */
describe("Bun's real wrapper shape, from Bun (#223)", () => {
  /** One missing `}`. Nothing else is wrong with this file — and it produces four diagnostics. */
  const CASCADING = [
    "const seed = {",
    "  includeExamples: false,",
    '  productionEnvironments: ["production", "prod-eu"],',
    ";",
    "",
    "export default {",
    '  name: "acme",',
    "  seed,",
    "};",
    "",
  ].join("\n");

  /** One diagnostic, and only one — the shape #207 repro'd with. */
  const SINGLE = 'export default {{ name: "acme" };\n';

  /** One thrown value, read through the same `prop`/`rootCause` the classifier uses. */
  interface Thrown {
    name: unknown;
    message: unknown;
    ownKeys: string[];
    isError: boolean;
    /** `null` when the value carries no `errors` array at all — which is a fact, not an absence. */
    errorCount: number | null;
  }

  /** What Bun handed two successive `import()`s of the same broken file, plus the first one's diagnostic. */
  interface BunShape {
    first: Thrown;
    second: Thrown;
    root: { name: unknown; message: unknown; isError: boolean; line: unknown; column: unknown };
  }

  /**
   * Import `source` as a `pithy.config.ts` under a real Bun process — **twice**, because the second
   * import is a different shape and is the one `pithy doctor` renders.
   */
  async function shapeFromBun(source: string): Promise<BunShape> {
    const caseDir = join(dir, `bun-${Math.random().toString(36).slice(2)}`);
    await mkdir(caseDir, { recursive: true });
    const config = join(caseDir, "pithy.config.ts");
    await writeFile(config, source);

    const cause = join(import.meta.dirname, "..", "..", "..", "core", "src", "error", "cause.ts");
    const probe = join(caseDir, "probe.ts");
    await writeFile(
      probe,
      [
        `import { prop, rootCause } from ${JSON.stringify(cause)};`,
        "const caught: unknown[] = [];",
        "for (let i = 0; i < 2; i += 1) {",
        `  try { await import(${JSON.stringify(config)}); } catch (thrown) { caught.push(thrown); }`,
        "}",
        "if (caught.length !== 2) process.exit(9);",
        "const seen = (value: unknown) => {",
        "  const errors = prop(value, 'errors');",
        "  return {",
        "    name: prop(value, 'name'), message: prop(value, 'message'),",
        "    ownKeys: Object.keys(value as object), isError: value instanceof Error,",
        "    errorCount: Array.isArray(errors) ? errors.length : null,",
        "  };",
        "};",
        "const root = rootCause(caught[0]);",
        "console.log(JSON.stringify({",
        "  first: seen(caught[0]), second: seen(caught[1]),",
        "  root: {",
        "    name: prop(root, 'name'), message: prop(root, 'message'), isError: root instanceof Error,",
        "    line: prop(prop(root, 'position'), 'line'), column: prop(prop(root, 'position'), 'column'),",
        "  },",
        "}));",
      ].join("\n"),
    );

    // `PITHY_OFFLINE` is belt-and-braces: this child only imports a broken file, but no test in this repo
    // gets to reach a real account by accident.
    const { stdout } = await promisify(execFile)("bun", ["run", probe], {
      env: { ...process.env, PITHY_OFFLINE: "1", NO_COLOR: "1" },
      timeout: 30_000,
    });
    return JSON.parse(stdout) as BunShape;
  }

  test("two or more diagnostics arrive inside an AggregateError with no own keys and a count for a message", async () => {
    const { first } = await shapeFromBun(CASCADING);
    // If any of these four stop holding, Bun changed and `rootCause` needs re-reading. That is the point.
    expect(first.name).toBe("AggregateError");
    expect(first.ownKeys).toEqual([]);
    expect(first.message).toMatch(/^\d+ errors building "/);
    expect(first.errorCount).toBeGreaterThanOrEqual(2);
  }, 30_000);

  test("one missing brace really does cascade — the realistic shape is the wrapped one", async () => {
    const { first } = await shapeFromBun(CASCADING);
    expect(first.errorCount).toBeGreaterThan(1);
  }, 30_000);

  test("rootCause reaches a BuildMessage that is not an Error, and its position survives", async () => {
    const { root } = await shapeFromBun(CASCADING);
    expect(root.name).toBe("BuildMessage");
    // The trap #207 shipped: an `instanceof Error` gate here drops the parser's sentence on Bun alone.
    expect(root.isError).toBe(false);
    expect(root.message).toBe('Expected identifier but found ";"');
    expect(root.line).toBe(4);
    expect(root.column).toBe(1);
  }, 30_000);

  test("a single diagnostic still arrives bare, so the bare path is not dead code", async () => {
    const { first, second } = await shapeFromBun(SINGLE);
    expect(first.name).toBe("BuildMessage");
    expect(first.errorCount).toBeNull();
    expect(first.isError).toBe(false);
    // And it does not degrade either — only the wrapper does.
    expect(second.message).toBe(first.message);
  }, 30_000);

  test("a second import of the same broken file loses the diagnostics — the doctor path's real shape", async () => {
    const { first, second } = await shapeFromBun(CASCADING);
    expect(first.errorCount).toBeGreaterThanOrEqual(2);
    // If Bun ever keeps them, this fails and `isParseError`'s wrapper-message branch can be reconsidered.
    expect(second.errorCount).toBeNull();
    expect(second.name).toBe("AggregateError");
    expect(second.message).toMatch(/^\d+ errors building "/);
    // And the refusal must survive it: the count and the path are all that is left, and they are enough.
    expect(classifyConfigLoadFailure({ name: second.name, message: second.message }).kind).toBe("parse-error");
  }, 30_000);

  test("nothing else Bun throws degrades on a second import", async () => {
    const unresolved = await shapeFromBun('import "@pithy-sh/nope-not-a-real-package";\nexport default {};\n');
    expect(unresolved.second.name).toBe("ResolveMessage");
    expect(unresolved.second.message).toBe(unresolved.first.message);
    const threw = await shapeFromBun('throw new Error("the config threw");\nexport default {};\n');
    expect(threw.second.message).toBe("the config threw");
  }, 60_000);

  test("both shapes classify identically, and the cascade names its position", async () => {
    const cascade = await shapeFromBun(CASCADING);
    const single = await shapeFromBun(SINGLE);
    // Reconstructed from what Bun really sent, not from a hand-written fixture.
    const rebuilt = {
      name: cascade.first.name,
      message: cascade.first.message,
      errors: [
        {
          name: cascade.root.name,
          message: cascade.root.message,
          position: { line: cascade.root.line, column: cascade.root.column },
        },
      ],
    };
    expect(classifyConfigLoadFailure(rebuilt).kind).toBe("parse-error");
    expect(classifyConfigLoadFailure(rebuilt).action).toContain("Line 4, column 1");
    expect(classifyConfigLoadFailure({ name: single.first.name, message: single.first.message }).kind).toBe(
      "parse-error",
    );
  }, 60_000);
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

/**
 * **The gate on the filter: no module outside `@pithy-sh/core` decides whether a cause's message is safe
 * to show (#228).**
 *
 * `safeReason` is the control that stops a parser diagnostic — a multi-line ANSI box quoting an absolute
 * path and the adopter's own source line — from landing in a `PithyError`'s `action`, which the CLI
 * renderer prints and the HTTP codec does not strip. It existed three times: here, in
 * `capabilities/loadFailure.ts`, and in `@pithy-sh/vite`'s `workerConfig.ts`, near-verbatim.
 *
 * **A security control in triplicate is one fix away from being a security control in duplicate**, and
 * that is not a hypothetical. #223 found that testing *content* let Bun's build-failure wrapper through —
 * `2 errors building "app/config:12:5.ts"` has no leading slash, so it passed the absolute-path check and
 * dragged a fabricated `Line 12, column 5` out of the file name with it — and closing it meant editing
 * three files, correctly, by someone who knew all three were there. The fourth copy is the one nobody
 * tells.
 *
 * So the copies are gone and this is what keeps them gone. It lives in the CLI because the CLI is where
 * the repository-wide tripwires live and where the walk they share (`ci/sourceFiles.ts`) is, and beside
 * the classifier that held the first copy.
 *
 * **What it asks is the decidable question**, in `atomic.test.ts`'s sense: not "does this module mean to
 * filter a message", which is intent and is exactly what an evader controls, but **does this module
 * declare a message-safety filter of its own** — a declaration named for the safety of a reason or a
 * message, or its own recogniser for an absolute path, which is the one constant no copy of this filter
 * managed to do without. Both are what the three copies were, and both are what a fourth would have to
 * write.
 *
 * It deliberately does **not** flag de-colouring. `dev/logging.ts` strips ANSI to render a dev-server log
 * and is right to; stripping escapes is formatting, not a decision about what an adopter may be told.
 */
describe("the gate on the filter (#228)", () => {
  /** `packages/cli/src/project` → the repository. Asserted below, so a moved file fails loudly. */
  const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..", "..");

  /** The one module allowed to decide it, and why. Adding a line here is the review. */
  const ALLOWED = new Map<string, string>([
    [
      "packages/core/src/error/cause.ts",
      "The one that is allowed to. `safeReason` and `failurePosition` live here, with the provenance suppression #223 needed, and every surface imports them — including @pithy-sh/vite, which depends on core and on nothing else in the kit.",
    ],
  ]);

  /**
   * Why `source` decides message safety, or null.
   *
   * Two signals, each of which every copy of this filter had. A declaration named for the safety of a
   * reason or a message is the filter itself; a recogniser for an absolute path is the test it cannot be
   * written without — a message-safety filter that does not know what a path looks like does not stop one
   * from travelling. Either alone is enough to want a human to look.
   */
  function decidesMessageSafety(source: string): string | null {
    const found: string[] = [];
    const declaration = /\b(?:function|const|let|var)\s+(\w*[sS]afe(?:Reason|Message|Text|Detail)\w*)\s*[(=:]/g;
    for (const [, name] of source.matchAll(declaration)) if (name) found.push(`declares ${name}`);
    // The absolute-path character class, in the spelling all three copies used, and the name they gave it.
    if (source.includes("[A-Za-z]:[")) found.push("recognises an absolute path");
    if (/\bABSOLUTE_PATH\b/.test(source)) found.push("declares ABSOLUTE_PATH");
    return found.length === 0 ? null : [...new Set(found)].join(", ");
  }

  test("scans the repository, not one package of it", () => {
    // A silent walk that finds nothing would pass every assertion below, so the walk is asserted first.
    expect(sourcePaths(REPO_ROOT).length).toBeGreaterThan(500);
    expect(sourcePaths(REPO_ROOT).some((path) => path.endsWith(join("core", "src", "error", "cause.ts")))).toBe(true);
    expect(sourcePaths(REPO_ROOT).some((path) => path.includes(`${sep}vite${sep}`))).toBe(true);
  });

  test("only core decides whether a cause's message is safe to show", () => {
    const deciders = new Map<string, string>();
    for (const source of sourceFiles(REPO_ROOT)) {
      const how = decidesMessageSafety(source.text);
      if (how !== null) deciders.set(relative(REPO_ROOT, source.path).split(sep).join("/"), how);
    }

    expect(
      [...deciders.keys()].sort(),
      "import safeReason from @pithy-sh/core/src/error/cause — do not write a second one",
    ).toEqual([...ALLOWED.keys()].sort());
  });

  test("the rule is not vacuous: it reads core's own filter as a decision", () => {
    // If `safeReason` were renamed or rewritten past this rule, the assertion above would pass by finding
    // nothing anywhere — a gate that has quietly stopped guarding. This is what makes that state red.
    const cause = sourceFiles(REPO_ROOT).find((file) => file.path.endsWith(join("core", "src", "error", "cause.ts")));
    expect(cause).toBeDefined();
    expect(decidesMessageSafety(cause?.text ?? "")).toContain("safeReason");
  });

  test("the gate bites: a fourth copy of the filter is named, wherever it is planted", () => {
    // Verbatim from `project/config.ts` before this issue — the copy that is now core's, planted back.
    const planted = [
      "const ABSOLUTE_PATH = /(^|[\\s'\"(])(\\/|~\\/|[A-Za-z]:[\\\\/])/;",
      "function safeReason(cause: unknown): string | undefined {",
      "  const text = rawMessage(cause).trim();",
      "  if (text.includes(String.fromCharCode(10))) return undefined;",
      "  if (ABSOLUTE_PATH.test(text)) return undefined;",
      "  return text;",
      "}",
    ].join("\n");

    expect(decidesMessageSafety(planted)).toContain("declares safeReason");
    expect(decidesMessageSafety(planted)).toContain("recognises an absolute path");
    // And a module that merely uses core's filter is not a module that decides anything.
    expect(
      decidesMessageSafety(
        'import { safeReason } from "@pithy-sh/core/src/error/cause";\nconst reason = safeReason(cause);\n',
      ),
    ).toBeNull();
    // Nor is one that de-colours a log line for display — `dev/logging.ts` does exactly that.
    expect(decidesMessageSafety("const ANSI = /\\u001b\\[[0-9;]*m/g;\nline.replace(ANSI, '');\n")).toBeNull();
  });
});
