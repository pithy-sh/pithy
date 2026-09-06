// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";

/**
 * What keeps this package's turbo cache key from lying about what it covers.
 *
 * Everything in this package is a gate about **other packages**. `responses.ts` compiles every
 * capability's response schemas under a browser's lib; `schemas.ts` does the same for every request
 * schema and `client.ts` for every control-plane scope; `browserSurface.test.ts` walks `packages/` to
 * derive what those fixtures must name. Turbo's default inputs for a task are the files in its own
 * package — so for as long as this package existed it replayed while its whole subject moved.
 *
 * Reproduced with the branch's cache warm, by planting the #419 chain back into `packages/support`:
 * `turbo run test --filter=@pithy-sh/browser-scopes` printed `Cached: 1 cached` and
 * `Time: 16ms >>> FULL TURBO`, replaying a `20 passed` from before the planted file existed. Forced, the
 * same tree fails. The gate did not run and the run was green.
 *
 * `turbo.jsonc` names `packages/**` now. **A hand-maintained list of what a gate reads is the same defect
 * one level up**, which is what this file is for: the expected set is derived from the cross-package-read
 * register and from git, never read out of the declaration it checks, and the declaration is asked of
 * turbo rather than parsed — `--dry=json` reports the file list actually hashed, which is the only answer
 * that matters. A glob that looks configured and matches nothing is the outcome `pithy-sh/dashboard`'s
 * `turbo.jsonc` records three separate spellings of.
 *
 * **Git is the second derivation, and it works from both sides.** Turbo does not apply `.gitignore` to an
 * explicit `inputs` glob, so a bare `packages/**` hashed 169 files nobody wrote — `node_modules/`,
 * `dist/`, and each package's `.turbo/turbo-test.log`, **which the hashed task writes itself**. A key
 * containing a task's own output is a key that changes after every run, which is not a false pass but is
 * a cache that can never hit. The negations in `turbo.jsonc` remove exactly those. So the glob is checked
 * twice over: every file git *tracks* under `packages/` is hashed, and nothing git *ignores* is.
 *
 * Equality between the key and the tracked set was tried first and is wrong (Jim, 2026-08-21). It is
 * true of a clean checkout and false of every working tree with a new file in it: a module somebody has
 * written and not yet committed is untracked, unignored, and a real input, and the assertion turned red
 * on the very plant used to prove the gate fires. Tracked-is-hashed catches a narrowed glob;
 * ignored-is-not-hashed catches a re-admitted artifact; neither has an opinion about work in progress.
 *
 * **No path here is written with parent segments, and that is load-bearing.**
 * `.github/scripts/crossPackageReads.ts` finds a test's reads outside its own package by resolving runs
 * of string literals that begin by climbing. This file runs `turbo` and `git` at the repository root, so
 * spelling that root as a climb would register a read of the whole tree — and then the coverage
 * assertion below would demand every file in the repository be a hashed input of this package. `dirname`
 * says the same thing and is not a literal.
 */

const run = promisify(execFile);

/** This file's own directory. */
const HERE = dirname(fileURLToPath(import.meta.url));

/** `tooling/browser-scopes`. */
const PACKAGE_DIR = dirname(HERE);

/** The repository — `tooling/browser-scopes` climbed twice. See the note above on why not as a literal. */
const REPO_ROOT = dirname(dirname(PACKAGE_DIR));

/** This package's own TypeScript, which is the one that resolves the kit through the workspace link. */
const TSC = join(PACKAGE_DIR, "node_modules", ".bin", "tsc");

/** The workspace's turbo. Asked what it hashes, never told. */
const TURBO = join(REPO_ROOT, "node_modules", ".bin", "turbo");

/** The register CI plans from. Reused rather than restated — a second derivation is a second thing to drift. */
const READS = join(REPO_ROOT, ".github", "scripts", "crossPackageReads.ts");

/** This package, as turbo names it. */
const PACKAGE_NAME = "@pithy-sh/browser-scopes";

/** Every task this package defines that turbo caches. `clean` and `reset` declare `cache: false`. */
const TASKS = ["typecheck", "test", "test:node"] as const;

/**
 * Every TypeScript project this package compiles, taken from the script that compiles them.
 *
 * Not a list. `browserSurface.test.ts` asserts that the `typecheck` script names every `tsconfig.*.json`
 * on disk, so reading the script here is reading the projects — and a fifth program cannot be derived by
 * one of the two and missed by the other.
 */
const PROGRAMS: readonly string[] = [
  ...(
    JSON.parse(readFileSync(join(PACKAGE_DIR, "package.json"), "utf8")) as { scripts: { typecheck: string } }
  ).scripts.typecheck.matchAll(/tsc -p (\S+)/g),
].map(([, project]) => project as string);

/** What one project's program opened, as `tsc` reports it. A failing compile still lists its files. */
async function listFiles(project: string): Promise<string> {
  try {
    const { stdout } = await run(TSC, ["-p", project, "--listFilesOnly"], {
      cwd: PACKAGE_DIR,
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  } catch (cause) {
    return (cause as { stdout?: string }).stdout ?? "";
  }
}

/** A path relative to the repo root, in POSIX form. */
function fromRoot(path: string): string {
  return relative(REPO_ROOT, path).split(sep).join("/");
}

/** Whether `path` is inside `dir`. */
function inside(dir: string, path: string): boolean {
  return !relative(dir, path).startsWith("..");
}

/**
 * Every file inside the repository, outside this package and outside `node_modules`, that this
 * package's browser programs compile.
 *
 * **Every one of them, and that is #430's correction.** This ran `tsconfig.responses.json` alone, which
 * covered one of the programs whose subject moves — so a key narrowed over the other three would have
 * replayed green here while the gates it guards went stale. The list is {@link PROGRAMS}, read off the
 * `typecheck` script rather than written down, and `browserSurface.test.ts` holds that script to the
 * projects on disk. So a program added tomorrow is derived here by the commit that runs it.
 *
 * `tsc --listFilesOnly` rather than a hand-rolled import walk: the question is which files the compiler
 * opens, and the compiler is the only thing that knows. That is the same argument `program.ts` makes
 * about the gate itself, for the same reason. The verdict on whether it compiles belongs to `typecheck`
 * — reporting it here too would name the same defect twice.
 *
 * **`--listFilesOnly`, and the same two lines of defense `program.ts` grew — Jim, 2026-08-21.** This was
 * `--listFiles`, which runs the full check and writes diagnostics to the same stream the paths come out
 * of. So a response program with any error at all handed this function its error text as filenames, and
 * the guard then failed claiming a turbo cache-key defect that did not exist. An adversarial pass planted
 * a bare `D1Database` and got exactly one non-path line back:
 * `../../packages/support/src/data/leakD.ts(6,27): error TS2552: Cannot find name 'D1Database'.`
 *
 * That is the same mistake `program.ts` documents having fixed, in the sibling function written in the
 * same commit — which is how a defect class survives being named. `--listFilesOnly` skips the check, and
 * the path test behind it means a line that is not a file on disk is never mistaken for one.
 */
async function compiled(): Promise<string[]> {
  const listings = await Promise.all(PROGRAMS.map(listFiles));
  const files = listings
    .flatMap((stdout) => stdout.split("\n"))
    .map((line) => line.trim())
    .filter(Boolean)
    // A line that is not a path on disk is not a file the compiler opened. See the note above.
    .filter((line) => isAbsolute(line) && existsSync(line))
    .filter((path) => !path.split(sep).includes("node_modules"))
    .filter((path) => inside(REPO_ROOT, path) && !inside(PACKAGE_DIR, path))
    .map(fromRoot)
    .map(sourceOf);
  return [...new Set(files)].sort();
}

/**
 * A compiled file as the file that decides its content.
 *
 * The four browser programs resolve kit specifiers straight to kit source, so almost everything here is
 * already the answer. `tsconfig.json` — the Node-typed half, which typechecks this package's own suites
 * — does not: it goes through the exports map like any consumer, so `@pithy-sh/cli/src/ci/sourceFiles`
 * arrives as `packages/cli/dist/ci/sourceFiles.d.ts`. That file is an **output**, and turbo hashes no
 * build output, so demanding it be in the key would be demanding something that must never be true.
 *
 * The source behind it is not a guess about the layout. `tsdown` and `tsc -p tsconfig.build.json` both
 * mirror `src/` into `dist/`, one emitting `.js` and the other `.d.ts` at the identical path, so the
 * mapping is exact by construction — and `packaging.test.ts` fails on any published module missing
 * either half. The mirrored source is covered by the `packages/**` glob like every other source file,
 * which is why this stays a rewrite here rather than a new entry in `turbo.jsonc`.
 *
 * The Node half is deliberately left resolving through the exports map, unlike the four beside it: what
 * it checks is this package's own TypeScript against the surface the CLI publishes, and the published
 * surface is the right subject for that. Only the browser programs need the authored graph.
 */
function sourceOf(path: string): string {
  const match = /^(packages\/[^/]+)\/dist\/(.+)\.d\.ts$/.exec(path);
  return match === null ? path : `${match[1]}/src/${match[2]}.ts`;
}

/** One task, as turbo plans it. */
type Plan = { tasks: { taskId: string; inputs: Record<string, string> }[] };

/**
 * The files turbo hashes for one of this package's tasks, repo-relative.
 *
 * The keys `--dry=json` returns are relative to the package directory, so a kit file arrives already
 * spelled as a climb — which is why they are resolved before being compared, and why nothing in this file
 * has to know how turbo spells a root-relative glob.
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
 * Every file git tracks under `target`, which is `target` itself when it is a tracked file.
 *
 * Git rather than a directory walk, because git is what turbo hashes: a build artifact is not an input
 * however recently it was written, and a tracked file is an input however dull it looks. It also makes
 * the answer independent of whatever a concurrent suite has scaffolded into `packages/cli/.smoke-*`.
 */
async function tracked(target: string): Promise<string[]> {
  const { stdout } = await run("git", ["ls-files", "--", target], { cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 });
  return stdout.split("\n").filter(Boolean).sort();
}

/**
 * Which of `paths` git ignores — the artifacts, whatever directory they happen to sit in.
 *
 * `check-ignore` exits 1 when it matched nothing, which is the answer rather than a failure, so the empty
 * case arrives through the catch. `--no-index` is deliberate: a file that is both tracked and matched by
 * an ignore rule is tracked, and tracked is what turbo hashes, so only untracked matches count here.
 */
function ignored(paths: readonly string[]): string[] {
  if (paths.length === 0) return [];
  let stdout: string;
  try {
    stdout = execFileSync("git", ["check-ignore", "--stdin"], {
      cwd: REPO_ROOT,
      input: `${paths.join("\n")}\n`,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (cause) {
    const failure = cause as { status?: number; stdout?: string };
    if (failure.status !== 1) throw cause;
    stdout = failure.stdout ?? "";
  }
  return stdout.split("\n").filter(Boolean).sort();
}

describe("this package's cache key covers what this package reads", () => {
  test("every cross-package read the register finds here is hashed, by all three tasks", async () => {
    const targets = await registered();

    // The floor, and the derivation that decides the shape of the glob. Two suites here walk `packages/`
    // to work out what the fixtures must name, so the register records the **directory** — and a
    // directory read is not satisfied by hashing the files something currently imports. A capability
    // landing tomorrow is a file no compile opens today.
    expect(targets).toContain("packages");

    const files = (await Promise.all(targets.map(tracked))).flat();
    expect(files.length).toBeGreaterThan(1000);

    for (const task of TASKS) {
      const key = await hashed(task);
      expect(
        files.filter((file) => !key.has(file)),
        `not in the key for ${task}`,
      ).toEqual([]);
    }
  });

  test("the key holds nothing git ignores, for all three tasks", async () => {
    // The other side of the same glob. Turbo does not apply `.gitignore` to an explicit `inputs` glob, so
    // a bare `packages/**` hashed 169 files nobody wrote: `node_modules/.bin/tsc`,
    // `dist/paddle-prices.iife.js`, and each package's `.turbo/turbo-test.log` — **which the hashed task
    // writes itself**. A key containing the task's own output changes after every run, which is not a
    // false pass but is a cache that can never hit. The negations in `turbo.jsonc` remove exactly those.
    //
    // Asked of git rather than of a list of directory names, because a list is the defect this file
    // exists to refuse and because the property is git's: an ignored file is an artifact, and an artifact
    // is not an input. **Not equality with the tracked set**, which was tried and is wrong — a source
    // file somebody has written and not yet committed is untracked, unignored, and a real input, and a
    // gate that turns red on one is a gate that turns red on ordinary work.
    for (const task of TASKS) {
      const key = [...(await hashed(task))].filter((file) => file.startsWith("packages/")).sort();
      expect(key.length, `nothing under packages/ is in the key for ${task}`).toBeGreaterThan(1000);
      expect(ignored(key), `git ignores these, and the key for ${task} holds them`).toEqual([]);
    }
  });

  test("every file the response gate compiles is hashed, by all three tasks", async () => {
    const files = await compiled();

    // The vacuity floor, and it is the assertion that matters most: an empty derivation satisfies the
    // containment below without touching anything. This module is the subject — #419 landed one import at
    // the top of it — and the count is the transitive reach through the eight capabilities.
    expect(files).toContain("packages/support/src/http/responses.ts");
    // One root from a second program, so a derivation that quietly went back to compiling one of the
    // four is red here rather than covered by the first line. #430 added the request schemas.
    expect(files).toContain("packages/leaderboard/src/http/schemas.ts");
    expect(files.length).toBeGreaterThan(10);

    for (const task of TASKS) {
      const key = await hashed(task);
      expect(
        files.filter((file) => !key.has(file)),
        `not in the key for ${task}`,
      ).toEqual([]);
    }
  });

  test("the two answers nothing in the tree can derive are hashed anyway", async () => {
    // `bun.lock` is which copies are on disk. This gate's answer is a list of npm package names the
    // compiler pulled in, so a `bun update` moving `zod` or `@cloudflare/workers-types` changes what is
    // being classified with no manifest touched, and `program.test.ts` compiles against whatever the
    // store holds.
    //
    // `turbo.jsonc` is the declaration the other three tests check. A task's hash covers its own
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
    expect(expected.length).toBeGreaterThan(1000);
    for (const [index, key] of rest.entries()) {
      expect([...key].sort(), `${TASKS[index + 1]} is keyed differently`).toEqual(expected);
    }
  });
});
