// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

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
      // The `templates` half of #202's reason was checked here and is wrong; the dotted half is the real one.
      why: "Same package, same declined edge — and this one could not be routed even with it, though not for the reason #202 recorded. The `templates` exclusion is not the blocker: the primitive skips `packages/cli/templates` by path and nothing else, so the root `templates/starter` and `packages/ui-react/templates` are both kept (asserted above), and the vendored copy it does skip is a byte-for-byte duplicate of the root starter that exists only between `prepack` and `postpack` — a finding naming it names a file `postpack` deletes, which is a thing this audit should want skipped. The blocker is direction: `templateFiles` wants every file of every extension at every depth, and the primitive skips dotted directories with no option to stop, because that rule is what keeps `.smoke-*`, `.e2e-*` and `.worktrees/` out of every other caller (#185). `keep` narrows which files are taken; nothing widens which directories are entered. A template shipping a `.vscode/` — none does today — would go unchecked in silence, and a licence gate that under-reports is worse than one that walks its own tree.",
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
