// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFile } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { closure, directoriesOf, inputsOf, type PlannedTask, planOf } from "./turboGraph";

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
 * **A hand-maintained list of what a program reads is the same defect one level up**, which is what
 * this file is for: the expected set is derived from the compile and from the cross-package-read
 * register, never read out of the declaration it checks, and what is hashed is asked of turbo rather
 * than parsed — `--dry=json` reports the file list actually hashed, which is the only answer that
 * matters. A glob that looks configured and matches nothing is the outcome `pithy-sh/dashboard`'s
 * `turbo.jsonc` records three separate spellings of.
 *
 * **Two questions live here over two different denominators, and naming which is which is the rest of
 * #545.** *Is what this fixture reads in its cache key* is answered over the closure ({@link keyed}),
 * because a turbo hash folds in the hash of every task it depends on — a file no glob of this package
 * names is in the key regardless. *Does this task's own declaration carry what nothing upstream can* is
 * answered over {@link hashed}, and is asked three times below: of `bun.lock`, of `turbo.jsonc` itself,
 * and of every target the cross-package-read register finds here.
 *
 * **What is no longer asked is whether `turbo.jsonc` names the kit's source. Those two globs are
 * redundant, and this file records that rather than gating it.** It could not gate it and stay honest:
 * #476 turned the compile's reach into two `.d.ts` files, so coverage is now over the *build closure*
 * behind them, which is fourteen packages — 912 files this task's declaration does not name, measured
 * by pointing the first assertion below at `hashed` instead. A declaration that named them would be a
 * hand-written fourteen-package list, which is the defect in the paragraph above.
 *
 * **And redundant is measured, not assumed.** One sitting on turbo 2.10.10 against this tree, opening
 * and closing on the same hash so that nothing else moved during it: deleting
 * `$TURBO_ROOT$/packages/vite/src/**` and `$TURBO_ROOT$/packages/core/src/**` from all three
 * `@pithy-sh/vite-adopter#*` entries drops this task's own hashed inputs from 292 to 12 and its hash
 * from `dd95598bde318bf2` to `a7fb596aaff54f26` — and the kit's source is still in the key, hashed by
 * `@pithy-sh/vite#build` and `@pithy-sh/core#build` as their own. With the globs gone, one newline
 * appended to `packages/vite/src/plugin.ts` moved this task to `0431d54865dafd4f`, and one appended to
 * `packages/core/src/capability/client.ts` moved it to `128064ca4a1939b1`. Removed from **all three**
 * tasks, nothing in the repository reddens: these tests pass, and so do the twelve of
 * `packages/cli/src/ci/turboInputs.test.ts`, whose repo-wide register gate names one target here —
 * `packages/vite/package.json`, a manifest, which nothing builds and so really must be declared.
 *
 * Removed from **one** task they do redden, through a different assertion —
 * `the three tasks are keyed identically` — because the three declarations then disagree. That is a
 * check on the three staying in step, not on these globs being right, and the distinction is worth
 * keeping straight: a partial deletion is caught, a complete one is not.
 *
 * The redundancy is the claim, so it is held as an assertion rather than as a sentence:
 * {@link upstreamOf} answers the coverage question with this task's own declaration taken away, and
 * reddens on the day the globs stop being redundant. **Deleting them is an edit to `turbo.jsonc`, which
 * #545 puts out of scope — it is written down here and not made.** Until it is they cost six
 * duplicated lines and nothing else.
 *
 * **And the walk from a `dist` file back to the source behind it is turbo's too now (#545).** It was
 * reconstructed here out of each package's manifest — a second model of something turbo already
 * computes, which drifted the moment #542 moved the kit's shared packages to `peerDependencies`. The
 * model is gone: `--dry=json` reports each task's upstream task ids, `turboGraph.ts` follows them, and
 * there is nothing left to keep in step. The direction of that drift is what makes it worth the
 * rewrite rather than the one-field patch — a model narrower than the graph reddens and is survivable,
 * a model wider than it goes green over files turbo never hashed, and #542's patch moved it from the
 * first to the second.
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

/** Every `--dry=json` run this file needs, asked once. Each is a subprocess; none of them moves. */
const PLANS = new Map<string, Promise<Map<string, PlannedTask>>>();

/** One plan, memoized on the pair that defines it. No filter means the whole workspace. */
function plan(task: string, filter?: string): Promise<Map<string, PlannedTask>> {
  const key = `${task}|${filter ?? ""}`;
  const known = PLANS.get(key);
  if (known !== undefined) return known;
  const asked = planOf(TURBO, REPO_ROOT, task, filter);
  PLANS.set(key, asked);
  return asked;
}

/**
 * Where the workspace's packages live, by the name they are planned under.
 *
 * `turbo run build` with no filter plans every package in the workspace and reports the directory each
 * one runs in. Turbo already knows this and turbo is the thing being checked, so asking it is one fewer
 * place for the answer to be wrong — the manifest scan this replaced had to be told which groups to
 * look in (`packages`, `tooling`) and would have missed a third the day one landed.
 */
async function packageDirs(): Promise<Map<string, string>> {
  const graph = await plan("build");
  return directoriesOf(graph, graph.keys());
}

/**
 * Every build turbo plans ahead of `name`'s own, that package included, by directory.
 *
 * **This is the walk, and it is turbo's.** It used to be reconstructed here from each package's
 * manifest, which is a second model of a thing turbo already computes — and a second model drifts. #542
 * moved the kit's shared packages to `peerDependencies`, the walk was reading `dependencies`, and
 * `packages/core/src/**` fell out of this file's model of the cache key. Teaching it `peerDependencies`
 * turns out to be wrong the other way: measured in `turboGraph.test.ts`, `^build` follows
 * `dependencies`, `devDependencies` and `optionalDependencies` and does **not** follow
 * `peerDependencies`. Both readings are one manifest field away from each other, which is the argument
 * for reading neither.
 *
 * Rooted at `<name>#build` and asked of its own plan, deliberately — not sliced out of the fixture
 * task's plan. Keeping the two derivations independent is what lets the assertions below compare them:
 * if this fixture's task ever stopped depending on `^build`, this answer would stay wide while the
 * fixture's key collapsed, and that gap is the whole of #432.
 */
async function buildClosure(name: string): Promise<Map<string, string>> {
  const graph = await plan("build", name);
  return directoriesOf(graph, closure(graph, `${name}#build`));
}

/**
 * The source a set of opened files is built from — the inputs that decide their bytes.
 *
 * A file the fixture opens outside `dist` stands for itself: nothing produces a `package.json`, so the
 * only way to cover a manifest is to hash it. A file **under** `packages/<name>/dist` is the output of
 * that package's build, so what has to be hashed is everything that build reads — which is
 * {@link buildClosure}, straight from turbo.
 *
 * The closure is over **whole source trees**, not the subset a compile happens to reach. That
 * over-approximates, and deliberately in the safe direction: a coverage gate that demands too much
 * fails on an input somebody forgot, while one that demands the compiled subset would go quiet the day
 * a new module joined the graph. A package with no `src` at all — `@pithy-sh/tsconfig` is two JSON
 * files — contributes nothing rather than throwing.
 */
async function behind(files: readonly string[]): Promise<string[]> {
  const dirs = await packageDirs();
  const byDir = new Map([...dirs].map(([name, dir]) => [dir, name]));

  const owners = new Set<string>();
  const required = new Set<string>();
  for (const file of files) {
    const owner = [...byDir.keys()].find((dir) => file.startsWith(`${dir}/`));
    if (owner !== undefined && file.startsWith(`${owner}/dist/`)) owners.add(byDir.get(owner) as string);
    else required.add(file);
  }

  for (const owner of owners) {
    for (const dir of (await buildClosure(owner)).values()) {
      for (const source of expand(`${dir}/src`)) required.add(source);
    }
  }

  return [...required].sort();
}

/**
 * The files turbo hashes for one of this package's tasks — its own declared inputs, and nothing else.
 *
 * The keys `--dry=json` returns are relative to the package directory, so a kit file arrives already
 * spelled as a climb — which is why they are resolved before being compared, and why nothing in this
 * file has to know how turbo spells a root-relative glob.
 */
async function hashed(task: string): Promise<Set<string>> {
  const graph = await plan(task, PACKAGE_NAME);
  return inputsOf(graph, [`${PACKAGE_NAME}#${task}`], REPO_ROOT);
}

/**
 * Everything in one of this package's cache keys: its own inputs, and the inputs of every task it
 * depends on, transitively.
 *
 * **A turbo task hash folds in the hash of each task it depends on**, so a file no glob of
 * `@pithy-sh/vite-adopter#test` names is still in that task's key as long as the `dependsOn` edge is
 * there. Measured on 2.10.10: one newline appended to `packages/auth/src/capability.ts` — a file named
 * by no input of this fixture — moved `@pithy-sh/vite-adopter#test` from `32f13bd0ce7488ee` to
 * `e5544134e3e6955e`. `turboGraph.test.ts` holds the same fact in a four-package fixture workspace,
 * both ways round: the hash moves through a followed edge and stands still through a peer-only one.
 *
 * So this, and not {@link hashed}, is the honest denominator for "is what this fixture reads covered".
 * `hashed` stays for the three questions that really are about the declaration itself.
 */
async function keyed(task: string): Promise<Set<string>> {
  const graph = await plan(task, PACKAGE_NAME);
  return inputsOf(graph, closure(graph, `${PACKAGE_NAME}#${task}`), REPO_ROOT);
}

/**
 * One of this package's cache keys with its own declaration taken away — everything the tasks it
 * depends on contribute on their own.
 *
 * This is the header's redundancy claim, as a set. The two kit-source globs on this task cover
 * `packages/vite/src` and `packages/core/src`; so do `@pithy-sh/vite#build` and `@pithy-sh/core#build`,
 * which hash their own package's files by default. Asking the coverage question over this set rather
 * than {@link keyed} asks whether those upstream halves suffice **alone** — which is the precondition
 * for deleting the globs, and the thing that would have to stop holding for them to matter again. A
 * build task narrowed by an `inputs` list of its own is how that happens.
 */
async function upstreamOf(task: string): Promise<Set<string>> {
  const graph = await plan(task, PACKAGE_NAME);
  const upstream = closure(graph, `${PACKAGE_NAME}#${task}`);
  upstream.delete(`${PACKAGE_NAME}#${task}`);
  return inputsOf(graph, upstream, REPO_ROOT);
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
  // A package in the build closure need not have source: `@pithy-sh/tsconfig` is two JSON files. It
  // contributes nothing to the required set, which is the right answer rather than an `ENOENT`.
  if (!existsSync(absolute)) return [];
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

    const required = await behind(files);

    // The floor again, one level down, and this is the assertion that matters most. `behind` resolving
    // to nothing would pass every containment below, so it is pinned to the two things it must reach:
    // the source those declarations are emitted from, and the source of the package that source
    // imports.
    expect(required).toContain("packages/vite/src/plugin.ts");
    expect(required).toContain("packages/core/src/capability/client.ts");
    expect(required.length).toBeGreaterThan(10);

    for (const task of TASKS) {
      const key = await keyed(task);
      expect(
        required.filter((file) => !key.has(file)),
        `not in the key for ${task}`,
      ).toEqual([]);
    }
  });

  // **And the two kit-source globs on this task add nothing to that, which is a measurement rather
  // than a remark.** The same containment, over everything in the key *except* this task's own
  // declared inputs. If the upstream builds cover the compile on their own then
  // `$TURBO_ROOT$/packages/vite/src/**` and `$TURBO_ROOT$/packages/core/src/**` buy no coverage and
  // cost six duplicated lines — measured in the note at the top of this file, where deleting them from
  // all three tasks leaves the hash moving on both files and reddens nothing. (From one task only, the
  // keying assertion catches it; that is about the three agreeing.) Deleting them is a `turbo.jsonc` edit
  // and out of #545's scope; this assertion is what would redden first if they ever became
  // load-bearing again, and it names the reason rather than leaving the claim as prose.
  test("the builds behind the compile cover it without this task's own declaration", async () => {
    const required = await behind(await opened());

    // The same vacuity floor as above: an empty list is covered by an empty set.
    expect(required).toContain("packages/vite/src/plugin.ts");
    expect(required).toContain("packages/core/src/capability/client.ts");
    expect(required.length).toBeGreaterThan(10);

    for (const task of TASKS) {
      const upstream = await upstreamOf(task);
      expect(
        required.filter((file) => !upstream.has(file)),
        `only this task's own inputs put it in the key for ${task}`,
      ).toEqual([]);
    }
  });

  // **The walk was narrower than turbo the whole time, and this is what it was missing.**
  // `@pithy-sh/vite` imports `@pithy-sh/auth`, `i18n`, `payments`, `support`, `turnstile` and
  // `ui-react` from its own `src`, every one of them through `devDependencies` — the field the manifest
  // walk never read. Its answer was `vite` and `core`; turbo's is fourteen packages. Named here rather
  // than left as a count, because a count goes green again the moment a different package joins.
  test("the walk reaches every package the build of the opened declarations depends on", async () => {
    const dirs = await buildClosure("@pithy-sh/vite");
    expect([...dirs.keys()].sort()).toEqual(
      expect.arrayContaining([
        "@pithy-sh/auth",
        "@pithy-sh/core",
        "@pithy-sh/i18n",
        "@pithy-sh/payments",
        "@pithy-sh/support",
        "@pithy-sh/turnstile",
        "@pithy-sh/ui-react",
        "@pithy-sh/vite",
      ]),
    );
  });

  // **The edge itself, which is the half a file list cannot state.** Every build above is in this
  // fixture's cache key by way of `dependsOn`, so the coverage assertion holds only for as long as the
  // edge does. #432 is exactly its absence: a task keyed on its own package while its subject was
  // another one. Asserted per task because an override in `turbo.jsonc` replaces the base task rather
  // than merging with it, so `dependsOn` is restated three times and can be dropped from one.
  test("each task depends on every build behind what the compile opens", async () => {
    const behindIt = new Set([...(await buildClosure("@pithy-sh/vite")).keys()].map((name) => `${name}#build`));
    expect(behindIt.size).toBeGreaterThan(10);

    for (const task of TASKS) {
      const graph = await plan(task, PACKAGE_NAME);
      const reached = closure(graph, `${PACKAGE_NAME}#${task}`);
      expect(
        [...behindIt].filter((id) => !reached.has(id)).sort(),
        `${task} does not depend on it — restate dependsOn on its entry in turbo.jsonc`,
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
