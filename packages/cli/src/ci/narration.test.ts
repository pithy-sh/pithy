// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { basename, relative, resolve } from "node:path";
import { blankComments } from "@pithy-sh/core/src/text/comments";
import { describe, expect, test } from "vitest";
import { isTestFile, readSource, sourcePaths } from "./sourceFiles";

/**
 * **A command that spawns captured subprocesses narrates what it is working on, and `--json` emits
 * exactly one line.**
 *
 * That is the invariant, and it is stated over a *set this file discovers* rather than over the three
 * commands #578 was reported against. The reason is the report's own finding: #531 built the narration
 * for `pithy provision`, named it for provisioning, and put it in `provision/`, so nothing about it said
 * *this is how a long command narrates itself* — and the next long command, `deploy`, printed nothing at
 * all for minutes while it shipped Workers. A gate written against `deploy`, `email provision` and
 * `secrets provision` by name would leave the fourth command to rediscover this a third time.
 *
 * **Two halves, because silence has two causes.**
 *
 * 1. *The producer.* Every module that spawns a captured subprocess must raise a step for the unit of
 *    work it is spawning for. The population is every `runWrangler(` call site in the tree — that is
 *    what *captured subprocess* means here, and `project/wrangler.ts` says so in its own docblock: the
 *    child's output is collected and summarized, never streamed, which is the deliberate decision that
 *    removed the only evidence a run was alive.
 * 2. *The command.* A step reaches a terminal only inside a narrated span, and every command body
 *    already goes through one wrapper — `withErrorReporting`, which takes `json` and nothing else. So a
 *    command that reaches a narrating producer must route its body through it, which is also where the
 *    `--json` half is decided: `commandProgress({ json: true })` is no sink, so a machine-readable run
 *    writes the one line it always did. `terminal/progress.test.ts` holds that half at runtime.
 *
 * **The reach is the point, and it is checked rather than asserted.** The needle is the spawn, not the
 * command name: a module that shells wrangler for the first time next year is in the population the day
 * it is written, and a command that calls a narrating producer from a bare `run:` fails here. Both were
 * planted and both went red before this was committed.
 */

/** The repo root, four levels up from `packages/cli/src/ci`. */
const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..", "..");

/** The CLI's own source — every module that could spawn anything. */
const CLI_SRC = resolve(REPO_ROOT, "packages", "cli", "src");

/** Where a command lives. Nothing outside it defines a `pithy <command>`. */
const COMMANDS = resolve(CLI_SRC, "commands");

/** The captured-subprocess spawn, wherever it is called from. Its own module is where it is defined. */
const SPAWN = /\brunWrangler\s*\(/;

/** Raising a step — the producer half of the seam, in `terminal/progress.ts`. */
const STEP = /\bstartStep\s*\(/;

/** The one wrapper that installs a narrated span, and the only thing that consults `--json` for it. */
const WRAP = /\bwithErrorReporting\s*\(/;

/** A source module in the CLI, with prose blanked so a docblock naming a spawn is not read as one. */
interface Module {
  /** Path from the repo root, for a failure message somebody can open. */
  readonly path: string;
  /** Absolute path, the key the import graph is built on. */
  readonly file: string;
  /** Its code, comments blanked. */
  readonly code: string;
}

/** Every shipped module under `packages/cli/src`, comments blanked. */
function modules(): Map<string, Module> {
  const found = new Map<string, Module>();
  for (const file of sourcePaths(CLI_SRC)) {
    if (isTestFile(basename(file))) continue;
    const source = readSource(file);
    if (source === null) continue;
    found.set(file, { file, path: relative(REPO_ROOT, file), code: blankComments(source) });
  }
  return found;
}

/**
 * The modules one module imports for their *values*, resolved to files in this tree.
 *
 * `import type` edges are dropped: a type cannot spawn anything, and keeping them is what dragged
 * `pithy doctor` into a population about deploying — it reads one pure helper out of a provisioner and
 * deploys nothing.
 */
function valueImports(module: Module, all: Map<string, Module>): string[] {
  const edges: string[] = [];
  for (const match of module.code.matchAll(/import\s+(type\s+)?[\s\S]*?from\s+"([^"]+)"/g)) {
    if (match[1]) continue;
    const spec = match[2] as string;
    if (!spec.startsWith(".")) continue;
    const base = resolve(module.file, "..", spec);
    for (const candidate of [`${base}.ts`, resolve(base, "index.ts")]) {
      if (all.has(candidate)) {
        edges.push(candidate);
        break;
      }
    }
  }
  return edges;
}

/** Every module reachable from `entry` through value imports, `entry` included. */
function reachable(entry: string, all: Map<string, Module>): Set<string> {
  const seen = new Set<string>([entry]);
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop() as string;
    const module = all.get(file);
    if (!module) continue;
    for (const edge of valueImports(module, all)) {
      if (seen.has(edge)) continue;
      seen.add(edge);
      stack.push(edge);
    }
  }
  return seen;
}

/** Every module that spawns a captured subprocess — the sites the rule is about. */
function spawnSites(all: Map<string, Module>): Module[] {
  return [...all.values()].filter((module) => SPAWN.test(module.code));
}

/** Every `pithy <command>` module. */
function commands(all: Map<string, Module>): Module[] {
  return [...all.values()].filter((module) => module.file.startsWith(`${COMMANDS}/`));
}

describe("a long command narrates itself", () => {
  test("the walk finds the spawn sites, so this measures something", () => {
    const all = modules();
    // Not `> 0`, which is the shape of a guard rather than an assertion. Two sites ship a Worker today:
    // the adopter's, and the kit's. A third would join the population on the day it is written.
    expect(
      spawnSites(all)
        .map((module) => module.path)
        .sort(),
    ).toEqual([
      "packages/cli/src/capabilities/hostDeploy.ts",
      "packages/cli/src/project/deploy.ts",
      "packages/cli/src/project/wrangler.ts",
    ]);
  });

  /**
   * The producer half. A module that shells a captured child and says nothing is the defect #578
   * reports, whatever command happens to call it.
   */
  test("every module that spawns a captured subprocess raises a step for it", () => {
    const all = modules();
    const silent = spawnSites(all)
      // The spawner itself. It runs one child for whoever asked, and the unit of work — which Worker,
      // which capability — is known one frame up, not here.
      .filter((module) => module.path !== "packages/cli/src/project/wrangler.ts")
      .filter((module) => !STEP.test(module.code))
      .map((module) => module.path);

    expect(silent).toEqual([]);
  });

  /**
   * The command half. A step raised inside a producer reaches a terminal only inside a narrated span,
   * and `withErrorReporting` is the only thing in this CLI that opens one.
   */
  test("every command that can reach a narrating producer opens a narrated span", () => {
    const all = modules();
    const narrating = new Set(
      spawnSites(all)
        .filter((module) => STEP.test(module.code))
        .map((module) => module.file),
    );
    const enrolled = commands(all).filter((command) =>
      [...reachable(command.file, all)].some((file) => narrating.has(file)),
    );

    // Anti-vacuity, and it is exact about the floor rather than about the membership: `deploy` is the
    // command #578 was reported against, and the kit's Workers are deployed by every capability's
    // `provision` too. A population that had collapsed to one would pass a set test and mean nothing.
    expect(enrolled.length).toBeGreaterThanOrEqual(8);
    expect(enrolled.map((command) => basename(command.file))).toContain("deploy.ts");

    expect(enrolled.filter((command) => !WRAP.test(command.code)).map((command) => command.path)).toEqual([]);
  });
});
