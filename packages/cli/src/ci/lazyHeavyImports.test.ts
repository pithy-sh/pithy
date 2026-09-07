// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { existsSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { blankComments } from "@pithy-sh/core/src/text/comments";
import { describe, expect, test } from "vitest";
import { readSource, sourcePaths } from "./sourceFiles";

/**
 * **Nothing on a command's static import graph may load a module that only a network or a runtime needs.**
 *
 * `pithy add --help` cost 867 ms under Node, and a `--cpu-prof` said where: roughly 53% of it was Node's
 * own module loader — `esm/utils` 14.3%, `cjs-module-lexer` 12.3%, `get_format` 7.9% — resolving and
 * parsing files the command had no intention of using. Zod was 2.3% and citty imported in 6 ms, so it was
 * never the command tree or the schemas. It was two leaves: `miniflare`, reached through
 * `migrations/run.ts`, and the Cloudflare REST SDK, reached through anything that names
 * `CloudflareClients`. Importing `dist/commands/add.js` alone cost 755 ms of the 867 (#482).
 *
 * Moving both behind `await import(...)` at the point of use took `pithy add --help` from 786 ms to
 * 255 ms, `doctor --help` from 813 to 263, `deploy --help` from 816 to 206, `migrate --help` from 771 to
 * 326, and the root `pithy --help` — which resolves every command's description and so loads all of them
 * — from 1076 to 668. `pithy --version` was 43 ms before and after: it answers above the first dynamic
 * import and was never part of this. Timed as the minimum of twelve warm runs, before and after
 * interleaved on one machine so load fell on both sides equally.
 *
 * **A gate rather than a note, because this is a property that decays one commit at a time.** Every one
 * of these imports was correct when it was written: a command that provisions D1 does need the REST
 * client, and writing `import { CloudflareClients }` at the top is what everything else in the file
 * does. Nothing about the next such line will look wrong either, and the cost it adds is invisible —
 * no test fails, no output changes, the command is just a third of a second slower for everybody who
 * runs a different one. So the rule is checked instead of remembered.
 *
 * **The graph is derived, never listed.** A list of files that may not import `miniflare` would be
 * satisfied by a new file that does, imported from an old one that does not. What is asserted here is
 * the transitive static graph from each command module, followed across package boundaries into
 * `packages/<name>/src`, so an edge added three modules away fails in the command that inherits it.
 */

/** `packages/cli/src/ci` → the repository root. */
const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..", "..");

/** The CLI's own source — where every entry this gate walks from lives. */
const CLI_SRC = join(REPO_ROOT, "packages", "cli", "src");

/**
 * The modules a command may not reach at import time, and what each one costs.
 *
 * Both are **external packages**, named as the bare specifier a `package.json` declares, because that is
 * the boundary the cost sits behind — the module inside `@pithy-sh/cloudflare` that pulls the SDK is
 * cheap on its own, and moving the rule to it would name a symptom rather than the weight.
 *
 * Each cost is the import alone, measured with `node -e "const s = performance.now();
 * import('<name>').then(() => console.log(performance.now() - s))"`, best of three. The two figures agree
 * with the `--cpu-prof` on the issue, which attributed 287 ms to `miniflare` and 364 ms to
 * `@pithy-sh/cloudflare/src/client/clients` — the extra 60 there is the 26 managers that module
 * aggregates on top of the SDK underneath them.
 */
const HEAVY: Record<string, string> = {
  miniflare:
    "~290 ms to import: a whole workerd-backed local runtime. Only `pithy migrate --env dev`, `pithy seed --env dev` and the local dev-secrets store ever start one, and each does it inside the function that needs it.",
  cloudflare:
    "~300 ms to import: the official Cloudflare SDK, constructed by `@pithy-sh/cloudflare/src/client/manager`, which every REST manager extends. Anything naming `CloudflareClients` as a value pays it, so the CLI builds one through `cloudflare/clients.ts` instead.",
};

/**
 * The reach that is still there, why, and what it would take to remove it. Checked in both directions:
 * an entry that reaches a heavy module without a line here fails, and a line here whose reach has been
 * fixed fails too, so the record cannot quietly outlive the thing it records.
 *
 * The surviving entry doubles as this gate's live positive control. If the extractor below ever stops
 * seeing static imports — a regex that no longer matches, a resolver that no longer crosses into
 * `packages/*` — this expectation goes missing and the suite says so, rather than passing on a graph it
 * failed to build.
 */
const KNOWN: Record<string, string> = {
  "packages/cli/src/commands/token.ts → cloudflare":
    '`TOKEN_STORES` is interpolated into the `--store` flag\'s description, which citty evaluates when the module is imported, so the module that exports it cannot be loaded later. It is `@pithy-sh/cloudflare/src/tokens/profiles`, a pure policy module whose only weight is one value import of `accountResource` from `tokens/accountTokensManager` — three lines that build `{ "com.cloudflare.api.account.<id>": "*" }` and have nothing to do with the SDK the manager extends. Removing it means moving that helper to `tokens/permissions`, which is a published export path of `@pithy-sh/cloudflare` and belongs to its own change rather than to #482. `pithy token --help` still improved — 909 ms to 439 — because it no longer loads the 26 managers `CloudflareClients` aggregates, only the SDK underneath them. Every other command is clear.',
};

/**
 * An import statement the runtime evaluates, at column 0.
 *
 * `[\w$\s{},*]` is exactly what an import clause may hold — `{ a as b }`, `* as ns`, `type`, a default
 * binding — and nothing else. It matters that `=`, `(` and `.` are excluded: a looser class ran the lazy
 * span from `export const BindingSpec = z` in `core/src/capability/bindings.ts` down forty lines into a
 * `.describe()` that quotes an `export … from "<classModule>"`, and read the quotation as an edge.
 *
 * Column 0 rather than "anywhere", because an ESM import statement is always top-level and Biome always
 * writes it flush left, while quoted source is indented. What survives that is a template literal holding
 * a whole file — `project/workerScaffold.ts` writes a Worker entry that way — and such a match is
 * **deliberately kept**: it names a specifier that resolves to nothing today, and a scaffolder that ever
 * embedded `from "miniflare"` should be looked at by a human rather than skipped. A tripwire that
 * over-reports says so with a file name; one that under-reports says nothing at all.
 */
const FROM_IMPORT = /(?:^|\n)(import|export)\s([\w$\s{},*]*)from\s*["']([^"']+)["']/g;

/** A bare side-effect import — `import "./polyfill";` — which has no clause to inspect. */
const SIDE_EFFECT_IMPORT = /(?:^|\n)import\s*["']([^"']+)["']/g;

/**
 * Every specifier `source` loads when it is imported.
 *
 * **`import type` is out and inline `type` is in**, and that asymmetry is the rule TypeScript actually
 * emits under `verbatimModuleSyntax`: `import type { X } from "m"` disappears, while
 * `import { type X, y } from "m"` keeps the statement — and `import { type X } from "m"` keeps it as a
 * bare `import "m"`. So a signature may name `CloudflareClients` freely, and that is what lets every seam
 * in the CLI keep its types while none of them load the SDK.
 *
 * **`await import(...)` is out** by construction: the regexes anchor at column 0 after a newline, and a
 * dynamic import is always preceded by an assignment or an `await` on the same line. That is the whole
 * distinction this gate exists to make, so {@link describe}'s planted cases below prove it rather than
 * assume it.
 *
 * Comments are blanked first, through the one stripper (`ci/commentStripping.test.ts`): a docblock here
 * quotes the imports it forbids.
 */
function runtimeImports(source: string): string[] {
  const code = blankComments(source);
  const found: string[] = [];
  for (const match of code.matchAll(FROM_IMPORT)) {
    // `import type …` / `export type …` are erased whole; an inline `type` inside the braces is not.
    if (/^\s*type\s/.test(match[2] ?? "")) continue;
    found.push(match[3] ?? "");
  }
  for (const match of code.matchAll(SIDE_EFFECT_IMPORT)) found.push(match[1] ?? "");
  return found;
}

/** What a specifier turned out to be: a file in this repository, or a package outside it. */
type Resolved = { readonly kind: "file"; readonly path: string } | { readonly kind: "package"; readonly name: string };

/**
 * Resolve a specifier the way the graph needs it: to a source file when it is one of ours, to the
 * package name when it is not.
 *
 * `@pithy-sh/<pkg>/<path>` maps to `packages/<pkg>/<path>`, which is what makes this graph cross package
 * boundaries — the whole point, since the cost being chased sits two packages away from the command that
 * pays it. A bare specifier is reduced to its package name (`cloudflare/resources/accounts` →
 * `cloudflare`) so {@link HEAVY} can be keyed the way a manifest is.
 */
function resolveSpecifier(specifier: string, fromFile: string): Resolved | null {
  if (specifier.startsWith("node:")) return null;
  if (specifier.startsWith(".")) {
    const base = resolve(dirname(fromFile), specifier);
    for (const candidate of [`${base}.ts`, join(base, "index.ts")]) {
      if (existsSync(candidate)) return { kind: "file", path: candidate };
    }
    return null;
  }
  const workspace = /^@pithy-sh\/([^/]+)\/(.+)$/.exec(specifier);
  if (workspace) {
    const base = join(REPO_ROOT, "packages", workspace[1] ?? "", workspace[2] ?? "");
    for (const candidate of [`${base}.ts`, join(base, "index.ts")]) {
      if (existsSync(candidate)) return { kind: "file", path: candidate };
    }
    return null;
  }
  const scoped = /^(@[^/]+\/[^/]+)/.exec(specifier);
  return { kind: "package", name: scoped ? (scoped[1] ?? specifier) : (specifier.split("/")[0] ?? specifier) };
}

/** One walk's answer: which heavy packages an entry reaches, and the shortest chain of modules to each. */
interface Reach {
  /** Heavy package name → the module chain from the entry to the file that imports it. */
  readonly paths: Map<string, string[]>;
  /** Every module the walk visited — the graph's size, for the vacuity floor. */
  readonly visited: Set<string>;
}

/** Breadth-first from `entry`, so the chain a failure prints is the shortest one a reader has to follow. */
function reachFrom(entry: string): Reach {
  const paths = new Map<string, string[]>();
  const visited = new Set<string>();
  const queue: Array<{ file: string; chain: string[] }> = [{ file: entry, chain: [entry] }];
  while (queue.length > 0) {
    const step = queue.shift();
    if (!step || visited.has(step.file)) continue;
    visited.add(step.file);
    const text = readSource(step.file);
    if (text === null) continue;
    for (const specifier of runtimeImports(text)) {
      const resolved = resolveSpecifier(specifier, step.file);
      if (!resolved) continue;
      if (resolved.kind === "package") {
        if (resolved.name in HEAVY && !paths.has(resolved.name)) paths.set(resolved.name, step.chain);
        continue;
      }
      if (!visited.has(resolved.path)) queue.push({ file: resolved.path, chain: [...step.chain, resolved.path] });
    }
  }
  return { paths, visited };
}

/** Repo-relative and POSIX-separated, so a failure reads the same on every machine. */
function named(path: string): string {
  return relative(REPO_ROOT, path).split(sep).join("/");
}

/**
 * Every entry point a person reaches by typing a command: the bin, the root command tree, and each
 * command module. Discovered rather than listed — a new command is covered the day it lands.
 */
const ENTRIES = [join(CLI_SRC, "bin.ts"), join(CLI_SRC, "main.ts"), ...sourcePaths(join(CLI_SRC, "commands"))];

describe("no command loads a network client or a local runtime to render its help", () => {
  const found = new Map<string, string[]>();
  const visited = new Set<string>();
  for (const entry of ENTRIES) {
    const reach = reachFrom(entry);
    for (const module of reach.visited) visited.add(module);
    for (const [heavy, chain] of reach.paths) found.set(`${named(entry)} → ${heavy}`, chain.map(named));
  }

  test("every heavy import a command still reaches is written down, with the reason it is still there", () => {
    // The chain is in the failure message, not just the entry: the edge is usually three modules away
    // from the command that pays for it, and naming only the command sends the reader hunting.
    const unrecorded = [...found].filter(([key]) => !(key in KNOWN));
    expect(
      unrecorded.map(([key, chain]) => `${key}\n    ${chain.join("\n    ")}`),
      "A command's static import graph reaches a module that costs hundreds of milliseconds to load, and " +
        "it is loaded before the command decides whether it needs it. Move it to the point of use — " +
        `const { X } = await import("…") inside the function — or, if it genuinely cannot move, add it to ` +
        "KNOWN in this file with the reason. See #482 and this file's docblock.",
    ).toEqual([]);
  });

  test("a recorded exception that has been fixed is removed rather than left standing", () => {
    // The other direction, and the reason it is here: an exception nobody revisits stops describing the
    // code and starts excusing it. This also proves the walk still works — see KNOWN's docblock.
    const stale = Object.keys(KNOWN).filter((key) => !found.has(key));
    expect(stale, "This reach no longer exists. Delete its entry from KNOWN.").toEqual([]);
  });

  test("the walk actually built a graph", () => {
    // The vacuity floor. Every assertion above passes trivially against an extraction that finds
    // nothing, and the ways to find nothing are cheap: a regex that stops matching, a resolver that
    // stops crossing into `packages/*`, a directory that moved. Each number is well under what the tree
    // holds today — a floor, not a pin, so ordinary growth never touches it.
    expect(ENTRIES.length).toBeGreaterThan(20);
    expect(visited.size).toBeGreaterThan(250);
    // Crossing a package boundary is the part most easily lost, so it is asserted by name.
    expect([...visited].some((file) => named(file).startsWith("packages/core/src/"))).toBe(true);
    expect([...visited].some((file) => named(file).startsWith("packages/cloudflare/src/"))).toBe(true);
  });
});

describe("runtimeImports — what counts as loading a module", () => {
  test("a static import is an edge", () => {
    expect(runtimeImports('import { Miniflare } from "miniflare";\n')).toEqual(["miniflare"]);
    expect(runtimeImports('import config from "./config";\n')).toEqual(["./config"]);
    expect(runtimeImports('import * as fs from "node:fs";\n')).toEqual(["node:fs"]);
    expect(runtimeImports('import "./register";\n')).toEqual(["./register"]);
    expect(runtimeImports('export { a } from "./a";\n')).toEqual(["./a"]);
    expect(runtimeImports('export * from "./b";\n')).toEqual(["./b"]);
  });

  test("a multi-line import clause is one edge, not none", () => {
    expect(runtimeImports('import {\n  one,\n  two as three,\n} from "@pithy-sh/core/src/x";\n')).toEqual([
      "@pithy-sh/core/src/x",
    ]);
  });

  test("a dynamic import is not an edge — this is the whole distinction", () => {
    expect(runtimeImports('const { Miniflare } = await import("miniflare");\n')).toEqual([]);
    expect(runtimeImports('  const m = await import("miniflare");\n')).toEqual([]);
    expect(runtimeImports('export const load = () => import("miniflare");\n')).toEqual([]);
  });

  test("an erased type import is not an edge, and an inline one still is", () => {
    // `verbatimModuleSyntax`: the first disappears, the second emits `import {} from "m"` and loads it.
    expect(runtimeImports('import type { CloudflareClients } from "m";\n')).toEqual([]);
    expect(runtimeImports('export type { A } from "m";\n')).toEqual([]);
    expect(runtimeImports('import { type A, b } from "m";\n')).toEqual(["m"]);
  });

  test("an import quoted in prose is not an edge", () => {
    // Every docblock in this repository quotes the thing its gate forbids, including this one's.
    expect(runtimeImports('// import { Miniflare } from "miniflare";\nimport { a } from "./a";\n')).toEqual(["./a"]);
    expect(runtimeImports('/**\n * import { Miniflare } from "miniflare";\n */\nimport { a } from "./a";\n')).toEqual([
      "./a",
    ]);
  });

  test("a lazy span cannot run out of a declaration into a quoted specifier", () => {
    // The measured false positive: `export const X = z` … forty lines … `.describe('… from "<y>"')`.
    const planted = "export const X = z\n  .object({})\n  .describe('writes `export { A } from \"<y>\";`');\n";
    expect(runtimeImports(planted)).toEqual([]);
  });
});

describe("resolveSpecifier — how the graph crosses a package boundary", () => {
  const anchor = join(CLI_SRC, "commands", "add.ts");

  test("a workspace specifier resolves to the other package's source file", () => {
    const resolved = resolveSpecifier("@pithy-sh/cloudflare/src/client/manager", anchor);
    expect(resolved).toEqual({
      kind: "file",
      path: join(REPO_ROOT, "packages", "cloudflare", "src", "client", "manager.ts"),
    });
  });

  test("the file it resolves to is the one that holds the weight", () => {
    // Not a tautology: it is the fact the whole gate rests on. `client/manager` is what every REST
    // manager extends, and its static `import { Cloudflare } from "cloudflare"` is the ~300 ms. If this
    // ever stops being true the rule above is guarding a module that no longer costs anything.
    const resolved = resolveSpecifier("@pithy-sh/cloudflare/src/client/manager", anchor);
    expect(resolved?.kind).toBe("file");
    const text = resolved?.kind === "file" ? readSource(resolved.path) : null;
    expect(text).not.toBeNull();
    expect(runtimeImports(text ?? "")).toContain("cloudflare");
  });

  test("an external specifier reduces to the package name a manifest declares", () => {
    expect(resolveSpecifier("cloudflare/resources/accounts", anchor)).toEqual({ kind: "package", name: "cloudflare" });
    expect(resolveSpecifier("miniflare", anchor)).toEqual({ kind: "package", name: "miniflare" });
    expect(resolveSpecifier("@clack/prompts", anchor)).toEqual({ kind: "package", name: "@clack/prompts" });
  });

  test("a builtin is not a module this graph walks", () => {
    expect(resolveSpecifier("node:fs", anchor)).toBeNull();
  });
});
