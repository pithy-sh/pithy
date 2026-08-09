// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { isShippedSource, isTestFile, readSource, sourceFiles, sourcePaths } from "./sourceFiles";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pithy-source-walk-"));
});
afterEach(async () => {
  // A locked directory below is chmod 0; restore it or the removal cannot descend.
  await chmod(join(root, "locked"), 0o755).catch(() => {});
  await rm(root, { recursive: true, force: true });
});

/** Write `contents` at `root/relative`, creating the directories above it. */
async function file(relative: string, contents = "// nothing\n"): Promise<string> {
  const path = join(root, ...relative.split("/"));
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, contents);
  return path;
}

/** Every found path, relative to the root, in posix separators. */
function named(paths: readonly string[]): string[] {
  return paths.map((path) =>
    path
      .slice(root.length + 1)
      .split(sep)
      .join("/"),
  );
}

describe("sourcePaths — what the walk keeps", () => {
  test("every shipped `.ts` in the tree, by default", async () => {
    await file("a.ts");
    await file("deep/nested/b.ts");
    expect(named(sourcePaths(root))).toEqual(["a.ts", "deep/nested/b.ts"]);
  });

  test("not a test file, and not a declaration file", async () => {
    await file("a.ts");
    await file("a.test.ts");
    await file("a.d.ts");
    expect(named(sourcePaths(root))).toEqual(["a.ts"]);
  });

  test("nor anything that is not TypeScript at all", async () => {
    await file("a.ts");
    await file("readme.md");
    await file("config.json");
    expect(named(sourcePaths(root))).toEqual(["a.ts"]);
  });

  test("the test files instead, when that is what is asked for", async () => {
    await file("a.ts");
    await file("a.test.ts");
    expect(named(sourcePaths(root, { keep: isTestFile }))).toEqual(["a.test.ts"]);
  });

  test("sorted, so a gate's answer does not depend on the order the filesystem hands them back", async () => {
    await file("z.ts");
    await file("a.ts");
    await file("m/n.ts");
    expect(named(sourcePaths(root))).toEqual(["a.ts", "m/n.ts", "z.ts"]);
  });
});

describe("sourcePaths — what the walk never descends into", () => {
  test("dependencies, build output and coverage", async () => {
    await file("a.ts");
    for (const directory of ["node_modules", "dist", "coverage"]) await file(`${directory}/b.ts`);
    expect(named(sourcePaths(root))).toEqual(["a.ts"]);
  });

  /**
   * The race in #185. `packages/cli/.smoke-*` and `.e2e-*` are whole scaffolded projects that other
   * suites create and delete while this walk runs, so a walk that descends into one collects paths that
   * are gone before they can be read — `ENOENT … packages/cli/.smoke-OXGbGb/pithy.config.ts`, observed
   * on a full-suite run. `.worktrees/` is the same shape at a larger size: a second checkout of this
   * whole repository, scanned as if it were this one.
   */
  test("nor any dotted directory — the scaffolds other suites create and delete mid-walk", async () => {
    await file("a.ts");
    await file(".smoke-abc123/pithy.config.ts");
    await file(".e2e-def456/apps/api/index.ts");
    await file(".worktrees/other-branch/packages/cli/src/b.ts");
    await file(".turbo/c.ts");
    expect(named(sourcePaths(root))).toEqual(["a.ts"]);
  });

  test("except `.github`, whose scripts are source this repository ships its CI on", async () => {
    await file("a.ts");
    await file(".github/scripts/plan.ts");
    expect(named(sourcePaths(root))).toEqual([".github/scripts/plan.ts", "a.ts"]);
  });

  test("nor a directory the caller names on top of those", async () => {
    await file("a.ts");
    await file("test-utils/harness.ts");
    expect(named(sourcePaths(root, { skip: ["test-utils"] }))).toEqual(["a.ts"]);
  });

  test("nor through a symlinked directory, which is another tree wearing this one's name", async () => {
    // `withFileTypes` reports a link as a link, not as the directory it points at. Following one would
    // walk `node_modules/<pkg>` back into a package already walked, and loop on a link to an ancestor.
    await file("real/a.ts");
    await symlink(join(root, "real"), join(root, "linked"));
    expect(named(sourcePaths(root))).toEqual(["real/a.ts"]);
  });
});

/**
 * The one way past the dotted rule, and it is shut unless a caller opens it (#215).
 *
 * The rule above is what keeps `.smoke-*`, `.e2e-*` and `.worktrees/` out of every tripwire in this
 * repository, so it stays the default and no caller loses it by someone else's change. But a caller can
 * want the opposite: the licence audit checks that **every shipped file** carries its header, and a
 * template that grew a `.vscode/`, a `.husky/` or a `.github/` would ship every file in it unchecked. A
 * gate whose reach is narrower than the rule it enforces under-reports in silence, which is worse than
 * one that fails loudly.
 *
 * `keep` narrows which files are taken and could never widen which directories are entered; that is what
 * this option is for, and it is the only thing it does. Everything else the walk refuses — dependencies,
 * build output, the caller's own `skip`, the vendored template copy, a symlink — is refused with the
 * opt-in on, asserted below.
 */
describe("sourcePaths — the caller that has to enter a dotted directory", () => {
  test("does not, unless it asks: the default is the rule every other caller relies on", async () => {
    await file("a.ts");
    await file(".vscode/settings.ts");
    expect(named(sourcePaths(root))).toEqual(["a.ts"]);
  });

  test("and enters every one of them when it asks", async () => {
    await file("a.ts");
    await file(".vscode/settings.ts");
    await file(".husky/hook.ts");
    await file(".vscode/deep/nested/tool.ts");
    expect(named(sourcePaths(root, { dotted: true }))).toEqual([
      ".husky/hook.ts",
      ".vscode/deep/nested/tool.ts",
      ".vscode/settings.ts",
      "a.ts",
    ]);
  });

  test("the opt-in widens the dotted rule and nothing else", async () => {
    // Every other exclusion is a separate decision and none of them is a dotted-directory rule in
    // disguise. A caller that wants a `.vscode/` inside a template must not thereby acquire
    // `node_modules`, a directory it named itself, or a second copy of the starter.
    await file("a.ts");
    await file(".vscode/settings.ts");
    for (const directory of ["node_modules", "dist", "coverage"]) await file(`${directory}/b.ts`);
    await file("test-utils/harness.ts");
    await file("packages/cli/templates/starter/pithy.config.ts");
    await symlink(join(root, ".vscode"), join(root, "linked"));

    expect(named(sourcePaths(root, { dotted: true, skip: ["test-utils"] }))).toEqual([".vscode/settings.ts", "a.ts"]);
  });

  test("nor does it change what a file has to be to be kept", async () => {
    await file(".vscode/settings.ts");
    await file(".vscode/settings.test.ts");
    await file(".vscode/settings.json");
    expect(named(sourcePaths(root, { dotted: true }))).toEqual([".vscode/settings.ts"]);
  });
});

/**
 * The one non-dotted transient, and the reason it cannot simply be dotted or moved (#192).
 *
 * `packages/cli/templates` is the copy of the repo root's `templates/starter` that `prepack` vendors in
 * and `postpack` takes out again. `files` in the CLI's manifest carries exactly that path — it is the
 * whole mechanism by which a published `@pithy-sh/cli` ships a starter (#143, #152) — so it is not
 * dotted and the dotted rule above does not reach it.
 *
 * The fixture is the two trees a pack has in flight, built in a temp root. Nothing here runs `prepack`,
 * which would put a real vendored copy under the checkout every other suite is walking.
 */
describe("sourcePaths — the vendored copy of the starter template", () => {
  /** The repo root's starter, the copy inside `packages/cli`, and one ordinary CLI source beside it. */
  async function midPack(): Promise<void> {
    for (const base of ["templates/starter", "packages/cli/templates/starter"]) {
      await file(`${base}/pithy.config.ts`);
      await file(`${base}/apps/api/src/index.ts`);
      await file(`${base}/apps/api/src/bindings.workers.test.ts`);
    }
    await file("packages/cli/src/bin.ts");
  }

  test("each template source once, whether or not a pack is in flight", async () => {
    await midPack();
    expect(named(sourcePaths(root))).toEqual([
      "packages/cli/src/bin.ts",
      "templates/starter/apps/api/src/index.ts",
      "templates/starter/pithy.config.ts",
    ]);
  });

  test("nor its tests, which CI's change planner would otherwise attribute to the CLI", async () => {
    // `crossPackageReads.ts` walks each workspace package for `*.test.ts`. The starter's own
    // `bindings.workers.test.ts` belongs to the repo root, which is not a package; through the vendored
    // copy it becomes a CLI test file, and the planner's answer changes with the pack.
    await midPack();
    expect(named(sourcePaths(root, { keep: isTestFile }))).toEqual([
      "templates/starter/apps/api/src/bindings.workers.test.ts",
    ]);
  });

  test("skipped by where it is, so a walk starting inside the package skips it too", async () => {
    await midPack();
    expect(named(sourcePaths(join(root, "packages", "cli")))).toEqual(["packages/cli/src/bin.ts"]);
  });

  test("but a `templates` directory anywhere else is source like any other", async () => {
    // By path, not by name. The copy is the only one that is a copy; the repo root's starter is the
    // source of truth the template tripwires exist to read, and a package may hold templates of its own.
    await file("templates/starter/pithy.config.ts");
    await file("packages/core/templates/a.ts");
    await file("tooling/license-headers/templates/b.ts");
    expect(named(sourcePaths(root))).toEqual([
      "packages/core/templates/a.ts",
      "templates/starter/pithy.config.ts",
      "tooling/license-headers/templates/b.ts",
    ]);
  });
});

/**
 * The half of #185 that hardening buys and moving the scaffolds cannot: the tree is not still while the
 * walk runs. Six tripwires in this repository read source across the whole tree, and any one of them can
 * be walking `packages/cli` at the moment another suite tears its scaffold down. A gate that fails on
 * somebody else's teardown is a gate people learn to re-run, and then to mute.
 */
describe("sourcePaths — a tree that changes while it is being read", () => {
  test("a directory it cannot read is skipped, not fatal", async () => {
    // Stands in for a directory removed between its parent being listed and it being opened, which is
    // the same `readdirSync` throw. Relies on the suite not running as root, where chmod does nothing.
    await file("a.ts");
    await file("locked/b.ts");
    await chmod(join(root, "locked"), 0o000);

    expect(named(sourcePaths(root))).toEqual(["a.ts"]);
  });

  test("a file that vanished between the listing and the read is skipped, not fatal", async () => {
    const gone = await file("gone.ts", "export const x = 1;\n");
    await file("stays.ts", "export const y = 2;\n");
    // The listing happened; the file did not survive to the read.
    const listed = sourcePaths(root);
    expect(named(listed)).toEqual(["gone.ts", "stays.ts"]);
    await rm(gone);

    expect(readSource(gone)).toBeNull();
    expect(sourceFiles(root).map((source) => source.text)).toEqual(["export const y = 2;\n"]);
  });

  test("a root that is not there at all is empty rather than a throw", () => {
    expect(sourcePaths(join(root, "not-here"))).toEqual([]);
  });
});

describe("sourceFiles", () => {
  test("hands back each file with the text it held, in the same order", async () => {
    await file("a.ts", "first\n");
    await file("b.ts", "second\n");
    expect(sourceFiles(root)).toEqual([
      { path: join(root, "a.ts"), text: "first\n" },
      { path: join(root, "b.ts"), text: "second\n" },
    ]);
  });
});

describe("the predicates a caller picks between", () => {
  test("shipped source is a `.ts` that is neither a test nor a declaration", () => {
    expect(isShippedSource("scaffold.ts")).toBe(true);
    expect(isShippedSource("scaffold.test.ts")).toBe(false);
    expect(isShippedSource("scaffold.workers.test.ts")).toBe(false);
    expect(isShippedSource("globals.d.ts")).toBe(false);
    expect(isShippedSource("wrangler.jsonc")).toBe(false);
  });

  test("a test file is a `.test.ts`, whatever else its name carries", () => {
    expect(isTestFile("scaffold.test.ts")).toBe(true);
    expect(isTestFile("worker.workers.test.ts")).toBe(true);
    expect(isTestFile("scaffold.ts")).toBe(false);
  });
});

/**
 * The gate: **no module writes its own recursive walk over a directory tree.**
 *
 * The module above is the answer to a defect that had six producers. #185 consolidated them and said so in
 * a changeset — *"every reader of this tree's own source now goes through `ci/sourceFiles.ts`"*. That was
 * not true. Five private traversals were never migrated, and nothing noticed, because a sentence in a
 * release note is not something a build can fail on. Every hardening since reached one walker and not the
 * others: #185's own ENOENT tolerance, and #192's vendored-path exclusion (#202).
 *
 * So the claim is stated here instead, where getting it wrong costs a red build.
 *
 * **The rule: a module must not define a function that lists a directory and calls itself.** That is the
 * shape all six had, and it is the shape that has to decide, on its own and therefore differently, what to
 * skip, whether to follow a link, and what a vanished entry means.
 *
 * **What it deliberately does not ban: `readdir(dir, { recursive: true })`.** Node walks that one, not the
 * author — there is no per-entry `stat` to throw, no skip list to get wrong, no link followed by accident —
 * so it cannot drift from this module the way six hand-written copies did. Eight call sites in this tree use
 * it, most over a directory the test itself just made under `os.tmpdir()`, and banning it would buy an
 * eight-entry allowlist against a shape that has never produced the defect. A listing that does not recurse
 * is not banned either: `readdir` over one directory is its ordinary use, all over this package.
 *
 * **It is a scan over source text, with the limits `atomic.test.ts` records**: TypeScript 7 ships no parser
 * API, so there is no AST to walk. Comments, string bodies and regular-expression bodies are blanked in one
 * pass, and a function's body is taken by indentation — this repository is Biome-formatted, so a body ends
 * at the first line indented no further than its header. What that cannot see is mutual recursion between
 * two functions, and a walk reached through a module that exports one. `.tsx` is out of scope on purpose:
 * JSX prose (`<h1>You're in.</h1>`) is not distinguishable from a string without a parser, and a scan that
 * mis-reads a file under-reports in silence. Nothing in this tree renders a screen and walks a disk.
 */
describe("no module writes its own walk over a directory tree", () => {
  /** The repository. This file lives at `packages/cli/src/ci/`; asserted below, so a move fails loudly. */
  const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..", "..");

  /** A module's key below: its path under the repo root, in posix separators. */
  const named = (path: string): string => relative(REPO_ROOT, path).split(sep).join("/");

  /** The one module the walk belongs to. Everything else asks it. */
  const PRIMITIVE = "packages/cli/src/ci/sourceFiles.ts";

  /**
   * The walks that stay, because their module cannot reach the primitive: path → the function, and why.
   *
   * An entry is a claim, and the test holds it to both halves — an undeclared walk fails, and a declared one
   * that has since been routed or moved fails too, so the list cannot go stale. Adding a line is the
   * reviewable act; that is the whole point of it. The question each `why` has to answer is the one #202
   * asked five times: **what stops this one from being routed, and is it a fact about the workspace or an
   * edit nobody made?** The second answer belongs in {@link NOT_YET_ROUTED}, not here.
   */
  const SEPARATE_ON_PURPOSE: Record<string, { walk: string; why: string }> = {
    "packages/ui-react/src/templates.test.ts": {
      walk: "treeFiles",
      why: "`@pithy-sh/ui-react` cannot import `@pithy-sh/cli`: the CLI depends on it, so the edge would be a cycle in the workspace graph. It reads `packages/ui-react/templates`, a committed tree nothing scaffolds into or deletes mid-run, so the race the primitive was hardened against cannot reach it.",
    },
    "tooling/license-headers/src/workspace.ts": {
      walk: "walk",
      // #211 decided this one rather than leaving it implied. The edge is one line — `"@pithy-sh/cli":
      // "workspace:*"` in that manifest, and the lockfile that follows it — so "it does not resolve today"
      // was a fact about an edit nobody had made, not a reason. This is the reason.
      why: "Declined, not blocked (#211). The edge is available for one devDependency line, and it is refused because of what it would invert: `tooling/license-headers` is the gate that stamps `packages/cli`'s own headers and it runs in `lint-staged` on every commit, so making the linter a dependent of the largest thing it lints points the graph backwards and pulls every CLI change into its `--affected` set. What the edge would buy was measured against this walk rather than assumed: symlinks it already declines (`withFileTypes` plus `isDirectory()`), the vendored `packages/cli/templates` is out of range because this reads `<pkg>/src`, and the one real gap — an unguarded `readdirSync` — is a `try`/`catch` in this file that costs no dependency at all and is now there. The edge would also buy only one of this package's two walks, because `audit.ts` below stays either way.",
    },
    "tooling/license-headers/src/audit.ts": {
      walk: "walk",
      // #202 gave two reasons for this one. Neither is a reason now: the first was never true, and #215
      // removed the second. What is left is the declined edge above, and it is the whole of it.
      why: "Same package, same declined edge, and now that is the only thing keeping it separate. #202 said the `templates` exclusion was the blocker and it never was: the primitive skips `packages/cli/templates` by path and nothing else, so the root `templates/starter` and `packages/ui-react/templates` are both kept (asserted above), and the copy it does skip is a byte-for-byte duplicate that exists only between `prepack` and `postpack` — a finding naming it names a file `postpack` deletes, which is a thing this audit should want skipped. The real blocker was the dotted-directory skip, since `templateFiles` needs every file of every extension at every depth and a template that grew a `.vscode/` would ship every file in it unchecked. That is closed: `dotted: true` is the opt-in, off by default so every caller that relies on the rule keeps it (#215, asserted above). So this walk stays for direction alone, and what the edge would have bought is asserted where it is needed rather than assumed — `audit.test.ts` and `workspace.test.ts` plant a dotted directory in a template tree and under a package's `src` and require the audit to report it.",
    },
  };

  /**
   * The walks that predate this rule and are **not** blessed by it: path → the function, and what it costs.
   *
   * A debt inventory, not an allowlist — the distinction being that every line here is meant to leave. Each
   * `costs` is the sentence that says why it is worth an issue. The count below is a ratchet: it falls as
   * these are routed, and a change that raises it is a change writing the seventh copy of one traversal.
   *
   * **It is empty, and that is the point.** It held one entry when this rule landed — `.github/scripts/planShards.ts`,
   * whose `testFileCount` had a guarded `readdirSync` and a bare `statSync` in the script that decides which
   * test jobs CI runs, so an entry vanishing between the listing and the probe took the whole matrix down. It
   * was routed in #211. A line added back here is a walk somebody wrote knowing this module exists.
   */
  const NOT_YET_ROUTED: Record<string, { walk: string; costs: string }> = {};

  /** The calls that hand back a directory's entries. A module reaching one of these lists a directory. */
  const LISTINGS = ["readdir", "readdirSync", "opendir", "opendirSync", "glob", "globSync"];

  /**
   * Comments, string bodies and regular-expression bodies blanked, length and newlines preserved.
   *
   * One pass rather than a chain of `replace`s, because the chain gets this wrong in both directions: a
   * `/*` inside a line comment opens a block comment that swallows the code after it, and a `//` inside a
   * string closes a line that never opened. Reading left to right, whichever of the four opens first wins,
   * which is what the language does.
   */
  function blank(text: string): string {
    const out = [...text];
    const wipe = (from: number, to: number): void => {
      for (let index = from; index < to && index < out.length; index += 1) {
        if (out[index] !== "\n") out[index] = " ";
      }
    };
    // The last character that was not whitespace, which is what says whether a `/` opens a regex or divides.
    let previous = "";
    let index = 0;
    while (index < text.length) {
      const here = text[index] as string;
      const next = text[index + 1];
      if (here === "/" && next === "/") {
        const line = text.indexOf("\n", index);
        const stop = line < 0 ? text.length : line;
        wipe(index, stop);
        index = stop;
        continue;
      }
      if (here === "/" && next === "*") {
        const close = text.indexOf("*/", index + 2);
        const stop = close < 0 ? text.length : close + 2;
        wipe(index, stop);
        index = stop;
        continue;
      }
      if (here === '"' || here === "'" || here === "`") {
        // A template's `${…}` is blanked with the rest of it, which is right: nothing inside one is a walk.
        let cursor = index + 1;
        while (cursor < text.length && text[cursor] !== here) cursor += text[cursor] === "\\" ? 2 : 1;
        wipe(index + 1, cursor);
        index = cursor + 1;
        previous = here;
        continue;
      }
      if (here === "/" && previous !== "" && !/[\w$)\]]/.test(previous)) {
        let cursor = index + 1;
        let inClass = false;
        while (cursor < text.length && text[cursor] !== "\n") {
          const character = text[cursor];
          if (character === "\\") {
            cursor += 2;
            continue;
          }
          if (character === "[") inClass = true;
          else if (character === "]") inClass = false;
          else if (character === "/" && !inClass) break;
          cursor += 1;
        }
        if (text[cursor] === "/") {
          wipe(index + 1, cursor);
          index = cursor + 1;
          previous = "/";
          continue;
        }
      }
      if (!/\s/.test(here)) previous = here;
      index += 1;
    }
    return out.join("");
  }

  /**
   * The local names in a module that list a directory, or `*` when it took the whole `fs` namespace and any
   * member call could be one. Read from the unblanked text, because an import specifier is a string.
   */
  function listers(source: string): Set<string> {
    const names = new Set<string>();
    for (const statement of source.matchAll(/\bimport\s+(?:type\s+)?([^;]*?)\s*from\s*["']([^"']+)["']/g)) {
      const clause = (statement[1] ?? "").trim();
      if (!/^(?:node:)?fs(?:\/promises)?$/.test(statement[2] ?? "")) continue;
      if (!clause.startsWith("{")) {
        names.add("*");
        continue;
      }
      for (const binding of clause.slice(1, -1).split(",")) {
        const [exported, alias] = binding
          .trim()
          .replace(/^type\s+/, "")
          .split(/\s+as\s+/);
        if (exported !== undefined && LISTINGS.includes(exported)) names.add(alias ?? exported);
      }
    }
    if (/\b(?:require|import)\(\s*["'](?:node:)?fs(?:\/promises)?["']\s*\)/.test(source)) names.add("*");
    return names;
  }

  /** A function header, at any indentation: `function walk(`, `const walk = `, and the exported forms. */
  const HEADER =
    /^(\s*)(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s*\*?\s*([\w$]+)|(?:const|let|var)\s+([\w$]+)\s*(?::[^=]*)?=)/;

  /** Every function in `source` that lists a directory and calls itself, by name, sorted. */
  function privateWalks(source: string): string[] {
    const names = listers(source);
    if (names.size === 0) return [];
    const lists = names.has("*")
      ? new RegExp(`(?:\\.\\s*)?\\b(?:${LISTINGS.join("|")})\\s*\\(`)
      : new RegExp(`\\b(?:${[...names].join("|")})\\s*\\(`);
    const lines = blank(source).split("\n");
    const found = new Set<string>();
    for (let start = 0; start < lines.length; start += 1) {
      const header = HEADER.exec(lines[start] as string);
      const name = header?.[2] ?? header?.[3];
      if (header === null || name === undefined) continue;
      const indent = (header[1] as string).length;
      // The body runs to the first line indented no further than the header — its own closing brace.
      let end = start + 1;
      for (; end < lines.length; end += 1) {
        const line = lines[end] as string;
        if (line.trim() !== "" && line.length - line.trimStart().length <= indent) break;
      }
      const body = lines.slice(start + 1, end).join("\n");
      if (lists.test(body) && new RegExp(`\\b${name}\\s*\\(`).test(body)) found.add(name);
    }
    return [...found].sort();
  }

  /**
   * Every module this rule covers: every `.ts` in the repository, tests included.
   *
   * Wider than #189's and #190's scope, which is each package's `src`, and it has to be: four of the five
   * walks #202 found were tests, one was in `.github/scripts`, and one was in `tooling/`. A rule about there
   * being one walk cannot be scoped to the places that already use it.
   */
  function modules(): string[] {
    return sourcePaths(REPO_ROOT, { keep: (name) => name.endsWith(".ts") && !name.endsWith(".d.ts") });
  }

  /** Every module but the primitive that walks a tree itself: path → the functions that do, sorted. */
  function walking(): Record<string, string> {
    const found: Record<string, string> = {};
    for (const path of modules()) {
      const key = named(path);
      if (key === PRIMITIVE) continue;
      const source = readSource(path);
      if (source === null) continue;
      const walks = privateWalks(source);
      if (walks.length > 0) found[key] = walks.join(", ");
    }
    return found;
  }

  test("the scan reaches the whole repository, not one package's source", () => {
    // A silent scan that finds nothing passes every rule below it, and a scan narrowed to `packages/*/src`
    // passes every module outside it — which is where three of #202's five were. So the scope is asserted
    // before the rule is, the failure mode that turned `atomic.test.ts`'s tripwire into decoration (#185).
    const found = modules().map(named);
    expect(found).toContain(PRIMITIVE);
    expect(found).toContain(".github/scripts/planShards.ts");
    expect(found).toContain("tooling/license-headers/src/workspace.ts");
    expect(found).toContain("packages/core/src/error/pithyError.ts");
    expect(found.length).toBeGreaterThan(1000);
  });

  test("the scan sees a hand-rolled walk in every shape this tree writes one in", () => {
    const sync = 'import { readdirSync, statSync } from "node:fs";\n';
    // The two spellings the five were written in: a named function, and a nested arrow.
    expect(privateWalks(`${sync}function walk(dir) {\n  for (const e of readdirSync(dir)) walk(e);\n}\n`)).toEqual([
      "walk",
    ]);
    expect(
      privateWalks(
        `${sync}function collect(root) {\n  const walk = (dir) => {\n    for (const e of readdirSync(dir)) walk(e);\n  };\n  walk(root);\n}\n`,
      ),
    ).toEqual(["walk"]);
    // An alias hides nothing, and neither does taking the whole namespace or the promises form.
    expect(
      privateWalks(
        `import { readdirSync as ls } from "fs";\nconst walk = (dir) => {\n  for (const e of ls(dir)) walk(e);\n};\n`,
      ),
    ).toEqual(["walk"]);
    expect(
      privateWalks(
        `import fs from "node:fs";\nfunction walk(dir) {\n  for (const e of fs.readdirSync(dir)) walk(e);\n}\n`,
      ),
    ).toEqual(["walk"]);
    expect(
      privateWalks(
        `import { readdir } from "node:fs/promises";\nasync function walk(dir) {\n  for (const e of await readdir(dir)) await walk(e);\n}\n`,
      ),
    ).toEqual(["walk"]);
  });

  test("and none of the shapes that are not one", () => {
    const sync = 'import { readdirSync } from "node:fs";\n';
    // Listing one directory is `readdir`'s ordinary use, and this package does it everywhere.
    expect(privateWalks(`${sync}function packages(dir) {\n  return readdirSync(dir);\n}\n`)).toEqual([]);
    // Node's own recursive listing is not a walk this repository wrote. See the docstring above.
    expect(privateWalks(`${sync}function packed(dir) {\n  return readdirSync(dir, { recursive: true });\n}\n`)).toEqual(
      [],
    );
    // Recursion over something that is not a directory listing is not this rule's business.
    expect(
      privateWalks(`${sync}function depth(node) {\n  return 1 + Math.max(...node.children.map(depth));\n}\n`),
    ).toEqual([]);
    // A caller that lists a directory and calls a walker is not itself the walker.
    expect(
      privateWalks(`${sync}function all(root) {\n  return readdirSync(root).flatMap((p) => sourcePaths(p));\n}\n`),
    ).toEqual([]);
    // Prose about a walk is not a walk. Every docstring in this tree describes one on purpose.
    expect(
      privateWalks(`${sync}// walk(dir) used to recurse here\nfunction walk(dir) {\n  return sourcePaths(dir);\n}\n`),
    ).toEqual([]);
    // Nor a string that spells one out — this file's own fixtures are exactly that.
    expect(privateWalks(`${sync}const shape = "function walk(d) { readdirSync(d); walk(d); }";\n`)).toEqual([]);
  });

  test("only the walks written down here are hand-rolled", () => {
    const declared = Object.fromEntries([
      ...Object.entries(SEPARATE_ON_PURPOSE).map(([path, { walk }]) => [path, walk]),
      ...Object.entries(NOT_YET_ROUTED).map(([path, { walk }]) => [path, walk]),
    ]);

    // One equality, failing from both sides. A module that starts walking is not in `declared` and shows up;
    // a declared one that was routed no longer matches and shows up too, so the list cannot rot. The message
    // is for the first case, which is the one that ships the seventh copy of this module.
    expect(walking(), "route it through ci/sourceFiles.ts, or say why this module cannot reach it").toEqual(declared);
  });

  test("and every walk that stays says why, in a sentence somebody has to disagree with", () => {
    // A reason nobody wrote is a reason nobody reviewed, and these lists are only worth having if adding to
    // either costs an argument. #202 exists because a changeset sentence cost none.
    for (const [path, { why }] of Object.entries(SEPARATE_ON_PURPOSE)) {
      expect(why.trim().length, path).toBeGreaterThan(40);
    }
    for (const [path, { costs }] of Object.entries(NOT_YET_ROUTED)) {
      expect(costs.trim().length, path).toBeGreaterThan(40);
    }
  });

  test("the debt list only shrinks", () => {
    // One when this rule landed, zero since #211. It cannot rise: a change that needs this number raised is a
    // change writing another private traversal into a repository that has spent four issues removing them.
    expect(Object.keys(NOT_YET_ROUTED).length).toBe(0);
    // And nothing may sit in both lists — unreachable and unrouted are different claims about one walk.
    for (const path of Object.keys(NOT_YET_ROUTED)) expect(SEPARATE_ON_PURPOSE[path]).toBeUndefined();
  });
});

/**
 * The repository. This file lives at `packages/cli/src/ci/`; the anchor assertions below fail if it moves.
 *
 * At module scope because three gates in this file measure the same tree, and a third `resolve` spelled
 * out is a third thing to correct the day this file moves.
 */
const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..", "..");

/** The byte, never a literal one. It is also what `git ls-files -z` separates paths with. */
const NUL = String.fromCharCode(0);

/**
 * Every path in git's index. `-z` because a path may hold anything but this byte and a slash.
 *
 * **Two gates read this listing, and its scope is asserted once**, in the first test below — a scan that
 * silently reaches nothing passes every rule written under it (#185). A second copy of this function
 * would be a second thing to keep in step with what git actually tracks.
 */
function tracked(): string[] {
  const listing = execFileSync("git", ["ls-files", "-z"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return listing.split(NUL).filter((path) => path !== "");
}

/**
 * **The rule: no file this repository commits contains a NUL byte.**
 *
 * A NUL is what makes git call a file binary, and a binary file has no line diff. `git diff` prints
 * `Bin 10043 -> 10128 bytes`, `--numstat` prints `-`, and every review of every change to it since
 * shows nothing. `.github/scripts/crossPackageReads.ts` carried one from the day it was written — a
 * dedup separator spelled as the raw byte instead of the escape — and that file is the one that
 * decides which suites CI plans, so the file whose job is to make gates run was the file whose
 * changes could not be read. It is also the likeliest reason two comments in it asserted something
 * false for three commits: the reviewer who would have caught them was never shown them (#216, #211).
 *
 * **The gate reads the bytes rather than asking git, and that is the whole design.** git decides
 * binary from the first 8000 bytes only. The same byte in that file was at offset 7-something when
 * three commits showed as `Bin`, and sits at 8251 today, so git now renders the file as text — the
 * defect did not go away, the file grew past the window git looks through. A gate that asks git
 * turns itself off as a file gets longer, and turns back on when someone deletes a paragraph.
 *
 * **The file set is git's index, not {@link sourcePaths}.** The property is about what git does with
 * a committed file, so the set has to be the committed files: the walk skips dotted directories, and
 * `.changeset/`, `.husky/` and `.vscode/` all hold committed text. It is also not a walk this
 * repository wrote — `git ls-files` does the listing — so it takes nothing away from the rule above.
 *
 * The byte is built with {@link String.fromCharCode} everywhere below, deliberately. Writing a test
 * *about* a NUL is the easiest way to put one in the test file, which would make this file the next
 * instance of what it exists to catch.
 */
describe("no file this repository commits is binary to git", () => {
  /**
   * Files allowed to hold it: path → why.
   *
   * **Empty, and this repository has never committed a binary file** — no image, no font, no fixture.
   * A line here is a claim that a path is not source, and adding one is the reviewable act: it costs
   * the argument that a genuinely binary asset belongs in a tree that is otherwise all text.
   */
  const BINARY_ON_PURPOSE: Record<string, string> = {};

  /** Where `path` first holds the byte, or `-1`. A file the index names but the tree lacks holds nothing. */
  function nulOffset(path: string): number {
    try {
      return readFileSync(path).indexOf(0);
    } catch {
      return -1;
    }
  }

  test("the scan reaches every file git tracks, not one directory and not one walk's idea of source", () => {
    // A scan that silently finds nothing passes the rule below it, so the scope is asserted first —
    // the failure mode that turned `atomic.test.ts`'s tripwire into decoration (#185).
    const paths = tracked();
    expect(paths).toContain(".github/scripts/crossPackageReads.ts");
    expect(paths).toContain("packages/cli/src/ci/sourceFiles.ts");
    expect(paths).toContain("templates/starter/package.json");
    // A dotted directory the source walk skips by design, and real committed text all the same.
    expect(paths).toContain(".changeset/config.json");
    expect(paths.length).toBeGreaterThan(1500);
  });

  test("and it sees the byte wherever it sits, including past the point git stops looking", async () => {
    const near = await file("near.ts", `const a = "x${NUL}y";\n`);
    // Past 8000 bytes: invisible to git's own check, which is exactly how the one in `.github/`
    // stopped rendering as `Bin` without anybody fixing it.
    const far = await file("far.ts", `${"// padding\n".repeat(900)}const b = "x${NUL}y";\n`);
    const clean = await file("clean.ts", 'const c = "xy";\n');
    expect(nulOffset(near)).toBeGreaterThanOrEqual(0);
    expect(nulOffset(far)).toBeGreaterThan(8000);
    expect(nulOffset(clean)).toBe(-1);
  });

  test("no committed file holds it", () => {
    const found: Record<string, string> = {};
    for (const path of tracked()) {
      if (path in BINARY_ON_PURPOSE) continue;
      const offset = nulOffset(join(REPO_ROOT, path));
      if (offset >= 0) found[path] = `NUL at byte ${offset}`;
    }
    expect(found, "write it as the two-character escape `\\0` — a raw one has no line diff").toEqual({});
  });

  test("and anything excused from that says why, in a sentence somebody has to disagree with", () => {
    for (const [path, why] of Object.entries(BINARY_ON_PURPOSE)) {
      expect(why.trim().length, path).toBeGreaterThan(40);
    }
  });
});

/**
 * **The rule: no file this repository commits carries a bidirectional control, or a C0 control other
 * than tab, newline and carriage return.**
 *
 * #216 gated the one class of invisible character git itself notices — a byte that makes a file binary,
 * so its diff never renders at all. This is the other class: characters git renders perfectly happily,
 * and a reviewer still cannot see. The gate above and this one are the same argument about two sets.
 *
 * **U+202E is why it is worth having.** A right-to-left override reorders how the text after it
 * *displays* without changing a byte of what the compiler reads — the Trojan Source technique
 * (CVE-2021-42574). The canonical demonstration is a comment or string that visually terminates early,
 * so a reviewer reads an admin guard opening and the compiler reads something else entirely. This
 * repository is the right kind of target: the kit is MIT and public, adopters run `pithy` against their
 * own Cloudflare accounts, and the CLI mints and reads credentials. An override landing in a template, a
 * generated config line or a capability manifest would be invisible in exactly the review that exists to
 * catch it.
 *
 * Nothing here was ever malicious, and **the first run over the committed tree still found ten across
 * five files.** Two were deliberate test input — the override and the BEL in
 * `packages/testers/src/nudge/copy.test.ts`, the suite that proves hostile control characters never reach
 * a nudge body, which is the right thing to test. The other eight were a raw ESC nobody meant: seven in
 * esbuild error fixtures copied between three packages, and one in **shipped source** —
 * `@pithy-sh/vite`'s ANSI-stripping regex, where two other copies of the same pattern spelled the escape
 * and that one held the byte. Drift, in a filter, that no review could have seen. #228 consolidated those
 * three copies into `@pithy-sh/core` and took it with them, before this gate ran.
 *
 * That is the whole argument (#221), and it is now demonstrated rather than hypothetical: **the
 * repository had no way to tell the deliberate two from the accidental eight.** #216 made it about a NUL
 * and found two more the moment it looked.
 *
 * The bidi set is the one rustc's `text_direction_codepoint_in_literal` lint uses: the embeddings and
 * overrides U+202A–U+202E, the isolates U+2066–U+2069, the marks U+200E and U+200F, and U+061C. The C0
 * half is everything below U+0020 except the three that give a text file its structure. NUL falls in
 * that range and is therefore refused twice, here and above — one rule is about what git renders and the
 * other about what a reader can see, and a byte is entitled to fail both.
 *
 * **The whole file, and git's index**, for #216's two reasons. The first matters more here than it did
 * there: git decides binary from the first 8000 bytes, so a gate that asks git turns itself off as a
 * file grows — and there is nothing about an override that confines it to a file's first page.
 *
 * Every refused character is a number below, and constructed where one is needed. Writing a test *about*
 * an override is the easiest way to put one in the test file — and unlike a NUL, one that landed here
 * would reorder the line a reviewer was reading it in.
 */
describe("no file this repository commits hides what it says", () => {
  /**
   * The bidirectional controls, as code points: rustc's `text_direction_codepoint_in_literal` set.
   *
   * Numbers rather than characters, throughout. There is no spelling of one of these in this file that a
   * reviewer cannot see.
   */
  const BIDI = [0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069];

  /** The three C0 controls a text file is made of. Everything else below U+0020 is refused. */
  const STRUCTURAL = new Set([0x09, 0x0a, 0x0d]);

  /**
   * Files allowed to carry one: path → why.
   *
   * **Empty, and it should stay that way.** A file that genuinely needs one of these as *input* builds
   * it with `String.fromCharCode`, or spells it as a six-character `\u` escape — exactly as
   * `copy.test.ts` now does, and as #216's own gate builds its NUL. That keeps the fixture and makes it
   * visible, which is the whole of what this rule asks for. A line here is a claim that some file cannot
   * do that, and adding one costs the argument.
   */
  const INVISIBLE_ON_PURPOSE: Record<string, string> = {};

  /**
   * Files that hold one today and should not: path → what it costs to leave it.
   *
   * Seven raw ESC bytes across three files, every one of them inside an esbuild error message copied
   * verbatim into a fixture, every one of them beside a `\n` its own line already spells as an escape —
   * the same shape #216 found. Each is a one-character edit, the raw byte for its own escape, in
   * three packages this change does not otherwise touch.
   *
   * **This list only shrinks.** A new violation does not belong on it: the fix for a character nobody
   * can see is to spell it, not to write down that it is there.
   */
  /**
   * Empty, and that is the point.
   *
   * Seven raw ESC bytes sat in three esbuild `Transform failed` fixtures when this gate was written —
   * two in `capabilities/loadFailure.test.ts`, three in `project/config.test.ts` (one inside a regex
   * literal, where an invisible character is a rule nobody reviewing the pattern can read), and two more
   * in `vite/src/workerConfig.test.ts`, which is how one unreadable line becomes three. Each was a
   * one-character edit to `\u001b`, and all seven were made before this landed.
   *
   * An eighth lived in shipped source — `vite/src/workerConfig.ts`'s ANSI-stripping regex — and went
   * with #228's consolidation into core. That one was never deliberate: three copies of one regex had
   * drifted, two spelling the escape and one carrying the byte, and nobody could see it. It is the
   * reason this gate exists rather than an argument for it.
   *
   * The list stays, empty, so the next raw byte has somewhere to be written down and a reason to be
   * argued for — and so the test below fails if anyone writes an entry that is no longer true.
   */
  const NOT_YET_ESCAPED: Record<string, { costs: string }> = {};

  /** Whether a code point is one this rule refuses. */
  function refused(code: number): boolean {
    return (code < 0x20 && !STRUCTURAL.has(code)) || BIDI.includes(code);
  }

  /** `U+202E`, from a number. The only way one of these is named anywhere in this repository's source. */
  function named(code: number): string {
    return `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
  }

  /**
   * The first refused character in `path`, named with its byte offset, or `null`.
   *
   * Read as text and scanned to the end — the offset is reported in bytes because that is what a
   * reviewer needs to find it, and the two differ the moment anything above ASCII precedes it. A file
   * the index names but the tree lacks carries nothing.
   */
  function firstInvisible(path: string): string | null {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      return null;
    }
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      if (refused(code)) return `${named(code)} at byte ${new TextEncoder().encode(text.slice(0, index)).length}`;
    }
    return null;
  }

  test("it sees one wherever it sits, including past the point git stops looking", async () => {
    // Built, never typed — see this block's opening note. `const a = "x` is twelve characters, so the
    // offset is stated rather than derived, and a change to either would have to be deliberate.
    const override = String.fromCharCode(0x202e);
    const bell = String.fromCharCode(0x07);
    const near = await file("near.ts", `const a = "x${override}y";\n`);
    const padding = "// padding\n".repeat(900);
    const far = await file("far.ts", `${padding}const b = "x${bell}y";\n`);
    expect(firstInvisible(near)).toBe("U+202E at byte 12");
    expect(firstInvisible(far)).toBe(`U+0007 at byte ${padding.length + 12}`);
    // Past the window git decides binary from, which is the reason this reads bytes rather than asking.
    expect(padding.length + 12).toBeGreaterThan(8000);
  });

  test("and the three characters a text file is made of are not among them", async () => {
    // A rule that flagged a tab would be turned off within a day, which is the failure mode that matters
    // most for a gate nobody can visually verify.
    const clean = await file("clean.ts", 'const c = "x\ty";\r\n// a comment\n');
    expect(firstInvisible(clean)).toBeNull();
  });

  test("no committed file carries one", () => {
    // The scope of `tracked()` is asserted by the gate above, on the same listing.
    const found: Record<string, string> = {};
    for (const path of tracked()) {
      if (path in INVISIBLE_ON_PURPOSE || path in NOT_YET_ESCAPED) continue;
      const first = firstInvisible(join(REPO_ROOT, path));
      if (first !== null) found[path] = first;
    }
    expect(found, "spell it — `\\u202e`, `\\u001b` — or build it; a raw one is invisible in review").toEqual({});
  });

  test("and both lists say why, in a sentence somebody has to disagree with", () => {
    for (const [path, why] of Object.entries(INVISIBLE_ON_PURPOSE)) {
      expect(why.trim().length, path).toBeGreaterThan(40);
    }
    for (const [path, { costs }] of Object.entries(NOT_YET_ESCAPED)) {
      expect(costs.trim().length, path).toBeGreaterThan(40);
    }
  });

  test("the debt list only shrinks", () => {
    // Three when this rule landed. It cannot rise: a change that needs this number raised is a change
    // committing a character nobody reviewing it can see, which is the thing being gated.
    expect(Object.keys(NOT_YET_ESCAPED).length).toBeLessThanOrEqual(3);
    // And nothing may sit in both lists — "cannot be spelled" and "has not been spelled yet" are
    // different claims about one character.
    for (const path of Object.keys(NOT_YET_ESCAPED)) expect(INVISIBLE_ON_PURPOSE[path]).toBeUndefined();
  });

  test("every path on the debt list is still there, holding what the list says it holds", () => {
    // A list that outlives the file it names is a list that quietly excuses a path somebody else later
    // creates. Both halves fail here: a path that was fixed, and a path that was deleted.
    const stale: string[] = [];
    for (const path of Object.keys(NOT_YET_ESCAPED)) {
      if (firstInvisible(join(REPO_ROOT, path)) === null) stale.push(path);
    }
    expect(stale, "escaped or gone — take it off the list").toEqual([]);
  });
});

/**
 * **The rule: nothing the `plan` job runs may import anything that has to be installed.**
 *
 * `ci.yml`'s `plan` job has no `bun install` step, deliberately — a `turbo --dry=json` run reads the
 * workspace manifests and nothing else, and that job is pure latency in front of every test job. So
 * the two scripts it runs, and everything they reach, may import `node:` builtins and relative paths
 * and nothing else. One bare specifier makes the job throw before it plans anything, and a workflow
 * that plans nothing is green.
 *
 * It was a property nobody could break by accident while both scripts imported two builtins each.
 * #211 gave `planShards.ts` a cross-tree import, and #214 put both scripts in a tsconfig — which is
 * the change that makes this worth asserting, because a type check resolves a bare specifier through
 * `node_modules` perfectly happily and would license exactly the import that breaks the job.
 *
 * The graph is written down as well as checked. A module joining it is a module whose own imports
 * now have to satisfy this rule too, and that is a thing to notice rather than to inherit.
 */
describe("the plan job runs before `bun install`, so its scripts import only builtins and relative paths", () => {
  /** What CI runs, and therefore what the closure starts from. */
  const ENTRY_POINTS = [".github/scripts/crossPackageReads.ts", ".github/scripts/planShards.ts"];

  /**
   * Every module reachable from those two, path → the specifiers it imports.
   *
   * One entry beyond the entry points, and it is the reason the walk lives where it does: both halves
   * of CI's planner needed it, so it was placed where a relative path could reach it from `.github/`
   * without either script acquiring a dependency (#185, #211).
   */
  const GRAPH: Record<string, string[]> = {
    ".github/scripts/crossPackageReads.ts": [
      "../../packages/cli/src/ci/sourceFiles",
      "node:fs",
      "node:path",
      "node:url",
    ],
    ".github/scripts/planShards.ts": ["../../packages/cli/src/ci/sourceFiles", "node:fs", "node:path"],
    "packages/cli/src/ci/sourceFiles.ts": ["node:fs", "node:path"],
  };

  /** A module's key: its path under the repo root, in posix separators. */
  const named = (path: string): string => relative(REPO_ROOT, path).split(sep).join("/");

  /**
   * Every specifier `source` imports, in each of the four spellings that reach a module.
   *
   * `from "x"` covers the static forms including `export … from` and `import type`, which
   * `verbatimModuleSyntax` still has to resolve. `import("x")` and `require("x")` cover the rest.
   */
  function specifiers(source: string): string[] {
    const found: string[] = [];
    for (const match of source.matchAll(/\bfrom\s*["']([^"']+)["']/g)) found.push(match[1] as string);
    for (const match of source.matchAll(/\b(?:import|require)\s*\(\s*["']([^"']+)["']/g)) {
      found.push(match[1] as string);
    }
    return [...new Set(found)].sort();
  }

  /** Where a relative specifier lands, extensionless imports included. `null` if it resolves to nothing. */
  function resolveRelative(from: string, specifier: string): string | null {
    const base = resolve(join(REPO_ROOT, from), "..", specifier);
    for (const candidate of [`${base}.ts`, join(base, "index.ts"), base]) {
      if (readSource(candidate) !== null) return candidate;
    }
    return null;
  }

  /** The closure over the entry points: path → its specifiers, following the relative ones. */
  function graph(): Record<string, string[]> {
    const found: Record<string, string[]> = {};
    const queue = [...ENTRY_POINTS];
    while (queue.length > 0) {
      const path = queue.shift() as string;
      if (path in found) continue;
      const source = readSource(join(REPO_ROOT, path));
      expect(source, `${path} is what CI runs and it is not there`).not.toBeNull();
      const imports = specifiers(source as string);
      found[path] = imports;
      for (const specifier of imports) {
        if (!specifier.startsWith(".")) continue;
        const target = resolveRelative(path, specifier);
        if (target !== null) queue.push(named(target));
      }
    }
    return found;
  }

  test("no bare specifier anywhere in either script's graph", () => {
    const bare: Record<string, string[]> = {};
    for (const [path, imports] of Object.entries(graph())) {
      const offenders = imports.filter((specifier) => !specifier.startsWith("node:") && !specifier.startsWith("."));
      if (offenders.length > 0) bare[path] = offenders;
    }
    expect(bare, "the `plan` job has no `bun install`, so this import cannot resolve when CI runs it").toEqual({});
  });

  test("every relative import in it resolves to a file that is there", () => {
    // An import that resolves to nothing is the same outage as a bare one, and a typecheck alone
    // would not catch a path that only the running script uses.
    const dangling: string[] = [];
    for (const [path, imports] of Object.entries(graph())) {
      for (const specifier of imports) {
        if (specifier.startsWith(".") && resolveRelative(path, specifier) === null) {
          dangling.push(`${path} → ${specifier}`);
        }
      }
    }
    expect(dangling).toEqual([]);
  });

  test("and the graph is exactly these modules", () => {
    // Written down as well as derived: a module joining the closure inherits this rule, and that is
    // a thing somebody should have to add a line for.
    expect(graph()).toEqual(GRAPH);
  });
});
