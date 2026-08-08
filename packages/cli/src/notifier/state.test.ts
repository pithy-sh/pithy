// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readdirSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { isValidProjectName, kebab, MAX_PROJECT_NAME } from "@pithy-sh/core/src/naming/resource";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { readSource, sourcePaths } from "../ci/sourceFiles";
import {
  defaultState,
  type NotifierState,
  projectConfigDir,
  readState,
  setNotifierFlag,
  stateDir,
  stateFilePath,
  writeState,
} from "./state";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-state-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("stateDir / stateFilePath", () => {
  test("POSIX default is ~/.config/pithy", () => {
    expect(stateDir({ platform: "linux", homedir: "/home/u", env: {} })).toBe("/home/u/.config/pithy");
    expect(stateFilePath({ platform: "linux", homedir: "/home/u", env: {} })).toBe("/home/u/.config/pithy/state.json");
  });

  test("honors XDG_CONFIG_HOME", () => {
    expect(stateDir({ platform: "linux", homedir: "/home/u", env: { XDG_CONFIG_HOME: "/cfg" } })).toBe("/cfg/pithy");
  });

  test("Windows uses %APPDATA%", () => {
    expect(
      stateDir({ platform: "win32", homedir: "C:\\Users\\u", env: { APPDATA: "C:\\Users\\u\\AppData\\Roaming" } }),
    ).toBe(join("C:\\Users\\u\\AppData\\Roaming", "pithy"));
  });

  test("PITHY_CONFIG_DIR wins over every platform rule, and adds no pithy segment", () => {
    // It IS the pithy config directory, not a config root to nest under: a test harness that points it
    // at a temp directory has to be able to read `<dir>/<project>/secrets.jsonc` back without guessing.
    expect(stateDir({ platform: "linux", homedir: "/home/u", env: { PITHY_CONFIG_DIR: "/run/pithy" } })).toBe(
      "/run/pithy",
    );
    expect(
      stateDir({
        platform: "linux",
        homedir: "/home/u",
        env: { PITHY_CONFIG_DIR: "/run/pithy", XDG_CONFIG_HOME: "/cfg" },
      }),
    ).toBe("/run/pithy");
    expect(
      stateDir({
        platform: "win32",
        homedir: "C:\\Users\\u",
        env: { PITHY_CONFIG_DIR: "D:\\pithy", APPDATA: "C:\\x" },
      }),
    ).toBe(resolve("D:\\pithy"));
  });

  test("a relative PITHY_CONFIG_DIR is made absolute, and an empty one is no override", () => {
    // Every error the secrets file raises names its absolute path, so the resolver may not hand out a
    // relative one that means a different directory in every command that resolves its own cwd.
    expect(stateDir({ platform: "linux", homedir: "/home/u", env: { PITHY_CONFIG_DIR: "cfg" } })).toBe(resolve("cfg"));
    expect(stateDir({ platform: "linux", homedir: "/home/u", env: { PITHY_CONFIG_DIR: "  " } })).toBe(
      "/home/u/.config/pithy",
    );
  });
});

/**
 * #200. **Under vitest, this resolver refuses to answer with the operator's own machine.**
 *
 * One `bun run test` left 36 directories in a maintainer's real `~/.config/pithy`, each holding a
 * genuinely minted AES master key, and wrote `SECRETS_STORE_ID` into their real `cloudflare.json`.
 * `addBootstrap.test.ts` passed no `paths` seam, so `bootstrapAdd` resolved the real directory, and
 * nothing anywhere said no.
 *
 * The repo-root `vitest.setup.ts` is the floor: every test gets a throwaway `PITHY_CONFIG_DIR`. This is
 * the thing the floor cannot do. A safe default still lets a test opt back into the real directory by
 * accident — one `vi.stubEnv`, one curated env map, one suite that clears the variable — and it does so
 * silently, because a real path looks exactly like a fake one. A resolver that refuses cannot.
 *
 * **What counts as an answer the caller chose:** `PITHY_CONFIG_DIR`, or the seam. `process.env` is the
 * operator's shell and `os.homedir()` is their home directory; neither is chosen by a test, so neither
 * is reachable from one. Nothing here fires outside vitest, so a real `pithy` run is untouched.
 */
describe("stateDir under vitest", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** No override, no injected environment, nothing chosen — the exact shape `addBootstrap.test.ts` had. */
  function noSeam(): void {
    vi.stubEnv("PITHY_CONFIG_DIR", "");
  }

  test("no seam at all is a refusal, not the operator's directory", () => {
    noSeam();
    const thrown = (() => {
      try {
        return stateDir();
      } catch (error: unknown) {
        return error;
      }
    })();

    expect(thrown).toBeInstanceOf(PithyError);
    // The message has to name the fix, because whoever sees it wrote a test and not this file.
    expect((thrown as PithyError).payload.message).toContain("PITHY_CONFIG_DIR");
    expect((thrown as PithyError).payload.action).toContain("PITHY_ALLOW_REAL_CONFIG_DIR");
  });

  test("an injected environment is not enough when the answer still comes from the real home", () => {
    // The environment is the caller's, the home directory is the machine's. `XDG_CONFIG_HOME` unset is
    // the ordinary case on macOS, so this is the branch a forgetful test lands on.
    expect(() => stateDir({ platform: "linux", env: {} })).toThrow(PithyError);
    expect(() => stateDir({ platform: "win32", env: {} })).toThrow(PithyError);
  });

  test("a synthetic answer is fine — nothing real was reached", () => {
    // No home directory is consulted on either of these branches, so there is nothing to refuse.
    expect(stateDir({ platform: "linux", env: { XDG_CONFIG_HOME: "/cfg" } })).toBe("/cfg/pithy");
    expect(stateDir({ platform: "win32", env: { APPDATA: "C:\\x" } })).toBe(join("C:\\x", "pithy"));
  });

  test("the seam satisfies it, in both of its spellings", () => {
    noSeam();
    expect(stateDir({ env: { PITHY_CONFIG_DIR: "/run/pithy" } })).toBe("/run/pithy");
    expect(stateDir({ platform: "linux", homedir: "/home/u", env: {} })).toBe("/home/u/.config/pithy");
  });

  test("the floor under every suite: the setup file's directory is the answer, unasked", () => {
    // `vitest.setup.ts` at the repo root sets this before a test file is imported, which is why the
    // twelve hundred tests that never think about it still resolve somewhere disposable.
    const configured = process.env.PITHY_CONFIG_DIR;
    expect(configured).toBeTruthy();
    expect(stateDir()).toBe(configured);
    // The shape the setup file mints, asserted rather than assumed. A developer who exports
    // `PITHY_CONFIG_DIR` in their own shell would otherwise satisfy the two lines above without the
    // setup file having run at all, and this test is the one that says it did.
    expect(configured).toContain(join(tmpdir(), "pithy-test-config-"));
  });

  test("an integration suite that means the real directory says so, once, out loud", () => {
    noSeam();
    vi.stubEnv("XDG_CONFIG_HOME", "");
    vi.stubEnv("PITHY_ALLOW_REAL_CONFIG_DIR", "1");
    expect(stateDir({ platform: "linux" })).toBe(join(homedir(), ".config", "pithy"));
  });
});

describe("readState", () => {
  test("missing file → safe default", async () => {
    expect(await readState(join(dir, "nope.json"))).toEqual(defaultState());
  });

  test("malformed JSON → safe default, never throws", async () => {
    const file = join(dir, "state.json");
    await writeFile(file, "{ not json");
    expect(await readState(file)).toEqual(defaultState());
  });

  test("schema-invalid payload → safe default", async () => {
    const file = join(dir, "state.json");
    await writeFile(file, JSON.stringify({ lastCheck: "yesterday", installer: "cargo" }));
    expect(await readState(file)).toEqual(defaultState());
  });

  test("honors a hand-edited notifier:false", async () => {
    const file = join(dir, "state.json");
    await writeState(file, { ...defaultState(), notifier: false });
    expect((await readState(file)).notifier).toBe(false);
  });
});

describe("writeState", () => {
  test("round-trips through the schema and creates the directory", async () => {
    const file = join(dir, "nested", "state.json");
    const state: NotifierState = {
      lastCheck: 1_700_000_000_000,
      latestVersion: "1.3.0",
      installer: "bun",
      notifier: true,
      securityFlagged: false,
    };
    await writeState(file, state);
    expect(await readState(file)).toEqual(state);
    // Written as pretty JSON with a trailing newline.
    expect(await readFile(file, "utf8")).toMatch(/\n$/);
  });
});

describe("setNotifierFlag", () => {
  test("flips the flag while preserving other fields", async () => {
    const file = join(dir, "state.json");
    await writeState(file, { lastCheck: 42, latestVersion: "1.2.0", installer: "npm", notifier: true });
    await setNotifierFlag(file, false);
    const after = await readState(file);
    expect(after.notifier).toBe(false);
    expect(after.lastCheck).toBe(42);
    expect(after.latestVersion).toBe("1.2.0");
    await setNotifierFlag(file, true);
    expect((await readState(file)).notifier).toBe(true);
  });

  test("creates the file from the default when none exists yet", async () => {
    const file = join(dir, "state.json");
    await setNotifierFlag(file, false);
    expect(await readState(file)).toEqual({ ...defaultState(), notifier: false });
  });
});

/**
 * The join that turns a project name into the directory holding every dev secret that project has.
 *
 * Safe today, and it was safe before this: every caller passes a name already through
 * `requireProjectName` or `kebab`. What was missing is where the rule was *stated* — at each call site,
 * which is the #183 shape (#171 narrowed a manifest's default values, #174 an option's key and describe,
 * #183 the capability's own name: three rounds for one rule that was never stated where it belonged).
 * #206 added a caller to this family within a day of the last one, so "every caller happens to have
 * normalised earlier" is a property of the call graph rather than of the value.
 */
describe("projectConfigDir", () => {
  const options = { platform: "linux" as const, homedir: "/home/u", env: { PITHY_CONFIG_DIR: "/cfg" } };

  /** The refusal, or `null` when the join was allowed. */
  function refusal(name: string): PithyError | null {
    try {
      projectConfigDir(name, options);
    } catch (error) {
      return error as PithyError;
    }
    return null;
  }

  test("a normalised project name is a directory under the config directory", () => {
    expect(projectConfigDir("replay", options)).toBe("/cfg/replay");
    expect(projectConfigDir("acme-dash", options)).toBe("/cfg/acme-dash");
  });

  test("a separator, `..`, empty, and a control character are each refused, naming the value", () => {
    // Nothing else guards this path. `ensureScaffoldPath` guards writes *inside a project*, and this
    // directory is outside every checkout — so an escape here is an escape with no second line.
    for (const name of ["../evil", "a/b", "a\\b", "..", ".", "", "   ", "a b", "a\u0000b", "a\tb"]) {
      const thrown = refusal(name);
      expect(thrown, JSON.stringify(name)).toBeInstanceOf(PithyError);
      // The value, so the operator can see which name it was. `pithy.config.ts` `name` is not a secret.
      expect(`${thrown?.payload.message} ${thrown?.payload.detail ?? ""}`, JSON.stringify(name)).toContain(name);
    }
  });

  test("**a typed name and a slug are held to the same rule** — the two-path problem (#206)", () => {
    // `assertValidProjectName` is read *after* kebabbing, on purpose: `Acme Corp` is a legal project name
    // because it becomes `acme-corp`. So it answers a question about the slug, and the string reaching
    // this join is whichever of the two the caller happened to have. `My/Project` kebabs to `my-project`
    // and passes that validator whole — joined verbatim it is two path segments. Both halves, or the
    // rule is only true of one of the two ways a name arrives.
    expect(isValidProjectName("My/Project")).toBe(true);
    expect(refusal("My/Project")).toBeInstanceOf(PithyError);
    expect(refusal("Acme Corp")).toBeInstanceOf(PithyError);
    expect(projectConfigDir(kebab("My/Project"), options)).toBe("/cfg/my-project");
  });

  test("a name too long for any Cloudflare namespace is refused here too — one rule, not a second one", () => {
    expect(refusal("a".repeat(MAX_PROJECT_NAME + 1))).toBeInstanceOf(PithyError);
    expect(projectConfigDir("a".repeat(MAX_PROJECT_NAME), options)).toBe(`/cfg/${"a".repeat(MAX_PROJECT_NAME)}`);
  });
});

/**
 * The gate — **no config string is joined into the config directory without passing a validator.**
 *
 * Stated about the *segment*, not about the two functions that join one today. Enumerating the known
 * ones is what produced the second and the third instance of every other class of this in the tree:
 * #171, #174 and #183 were one rule about a name, narrowed three times at three call sites, and #206
 * added a fourth joiner to this very directory within a day of the third.
 *
 * **What the directory is worth.** `<config>/<project>/` holds `secrets.jsonc`, `dev.json`,
 * `tokens.json` and, beside it, the account-scoped `cloudflare*.json` — every dev secret a project has
 * and the credentials that mint more. It is outside every checkout, so `ensureScaffoldPath` (which
 * guards writes *inside a project*) does not reach it. There is no second line of defence, which is why
 * the first one is a rule rather than a habit.
 *
 * **The rule is decidable from the text.** A segment joined onto `stateDir()` is either a literal
 * filename this repository typed itself, or the answer of a function that validated it. Anything else is
 * a value from a config, a flag or a call graph reaching a path with nothing between.
 *
 * **Its limit, stated rather than discovered.** Like every other gate here it is a scan over source
 * text — TypeScript 7 ships no parser API, so there is no AST to walk. It sees `join(stateDir(…), …)`
 * and `const root = stateDir(…); join(root, …)`; what it cannot see is a `stateDir` handed through a
 * parameter into another module and joined there. `siblingsWithSecrets(stateDir(options), path)` is the
 * one call in the tree that does hand it on, and it joins directory entries it read *back* rather than
 * a config string — the rule applied rather than evaded.
 */
describe("no config string is joined into the config directory without passing a validator", () => {
  /** `packages/` — this file lives at `packages/cli/src/notifier/`. */
  const PACKAGES = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

  /** A module's key below: its path under `packages/`, in posix separators. */
  const named = (path: string): string => relative(PACKAGES, path).split(sep).join("/");

  /**
   * The validators a segment may come from: name → the argument that it is one.
   *
   * **A list of validators, not of joiners.** It grows when somebody writes a new way to make a config
   * string safe, which is the reviewable act; it does not grow when somebody writes a new join, which is
   * the act that keeps producing this defect.
   */
  const VALIDATORS: Record<string, string> = {
    projectConfigSegment:
      "Holds the name to `assertValidProjectName` *and* to being its own kebab form — the two ways a project name arrives (#212), since the validator is read after kebabbing and `My/Project` passes it whole.",
    cloudflareAccountFile:
      "Parses `accountName` through `CloudflareAccountName` before it becomes `cloudflare.<name>.json` — validated at the schema precisely because it becomes a filename (#206).",
  };

  /** Comments blanked, length preserved, so prose naming a `join` is never read as one. */
  function stripComments(text: string): string {
    return text
      .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
      .replace(/(^|[^:"'`\\])\/\/[^\n]*/gm, (line, lead: string) => lead + line.slice(lead.length).replace(/./g, " "));
  }

  /**
   * Every `join(…)` in a module, as its top-level arguments.
   *
   * Its own scanner rather than a regex: an argument may hold nested calls, and a comma inside one of
   * them is not an argument boundary. Quotes are tracked for the same reason, and so that a literal
   * segment can still be recognised as one afterwards.
   */
  function joinCalls(text: string): string[][] {
    const calls: string[][] = [];
    for (const call of text.matchAll(/\bjoin\s*\(/g)) {
      const args: string[] = [];
      let depth = 0;
      let quote: string | null = null;
      let start = call.index + call[0].length;
      for (let index = start; index < text.length; index += 1) {
        const character = text[index];
        if (quote !== null) {
          if (character === "\\") index += 1;
          else if (character === quote) quote = null;
          continue;
        }
        if (character === '"' || character === "'" || character === "`") quote = character;
        else if (character === "(" || character === "[" || character === "{") depth += 1;
        else if (character === ")" && depth === 0) {
          args.push(text.slice(start, index));
          break;
        } else if (character === ")" || character === "]" || character === "}") depth -= 1;
        else if (character === "," && depth === 0) {
          args.push(text.slice(start, index));
          start = index + 1;
        }
      }
      calls.push(args.map((argument) => argument.trim()).filter((argument) => argument.length > 0));
    }
    return calls;
  }

  /** A segment this repository typed itself: one quoted string, no interpolation. */
  function isLiteral(argument: string): boolean {
    if (!/^(['"`])[\s\S]*\1$/.test(argument)) return false;
    const body = argument.slice(1, -1);
    return !body.includes("${") && !/(?<!\\)['"`]/.test(body);
  }

  /** A segment a validator answered for. */
  function isValidated(argument: string): boolean {
    const called = /^(\w+)\s*\(/.exec(argument);
    return called !== null && Object.hasOwn(VALIDATORS, called[1] ?? "");
  }

  /** Every segment joined onto the config directory in a module, and whether the rule allows it. */
  function configSegments(source: string): { segment: string; allowed: boolean }[] {
    const text = stripComments(source);
    const roots = ["stateDir"];
    for (const assignment of text.matchAll(/\b(?:const|let|var)\s+(\w+)\s*=\s*stateDir\s*\(/g)) {
      roots.push(assignment[1] ?? "");
    }
    const found: { segment: string; allowed: boolean }[] = [];
    for (const args of joinCalls(text)) {
      const [first, ...rest] = args;
      if (first === undefined) continue;
      if (!roots.some((root) => new RegExp(`\\b${root}\\b`).test(first))) continue;
      for (const segment of rest) found.push({ segment, allowed: isLiteral(segment) || isValidated(segment) });
    }
    return found;
  }

  /** Every package's shipped source — the walk `ci/sourceFiles.ts` already reads this tree through. */
  function modules(): string[] {
    const found: string[] = [];
    for (const pkg of readdirSync(PACKAGES, { withFileTypes: true })) {
      if (!pkg.isDirectory()) continue;
      found.push(...sourcePaths(join(PACKAGES, pkg.name, "src"), { skip: ["test-utils"] }));
    }
    return found.sort();
  }

  /** Every config join in the tree: path → its segments, allowed or not. */
  function joins(): Record<string, { segment: string; allowed: boolean }[]> {
    const found: Record<string, { segment: string; allowed: boolean }[]> = {};
    for (const path of modules()) {
      const source = readSource(path);
      if (source === null) continue;
      const segments = configSegments(source);
      if (segments.length > 0) found[named(path)] = segments;
    }
    return found;
  }

  test("the walk finds the joins that are there — a silent scan passes every rule below it", () => {
    // #185's lesson: a tripwire that walks nothing is decoration. The two joiners known today are named
    // here as *evidence the scan works*, never as the rule — the rule is the assertion after them.
    const found = joins();
    expect(Object.keys(found)).toContain("cli/src/notifier/state.ts");
    expect(Object.keys(found)).toContain("cli/src/cloudflare/config.ts");
    expect(Object.values(found).flat().length).toBeGreaterThanOrEqual(3);
  });

  test("every segment joined into the config directory is a literal or a validator's answer", () => {
    const offending: Record<string, string[]> = {};
    for (const [path, segments] of Object.entries(joins())) {
      const unvalidated = segments.filter(({ allowed }) => !allowed).map(({ segment }) => segment);
      if (unvalidated.length > 0) offending[path] = unvalidated;
    }

    expect(
      offending,
      "validate the segment before it becomes a path — that directory holds every dev secret a project has, and nothing else guards it",
    ).toEqual({});
  });

  test("and every validator says what it validates, in a sentence somebody has to disagree with", () => {
    // A validator nobody argued for is a hole with a name. Adding one is meant to cost an argument.
    for (const [name, why] of Object.entries(VALIDATORS)) expect(why.trim().length, name).toBeGreaterThan(40);
  });

  test("the scan sees the shapes it must, and a planted violation fails it", () => {
    const flagged = (source: string): string[] =>
      configSegments(source)
        .filter(({ allowed }) => !allowed)
        .map(({ segment }) => segment);

    // The plant: a name joined straight onto the config directory, which is the whole defect.
    expect(flagged("return join(stateDir(options), project);")).toEqual(["project"]);
    // Through a local, which is the same thing spelled over two lines.
    expect(flagged("const root = stateDir(options);\nreturn join(root, config.name, DEV);")).toEqual([
      "config.name",
      "DEV",
    ]);
    // A template is not a literal — `${project}` is the value arriving by another spelling.
    const interpolated = `\`\${project}-dev\``;
    expect(flagged(`join(stateDir(o), ${interpolated})`)).toEqual([interpolated]);
    // What the rule allows: a filename this repository typed, and a validator's answer.
    expect(flagged('join(stateDir(options), "state.json")')).toEqual([]);
    expect(flagged("join(stateDir(options), projectConfigSegment(project))")).toEqual([]);
    expect(flagged("join(stateDir(options), cloudflareAccountFile(options.account?.accountName))")).toEqual([]);
    // A join that is not into the config directory is not this rule's business.
    expect(flagged("join(devSecretsDir(project, options), MINTED_TOKENS_FILE_NAME)")).toEqual([]);
    // Nor is prose about one. Every docstring in this tree names these functions on purpose.
    expect(flagged("// join(stateDir(o), project) is exactly what this forbids\njoin(a, b);")).toEqual([]);
  });
});
