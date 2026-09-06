// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";

/**
 * What keeps this package's turbo cache key from lying about what it covers.
 *
 * `peerRange.ts` compiles `@pithy-sh/vite`'s public return type against three copies of Vite the kit
 * does not resolve, and `resolution.test.ts` keeps those three honest. Both are gates about **another
 * package**, and turbo's default inputs for a task are the files in its own — so for as long as this
 * fixture existed it replayed while its subject moved. Reproduced with the branch's cache warm:
 * `packages/vite/src` restored to the state that produces the dashboard's `TS2321` hit
 * `9340e74d2b125457`, the same hash as the fixed tree, and `bun run typecheck` reported
 * `24 successful, 24 total`. The gate did not run and the run was green.
 *
 * `turbo.jsonc` names the kit's files now. **A hand-maintained list of what a program reads is the same
 * defect one level up**, which is what this file is for: the expected set is derived from the compile
 * and from the cross-package-read register, never read out of the declaration it checks, and the
 * declaration is asked of turbo rather than parsed — `--dry=json` reports the file list actually
 * hashed, which is the only answer that matters. A glob that looks configured and matches nothing is
 * the outcome `pithy-sh/dashboard`'s `turbo.jsonc` records three separate spellings of.
 *
 * **No path here is written with parent segments, and that is load-bearing.**
 * `.github/scripts/crossPackageReads.ts` finds a test's reads outside its own package by resolving runs
 * of string literals that begin by climbing. This file runs `turbo` at the repository root, so spelling
 * that root as a climb would register a read of the whole tree — and then the coverage assertion below
 * would demand every file in the repository be a hashed input of this package. `dirname` says the same
 * thing and is not a literal.
 */

const run = promisify(execFile);

/** This file's own directory. */
const HERE = dirname(fileURLToPath(import.meta.url));

/** `tooling/vite-adopter`. */
const PACKAGE_DIR = dirname(HERE);

/** The repository — `tooling/vite-adopter` climbed twice. See the note above on why not as a literal. */
const REPO_ROOT = dirname(dirname(PACKAGE_DIR));

/** This package's own TypeScript, which is the one that resolves the kit through the workspace link. */
const TSC = join(PACKAGE_DIR, "node_modules", ".bin", "tsc");

/** The workspace's turbo. Asked what it hashes, never told. */
const TURBO = join(REPO_ROOT, "node_modules", ".bin", "turbo");

/** The register CI plans from. Reused rather than restated — a second derivation is a second thing to drift. */
const READS = join(REPO_ROOT, ".github", "scripts", "crossPackageReads.ts");

/** This package, as turbo names it. */
const PACKAGE_NAME = "@pithy-sh/vite-adopter";

/** Every task this package defines that turbo caches. `clean` and `reset` declare `cache: false`. */
const TASKS = ["typecheck", "test", "test:node"] as const;

/** Directories that are never anyone's input: installed code, build output, turbo's own state. */
const NEVER_INPUT = new Set(["node_modules", "dist", ".turbo", ".git"]);

/** A path relative to the repo root, in POSIX form. */
function fromRoot(path: string): string {
  return relative(REPO_ROOT, path).split(sep).join("/");
}

/** Whether `path` is inside `dir`. */
function inside(dir: string, path: string): boolean {
  return !relative(dir, path).startsWith("..");
}

/**
 * Every file inside the repository, outside this package and outside `node_modules`, that the fixture's
 * TypeScript program opens — what an adopter's checker walks when it reads `pithy()`.
 *
 * `tsc --listFiles` rather than a hand-rolled import walk: the question is which files the compiler
 * opens, and the compiler is the only thing that knows. A failing compile still lists them, and the
 * verdict belongs to `typecheck` — reporting it here too would name the same defect twice.
 *
 * **Since #476 these are declarations, not source.** `@pithy-sh/vite` publishes `dist/*.d.ts` and the
 * fixture resolves them, so the list is two files rather than the fifty-four it used to be — the kit's
 * whole reach through `@pithy-sh/core` is summarized into `pithy(): PithyPlugin` and never opened. That
 * is the adopter's real surface and the fixture is more honest for compiling it, but it moves the
 * coverage question: a `.d.ts` under `dist` is an **output**, so it cannot be an input of anything, and
 * requiring it to be hashed would be requiring turbo to hash a build artifact. {@link behind} answers
 * the question this list can no longer answer on its own.
 */
async function opened(): Promise<string[]> {
  let stdout: string;
  try {
    ({ stdout } = await run(TSC, ["-p", "tsconfig.json", "--noEmit", "--listFiles"], {
      cwd: PACKAGE_DIR,
      maxBuffer: 64 * 1024 * 1024,
    }));
  } catch (cause) {
    stdout = (cause as { stdout?: string }).stdout ?? "";
  }
  const files = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((path) => !path.split(sep).includes("node_modules"))
    .filter((path) => inside(REPO_ROOT, path) && !inside(PACKAGE_DIR, path))
    .map(fromRoot);
  return [...new Set(files)].sort();
}

/** Where the workspace's packages live, by the name their manifest declares. */
function packageDirs(): Map<string, string> {
  const dirs = new Map<string, string>();
  for (const group of ["packages", "tooling"]) {
    const root = join(REPO_ROOT, group);
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifest = join(root, entry.name, "package.json");
      if (!existsSync(manifest)) continue;
      const { name } = JSON.parse(readFileSync(manifest, "utf8")) as { name?: string };
      if (name !== undefined) dirs.set(name, fromRoot(join(root, entry.name)));
    }
  }
  return dirs;
}

/**
 * The source a set of opened files is built from — the inputs that decide their bytes.
 *
 * A file the fixture opens outside `dist` stands for itself: nothing produces a `package.json`, so the
 * only way to cover a manifest is to hash it. A file **under** `packages/<name>/dist` is the output of
 * that package's build, so what has to be hashed is everything the build reads: the package's own
 * source, and then the same question asked of every kit package it depends on. `@pithy-sh/vite`'s
 * declarations are a function of `packages/vite/src` and, through its dependency on `@pithy-sh/core`,
 * of `packages/core/src` — which is exactly what `turbo.jsonc` names for this fixture, derived here
 * rather than copied from there.
 *
 * The closure is over **whole source trees**, not the subset a compile happens to reach. That
 * over-approximates, and deliberately in the safe direction: a coverage gate that demands too much
 * fails on an input somebody forgot, while one that demands the compiled subset would go quiet the day
 * a new module joined the graph. It is also the shape a glob can express, and the declaration being
 * checked is written in globs.
 *
 * Directories rather than manifest name arithmetic: `@pithy-sh/vite` lives in `packages/vite` because
 * its manifest says so, not because the name can be sliced. `@pithy-sh/release` does not, and a rule
 * that guesses is a rule that is wrong once.
 */
function behind(files: readonly string[]): string[] {
  const dirs = packageDirs();
  const byDir = new Map([...dirs].map(([name, dir]) => [dir, name]));

  const pending: string[] = [];
  const required = new Set<string>();
  for (const file of files) {
    const owner = [...byDir.keys()].find((dir) => file.startsWith(`${dir}/`));
    if (owner !== undefined && file.startsWith(`${owner}/dist/`)) pending.push(byDir.get(owner) as string);
    else required.add(file);
  }

  const seen = new Set<string>();
  while (pending.length > 0) {
    const name = pending.pop() as string;
    if (seen.has(name)) continue;
    seen.add(name);
    const dir = dirs.get(name);
    if (dir === undefined) throw new Error(`no workspace directory for ${name}`);
    for (const source of expand(`${dir}/src`)) required.add(source);
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, dir, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      if (dirs.has(dependency)) pending.push(dependency);
    }
  }

  return [...required].sort();
}

/** One task, as turbo plans it. */
type Plan = { tasks: { taskId: string; inputs: Record<string, string> }[] };

/**
 * The files turbo hashes for one of this package's tasks, repo-relative.
 *
 * The keys `--dry=json` returns are relative to the package directory, so a kit file arrives already
 * spelled as a climb — which is why they are resolved before being compared, and why nothing in this
 * file has to know how turbo spells a root-relative glob.
 */
async function hashed(task: string): Promise<Set<string>> {
  const { stdout } = await run(TURBO, ["run", task, `--filter=${PACKAGE_NAME}`, "--dry=json"], {
    cwd: REPO_ROOT,
    maxBuffer: 64 * 1024 * 1024,
  });
  const plan = JSON.parse(stdout) as Plan;
  const planned = plan.tasks.find((entry) => entry.taskId === `${PACKAGE_NAME}#${task}`);
  if (planned === undefined) throw new Error(`turbo planned no ${task} for ${PACKAGE_NAME}`);
  return new Set(Object.keys(planned.inputs).map((key) => fromRoot(resolve(PACKAGE_DIR, key))));
}

/** Every path the register says a test in this package reads from outside it. */
async function registered(): Promise<string[]> {
  const { stdout } = await run("bun", [READS, "--json"], { cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 });
  const all = JSON.parse(stdout) as { package: string; target: string }[];
  return [...new Set(all.filter((read) => read.package === PACKAGE_NAME).map((read) => read.target))].sort();
}

/**
 * A read target as the files it stands for: itself when it is a file, everything under it when it is a
 * directory. The register over-approximates on purpose — a test that walks `packages/` records
 * `packages` — and an input that covers one file of a tree a test reads whole is not coverage.
 */
function expand(target: string): string[] {
  const absolute = join(REPO_ROOT, target);
  if (!statSync(absolute).isDirectory()) return [target];
  const found: string[] = [];
  const stack = [absolute];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (NEVER_INPUT.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (entry.isFile()) found.push(fromRoot(path));
    }
  }
  return found.sort();
}

describe("this fixture's cache key covers what this fixture reads", () => {
  test("everything behind what the compile opens is hashed, by all three tasks", async () => {
    const files = await opened();

    // The vacuity floor for the compile itself: an empty list satisfies every containment below
    // without touching anything. These two declarations are the subject — `pithy()` and `pithyTest()`
    // are declared in them — and they are the whole of what an adopter's checker reads.
    expect(files).toContain("packages/vite/dist/plugin.d.ts");
    expect(files).toContain("packages/vite/dist/testPlugin.d.ts");

    const required = behind(files);

    // The floor again, one level down, and this is the assertion that matters most. `behind` resolving
    // to nothing would pass every containment below, so it is pinned to the two things it must reach:
    // the source those declarations are emitted from, and the source of the package that source
    // imports. The count is the reach through `@pithy-sh/core`, which the declarations summarize away
    // and the build still walks.
    expect(required).toContain("packages/vite/src/plugin.ts");
    expect(required).toContain("packages/core/src/capability/client.ts");
    expect(required.length).toBeGreaterThan(10);

    for (const task of TASKS) {
      const key = await hashed(task);
      expect(
        required.filter((file) => !key.has(file)),
        `not in the key for ${task}`,
      ).toEqual([]);
    }
  });

  test("every cross-package read the register finds here is hashed, by all three tasks", async () => {
    const targets = await registered();

    // The floor again. `resolution.test.ts` reads the peer range off the kit's manifest, and that read
    // is the one a source-only input list misses: widening `vite` to a fourth major is a manifest edit
    // and nothing else, and it is exactly the edit this fixture exists to refuse.
    expect(targets).toContain("packages/vite/package.json");

    const files = targets.flatMap(expand);
    for (const task of TASKS) {
      const key = await hashed(task);
      expect(
        files.filter((file) => !key.has(file)),
        `not in the key for ${task}`,
      ).toEqual([]);
    }
  });

  test("the two answers nothing in the tree can derive are hashed anyway", async () => {
    // `bun.lock` decides which copy of Vite each pin resolved to. `resolution.test.ts` asserts about
    // those copies by walking `node_modules`, which no static reader of this tree can see, so the read
    // is real and invisible: a `bun update` that moved the kit's own Vite would change what all three
    // pins are compared against with neither manifest touched.
    //
    // `turbo.jsonc` is the declaration the other two tests check. A task's hash covers its own
    // definition and no other, so without this the way to silence this file is to edit the file it
    // guards.
    for (const task of TASKS) {
      const key = await hashed(task);
      expect(key, `bun.lock is not in the key for ${task}`).toContain("bun.lock");
      expect(key, `turbo.jsonc is not in the key for ${task}`).toContain("turbo.jsonc");
    }
  });

  test("the three tasks are keyed identically", async () => {
    // Not tidiness. The guard above runs in the test task and derives its answer from the compile the
    // typecheck task runs, so a test task keyed more narrowly than the compile it checks would replay a
    // green guard over a list that had gone stale. Equal sets is the cheapest way to say that and the
    // only one a reader can check at a glance.
    const [first, ...rest] = await Promise.all(TASKS.map(hashed));
    const expected = [...(first as Set<string>)].sort();
    expect(expected.length).toBeGreaterThan(10);
    for (const [index, key] of rest.entries()) {
      expect([...key].sort(), `${TASKS[index + 1]} is keyed differently`).toEqual(expected);
    }
  });
});
