// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFile, execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { isTestFile, sourcePaths } from "./sourceFiles";

/**
 * **A gate whose subject is the repository has to be keyed on the repository.**
 *
 * Turbo's default inputs for a task are the files of the package that declares it. Almost every gate
 * under `packages/cli/src/ci/` reads further than that — `sourceFiles.test.ts` reads every tracked file
 * in the tree, `fileModes.test.ts` reads every tracked file's mode, `workflowModuleFormat.test.ts` and
 * `workflowDeterminism.test.ts` walk `packages/` — and for as long as they existed they were scoped to
 * one package while their subject was the whole tree. So a commit touching no file in `packages/cli`
 * left `@pithy-sh/cli:test` a cache hit, and the gate replayed a pass over a tree it never saw.
 *
 * Reproduced on this branch with the cache warm (#432). One `U+200F` planted in
 * `packages/payments/src/client/wholeUnits.ts` — the exact character the source gate refuses —
 * and `turbo run test --filter=@pithy-sh/cli` printed `Cached: 1 cached, 1 total` and
 * `Time: 21ms >>> FULL TURBO`, replaying a `3613 passed` from before the character existed. Run
 * directly, the same tree fails — the source gate names `U+200F at byte 124` and asks for it spelled.
 * **The stale answer is "pass"**, which is the whole failure.
 *
 * `turbo.jsonc` names the tree now. **A hand-maintained list of what a gate reads is the same defect one
 * level up**, which is what this file is for, and it is deliberately general rather than about
 * `packages/cli`: the expected set is derived from the cross-package-read register — the same derivation
 * CI already plans jobs with — and the declaration is *asked of turbo* rather than parsed, because
 * `--dry=json` reports the files actually hashed and that is the only answer that matters. A glob that
 * looks configured and matches nothing is what `pithy-sh/dashboard`'s `turbo.jsonc` records three
 * spellings of.
 *
 * **The planner was already right; only the hash was wrong.** `.github/scripts/crossPackageReads.ts`
 * maps a changed path back to the package whose suite asserts about it, and CI adds that package by
 * name. So CI has been planning `@pithy-sh/cli` on every `packages/**` change all along — and turbo then
 * answered it from a cache computed for a different tree. One derivation, used for both ends, is the
 * point of reading the register here instead of writing a second list.
 *
 * **This guard cannot be switched off by editing the thing it guards.** A task's hash covers its own
 * definition and no other, so a guard living in a narrowly-keyed package would replay while somebody
 * narrowed `turbo.jsonc` underneath it. It runs in `@pithy-sh/cli:test`, whose key is now the whole
 * tree — `turbo.jsonc` included — so any edit to the declaration re-runs the assertion about it.
 *
 * **Git is the second derivation, and it works from both sides.** Turbo does not apply `.gitignore` to
 * an explicit `inputs` glob, so a bare tree glob happily hashes `node_modules/`, `dist/`, and each
 * package's `.turbo/turbo-test.log` — **which the hashed task writes itself**. A key holding a task's own
 * output is not a false pass, but it is a cache that can never hit. So the glob is checked twice over:
 * every file git *tracks* under a package's registered targets is hashed, and none of the artifacts a run
 * of this repository *writes* is. Equality with the tracked set is wrong and was not written: a module
 * somebody has written and not yet committed is untracked, unignored, and a real input.
 *
 * **The artifacts are planted, and the plant is derived.** Reading the working tree and asking git about
 * it made that second half a different assertion on every machine: one `packages/<pkg>/x.tmp` — which an
 * interrupted atomic write leaves behind — turned it red naming neither the crash nor the file. So the
 * probes are invented instead. Every rule of every ignore file git consults becomes one path that rule
 * and no other decides ({@link probeFor}), planted for the length of the assertion.
 *
 * **A catalog of artifacts kept by hand is the defect this file refuses one level up, and it had both
 * halves of it.** The catalog read the root `.gitignore` alone, so `packages/cli/.gitignore` was
 * invisible and the vendored `packages/cli/templates/` it ignores sat inside all four whole-tree keys —
 * a directory `prepack` writes, `postpack` removes, and a pack that fails between them leaves behind for
 * good. And a probe narrower than its rule counted as covering it: `.dev.vars.*` was exercised by
 * `.dev.vars.dev`, so `packages/core/.dev.vars.local` stayed hashed, and `.worktrees/` — which matches at
 * any depth — was exercised at the root alone. Both shapes fail the same way: a key that agrees with CI
 * on a clean checkout and differs on the machine that has the file.
 */

const run = promisify(execFile);

/** `packages/cli/src/ci` → the repository. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

/** The workspace's turbo. Asked what it hashes, never told. */
const TURBO = join(REPO_ROOT, "node_modules", ".bin", "turbo");

/** The derivation CI plans with. Run as a subprocess: it is not under this package's `rootDir`. */
const SCRIPT = join(REPO_ROOT, ".github", "scripts", "crossPackageReads.ts");

/**
 * Every task that runs a package's vitest and that turbo caches.
 *
 * `test:integration` is left out because it declares `cache: false` — it talks to live Cloudflare, so
 * there is no hash for it to lie about. `typecheck` and `build` are left out because the register is
 * derived from test files, and a compile's reach is a different question with a different answer.
 */
const TEST_TASKS = ["test", "test:node", "test:workers"] as const;

/** One test file's read of a path outside the package that owns it, as the register reports it. */
type Read = { package: string; directory: string; file: string; target: string };

/** One task, as turbo plans it. */
type Plan = { tasks: { taskId: string; directory: string; command: string; inputs: Record<string, string> }[] };

/** What turbo reports as the command of a task a package does not define. */
const NO_SCRIPT = "<NONEXISTENT>";

/** A path relative to the repo root, in POSIX form. */
function fromRoot(path: string): string {
  return relative(REPO_ROOT, path).split(sep).join("/");
}

/** Every cross-package read in this tree, grouped by the package whose suite makes it. */
async function registered(): Promise<Map<string, string[]>> {
  const { stdout } = await run("bun", [SCRIPT, "--json"], { cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 });
  const targets = new Map<string, Set<string>>();
  for (const read of JSON.parse(stdout) as Read[]) {
    const seen = targets.get(read.package) ?? new Set<string>();
    seen.add(read.target);
    targets.set(read.package, seen);
  }
  return new Map([...targets].map(([name, seen]) => [name, [...seen].sort()]));
}

/**
 * The files turbo hashes for `task`, per package, repo-relative.
 *
 * One unfiltered plan rather than one per package: `--dry=json` reports every package the task reaches,
 * with the directory it runs in, so a package that lands tomorrow is covered without being named.
 * The input keys are relative to that directory — a repo-root file arrives already spelled as a climb —
 * which is why they are resolved before being compared, and why nothing here has to know how turbo
 * spells a root-relative glob.
 *
 * A package that does not define the script is still planned, with `<NONEXISTENT>` for its command and a
 * key nothing will ever be compared against. Dropped here rather than at each call site: a phantom
 * `test:workers` for a package with no workers suite once made the equality check below claim
 * `@pithy-sh/browser-scopes` keyed its tasks differently, which was true of a task that does not exist.
 */
async function planned(task: string): Promise<Map<string, Set<string>>> {
  const { stdout } = await run(TURBO, ["run", task, "--dry=json"], { cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 });
  const plan = JSON.parse(stdout) as Plan;
  const keys = new Map<string, Set<string>>();
  for (const entry of plan.tasks) {
    if (entry.command === NO_SCRIPT) continue;
    const dir = resolve(REPO_ROOT, entry.directory);
    const name = entry.taskId.slice(0, entry.taskId.lastIndexOf("#"));
    keys.set(name, new Set(Object.keys(entry.inputs).map((key) => fromRoot(resolve(dir, key)))));
  }
  return keys;
}

/**
 * Every file git tracks under `target`, which is `target` itself when it is a tracked file.
 *
 * Git rather than a directory walk, because git is what turbo hashes: a build artifact is not an input
 * however recently it was written, and a tracked file is an input however dull it looks. It also makes
 * the answer independent of whatever a concurrent suite has scaffolded into `packages/cli/.smoke-*`.
 */
function tracked(target: string): string[] {
  const stdout = execFileSync("git", ["ls-files", "--", target], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout.split("\n").filter(Boolean);
}

/**
 * The rule that ignores each of `paths`, as `.gitignore:<line>`. Absent when nothing ignores it.
 *
 * `check-ignore -v` names the file and line that decided, which is what turns "these paths are
 * ignored" into "these *rules* are exercised". It exits 1 when it matched nothing, which is the answer
 * rather than a failure, so the empty case arrives through the catch. A file that is both tracked and
 * matched by an ignore rule is tracked, and tracked is what turbo hashes, so the default behavior —
 * untracked matches only — is the one wanted here.
 */
function ignoreRules(paths: readonly string[]): Map<string, string> {
  const rules = new Map<string, string>();
  if (paths.length === 0) return rules;
  let stdout: string;
  try {
    stdout = execFileSync("git", ["check-ignore", "-v", "--stdin"], {
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
  // `<source>:<line>:<pattern>\t<path>`, and a pattern may hold a colon, so the tab ends the verdict
  // and the first two colons end the source.
  for (const line of stdout.split("\n").filter(Boolean)) {
    const tab = line.indexOf("\t");
    const verdict = line.slice(0, tab);
    const colon = verdict.indexOf(":", verdict.indexOf(":") + 1);
    rules.set(line.slice(tab + 1), verdict.slice(0, colon));
  }
  return rules;
}

/**
 * Every ignore file git consults in this tree, repo-relative.
 *
 * **Three questions, because a `.gitignore` reaches git three ways.** It can be committed
 * (`packages/cli/.gitignore`, which ignores the vendored starter). It can be written and not yet
 * committed. And it can be generated and ignored by itself — `.husky/_/.gitignore` holds one `*`, which
 * covers the file stating it, so the ordinary untracked listing does not report it.
 *
 * The third call collapses ignored directories, which is what keeps `node_modules` from contributing
 * thirty thousand answers: git names the directory, the walk stops there, and nothing inside a tree every
 * key excludes wholesale has an opinion worth asking for.
 */
function ignoreFiles(): string[] {
  const found = new Set<string>();
  const ask = (args: readonly string[]): void => {
    const stdout = execFileSync("git", ["ls-files", ...args], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    for (const line of stdout.split("\n")) {
      if (line === ".gitignore" || line.endsWith("/.gitignore")) found.add(line);
    }
  };
  ask(["--", "*.gitignore"]);
  ask(["--others", "--exclude-standard", "--", "*.gitignore"]);
  ask(["--others", "--ignored", "--exclude-standard", "--directory"]);
  return [...found].sort();
}

/** One rule an ignore file states. */
type Rule = {
  /** `<file>:<line>`, spelled the way `git check-ignore -v` spells it. */
  source: string;
  /** The pattern, trimmed. */
  pattern: string;
  /** The directory the pattern is read against, repo-relative. Empty for the root file. */
  directory: string;
};

/** Every rule every ignore file states. Comments, blanks and re-inclusions out. */
function statedRules(): Rule[] {
  const rules: Rule[] = [];
  for (const file of ignoreFiles()) {
    const parent = dirname(file);
    const directory = parent === "." ? "" : parent;
    const lines = readFileSync(join(REPO_ROOT, file), "utf8").split("\n");
    for (const [index, line] of lines.entries()) {
      const pattern = line.trim();
      if (pattern === "" || pattern.startsWith("#") || pattern.startsWith("!")) continue;
      rules.push({ source: `${file}:${index + 1}`, pattern, directory });
    }
  }
  return rules;
}

/**
 * Where the planted artifacts go. A plain name rather than a dotted one, because turbo's globwalk has
 * its own opinion about dotted directories and a probe turbo never looks inside proves nothing.
 */
const PROBE = "turbo-key-probe";

/**
 * One file that is not an artifact, planted beside them.
 *
 * It is what makes the assertion below non-vacuous. Every planted probe is git-ignored, so
 * "no key holds one" is also what a turbo that never walked this directory at all would report. This
 * one is ignored by nothing, so every whole-tree key must hold it, and the test says so before it
 * concludes anything from an absence.
 */
const REACHED = `${PROBE}/reached.md`;

/** What a `*` becomes when a rule is materialised, and the name of the file inside a directory rule. */
const ANY = "probe";

/**
 * The path a rule ignores, invented rather than found.
 *
 * A rule is a pattern and a directory to read it against. Trailing `/` means it names a directory, so the
 * probe is a file inside one; a `/` anywhere else anchors it to the ignore file's own directory, and a
 * pattern with none matches **at any depth**, so the probe goes one level down. That last part is not a
 * detail: `.worktrees/` has no slash of its own, and a key that negates it at the root alone still hashes
 * `packages/core/.worktrees/`.
 *
 * Materialising the pattern rather than picking a path by hand is what makes the coverage claim exact.
 * A hand-picked `.dev.vars.dev` satisfies `.dev.vars.*` while `.dev.vars.local` — wrangler's own filename
 * — goes on being hashed. `.dev.vars.probe` cannot be satisfied by anything narrower than the rule.
 *
 * Every shape this tree does not state is refused rather than guessed at. A `?`, a character class or a
 * `**` arriving in an ignore file is a rule this function would materialise wrongly and quietly, so it
 * fails here instead, naming the line.
 */
function probeFor(rule: Rule): string {
  if (!/^[A-Za-z0-9_./*-]+$/.test(rule.pattern) || rule.pattern.includes("**")) {
    throw new Error(`${rule.source} states \`${rule.pattern}\`, and this file has no probe shape for it`);
  }
  const directoryRule = rule.pattern.endsWith("/");
  const body = directoryRule ? rule.pattern.slice(0, -1) : rule.pattern;
  const anchored = body.includes("/");
  const spelled = body.replace(/^\//, "").replaceAll("*", ANY);
  return [rule.directory, anchored ? "" : PROBE, spelled, directoryRule ? ANY : ""].filter(Boolean).join("/");
}

/**
 * The artifacts a run of this repository writes **inside a package**, at the paths it writes them to.
 *
 * The derived probes above are what discharges coverage: every rule of every ignore file is exercised by
 * a path only that rule decides. This list is a second subject, not a second catalog. A key scoped to
 * `packages/**` — `@pithy-sh/browser-scopes`' three — can only ever hold an artifact that sits inside a
 * package, and the probes above sit in a directory of their own at the root, where such a key never
 * looks. So the seven are named here: an install, a build, a coverage report, turbo's own task log,
 * `tsc -b`'s buildinfo, and the two `.dev.vars` files a worker directory carries — the shared one
 * `pithy dev` symlinks and the per-environment one a `--env` run reads.
 *
 * Seven rather than every rule, and that is a decision rather than an omission. A stray `.tmp` left by an
 * interrupted atomic write appears once, after a crash, and costs one cache miss; a `packages/*` negation
 * for it would have to be written into six declarations to buy that back. The whole-tree keys exclude all
 * of them anyway, through the derived probes, so what is unheld here is held there.
 */
const PACKAGE_ARTIFACTS: readonly string[] = [
  "packages/core/node_modules/probe.turbo-key",
  "packages/core/dist/probe.turbo-key",
  "packages/core/coverage/probe.turbo-key",
  "packages/core/.turbo/probe.turbo-key",
  "packages/core/probe-turbo-key.tsbuildinfo",
  "packages/core/.dev.vars",
  "packages/core/.dev.vars.dev",
];

/** What a planted file holds, so residue from a run that was killed can be recognized as this file's. */
const SENTINEL = "planted by turboInputs.test.ts\n";

/** The probe directory `path` sits under, when it sits under one. */
function probeRoot(path: string): string | undefined {
  const parts = path.split("/");
  const at = parts.indexOf(PROBE);
  return at === -1 ? undefined : parts.slice(0, at + 1).join("/");
}

/**
 * Whatever an earlier run left behind, gone — before anything is planted.
 *
 * **`finally` does not run on SIGKILL.** A Ctrl-C, a CI step timeout or an OOM leaves the probes on disk,
 * and the run after that one used to find every path taken, plant nothing, and hand back an undo that
 * removed nothing. The residue then stayed for good: `turbo-key-probe/reached.md` is untracked *and*
 * unignored — the test requires that of it — so it is one `git add -A` from being committed, and it is
 * hashed into every whole-tree key until it is.
 *
 * A probe directory is a name this file invented, so everything under one is this file's to remove. A
 * probe outside one shares a directory with real files, so it is removed only when it still holds
 * {@link SENTINEL}. `lstatSync` and not `statSync`: `packages/core/.dev.vars` is a symlink to the
 * repository's one secrets file on any machine that has run `pithy dev`, and a symlink is not a file this
 * ever wrote.
 */
function sweep(paths: readonly string[]): void {
  for (const root of new Set(paths.map(probeRoot))) {
    if (root !== undefined) rmSync(join(REPO_ROOT, root), { recursive: true, force: true });
  }
  for (const path of paths) {
    if (probeRoot(path) !== undefined) continue;
    const full = join(REPO_ROOT, path);
    try {
      if (!lstatSync(full).isFile() || readFileSync(full, "utf8") !== SENTINEL) continue;
    } catch {
      continue;
    }
    rmSync(full, { force: true });
  }
}

/** Every level of `directory` that was not already there, outermost first. */
function makeDirs(directory: string, made: string[]): void {
  let current = REPO_ROOT;
  for (const part of relative(REPO_ROOT, directory).split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      mkdirSync(current);
      made.push(current);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
    }
  }
}

/**
 * Write `paths`, and hand back the undo.
 *
 * It never writes over something already there and never removes something it did not create.
 *
 * **`wx` rather than a prior `existsSync`, and the difference is a symlink.** `packages/core/.dev.vars`
 * is a link to the repository's one secrets file on any machine that has run `pithy dev`, and a link
 * whose target is momentarily absent reads as absent — a plain write would then create the *target*,
 * and the undo would delete the developer's link and leave the file. `O_CREAT | O_EXCL` refuses a
 * symlink whatever it points at, so the path is skipped instead.
 *
 * **The undo removes files one by one and directories with `rmdir`.** It reached into live packages —
 * `packages/core/.turbo`, `packages/core/dist` — and under `bun run test` all two dozen tasks run at
 * once, with `@pithy-sh/core#test` writing `packages/core/.turbo/turbo-test.log` while this file runs
 * inside `@pithy-sh/cli#test`. A recursive remove of a directory this test happened to create first is a
 * concurrent task's output deleted underneath it. `rmdir` on a directory somebody else has since written
 * to fails, which is the right answer, so the failure is swallowed and the directory stays.
 */
function plant(paths: readonly string[]): () => void {
  sweep(paths);
  const files: string[] = [];
  const dirs: string[] = [];
  for (const path of paths) {
    const full = join(REPO_ROOT, path);
    makeDirs(dirname(full), dirs);
    try {
      writeFileSync(full, SENTINEL, { flag: "wx" });
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
      continue;
    }
    files.push(full);
  }
  return () => {
    for (const file of files) rmSync(file, { force: true });
    for (const dir of [...dirs].reverse()) {
      try {
        rmdirSync(dir);
      } catch {
        // Something else is in it, or something else has already taken it. Either way it is not ours.
      }
    }
  };
}

/**
 * A registered read of something git tracks nothing under, and what covers it instead.
 *
 * The guard's premise is that a registered read is either hashed or named, and there was a silent third
 * outcome: {@link tracked} answers `[]` for an untracked target, and the containment below runs over the
 * union of a package's targets, so a target nothing can enforce simply disappeared as long as one sibling
 * was tracked. Named here instead — with what makes it safe, because "unenforceable" is not an answer.
 */
const UNTRACKED_TARGETS: Record<string, string> = {
  "node_modules/.bin/biome":
    "Installed, never committed, and the whole-tree keys negate `**/node_modules/**` deliberately — 29,032 files, none of them anybody's source. What moves when biome moves is `bun.lock`, which every one of these keys hashes.",
};

describe("a gate is keyed on what it reads", () => {
  test("every cross-package read the register finds is hashed by that package's test tasks", async () => {
    const targets = await registered();
    const named = new Set([...targets.values()].flat());
    expect(
      Object.keys(UNTRACKED_TARGETS).filter((target) => !named.has(target)),
      "written down as an untracked read and the register no longer reports it",
    ).toEqual([]);
    expect(
      Object.keys(UNTRACKED_TARGETS).filter((target) => tracked(target).length > 0),
      "written down as an untracked read and git tracks it now — the entry says nothing",
    ).toEqual([]);

    // The vacuity floor, and it is the assertion that matters most: an empty register satisfies every
    // containment below without touching anything. `.` is the repo root, and it is this package's own
    // entry — `sourceFiles.test.ts` reads every tracked file in the tree, which is the read #432 was
    // opened about.
    expect([...targets.keys()]).toContain("@pithy-sh/cli");
    expect(targets.get("@pithy-sh/cli")).toContain(".");

    const plans = new Map(await Promise.all(TEST_TASKS.map(async (task) => [task, await planned(task)] as const)));

    for (const [name, reads] of targets) {
      // Per target, not per package. The union hid an unenforceable target behind a tracked sibling.
      expect(
        reads.filter((target) => tracked(target).length === 0 && !(target in UNTRACKED_TARGETS)),
        `${name} registers a read of nothing git tracks — say what covers it, in UNTRACKED_TARGETS`,
      ).toEqual([]);

      const files = [...new Set(reads.flatMap(tracked))].sort();
      expect(files.length, `${name} registers a read of nothing git tracks`).toBeGreaterThan(0);

      for (const task of TEST_TASKS) {
        // A package that does not define the task is not in that plan, and owes it nothing.
        const key = plans.get(task)?.get(name);
        if (key === undefined) continue;
        expect(
          files.filter((file) => !key.has(file)),
          `${name} reads these and the key for ${task} does not hold them`,
        ).toEqual([]);
      }
    }
  });

  test("the whole tree is what this package's own key comes to", async () => {
    // The floor above says every registered read is hashed; this says how much that is, so that a
    // register that stopped finding the root read would be caught by something other than its absence.
    const all = tracked(".");
    expect(all.length).toBeGreaterThan(2000);

    for (const task of TEST_TASKS) {
      const key = (await planned(task)).get("@pithy-sh/cli");
      if (key === undefined) continue;
      expect(
        all.filter((file) => !key.has(file)),
        `not in the key for ${task}`,
      ).toEqual([]);
    }
  });

  test("no test task's key holds an artifact a run of this repository writes", async () => {
    // The other side of the same glob. Turbo does not apply `.gitignore` to an explicit `inputs` glob,
    // so a bare tree glob hashes `node_modules/`, every `dist/`, and each package's
    // `.turbo/turbo-test.log` — **which the hashed task writes itself**. A key holding the task's own
    // output changes after every run, which is not a false pass but is a cache that can never hit.
    //
    // The probes are planted and {@link probeFor} invents them, one per rule of every ignore file git
    // consults. Found ones are whatever the last crash left, so the test was a different test on every
    // machine; hand-picked ones are as narrow as whoever picked them, which is how `.dev.vars.*` came to
    // be exercised by `.dev.vars.dev` alone.
    const stated = statedRules();
    expect(stated.length, "no ignore rule was found at all").toBeGreaterThan(20);
    const probes = new Map(stated.map((rule) => [probeFor(rule), rule.source]));
    expect(probes.size, "two rules materialise to one path, so one of them is unexercised").toBe(stated.length);

    const artifacts = [...probes.keys(), ...PACKAGE_ARTIFACTS];
    const remove = plant([...artifacts, REACHED]);
    try {
      const rules = ignoreRules([...artifacts, REACHED]);

      // Coverage, and it is exact rather than sampled: each probe was invented for one rule, and git has
      // to name *that* rule as the one deciding it. A probe git ignores for some other reason proves
      // nothing about the rule it was invented for, and a probe git does not ignore at all proves nothing
      // at all. So this one assertion says both "every rule is exercised" and "by a path only it decides".
      expect(
        [...probes]
          .filter(([path, source]) => rules.get(path) !== source)
          .map(([path, source]) => `${source} → ${path}`),
        "invented for this rule, and git decides the path some other way",
      ).toEqual([]);
      expect(
        PACKAGE_ARTIFACTS.filter((path) => !rules.has(path)),
        "planted as an artifact and git does not ignore it",
      ).toEqual([]);
      expect(rules.has(REACHED), `${REACHED} has to be a file git would carry`).toBe(false);

      for (const task of TEST_TASKS) {
        for (const [name, key] of await planned(task)) {
          expect(
            artifacts.filter((path) => key.has(path)),
            `${name}'s key for ${task} holds these`,
          ).toEqual([]);
        }
      }

      // Last, because it is the reason the four assertions above mean anything: turbo really does walk
      // the directory the artifacts were planted in. A whole-tree key that stopped reaching it would
      // otherwise report the same empty list as a key that excludes every artifact correctly.
      for (const task of TEST_TASKS) {
        for (const name of ["@pithy-sh/cli", "@pithy-sh/ui-react"]) {
          const key = (await planned(task)).get(name);
          if (key === undefined) continue;
          expect(key.has(REACHED), `${name}'s key for ${task} never reached ${PROBE}/`).toBe(true);
        }
      }
      // And the same for the subject the package-level artifacts sit in.
      for (const task of TEST_TASKS) {
        const key = (await planned(task)).get("@pithy-sh/browser-scopes");
        if (key === undefined) continue;
        expect(
          key.has("packages/core/package.json"),
          `browser-scopes' key for ${task} never reached packages/core`,
        ).toBe(true);
      }
    } finally {
      remove();
    }
  });

  test("a run that was killed leaves nothing for the next one to work around", () => {
    // **`finally` does not run on SIGKILL.** A Ctrl-C, a CI step timeout or an OOM leaves the probes on
    // disk, and the plant used to skip every path it found taken and hand back an undo over an empty
    // list. So the second run was green, removed nothing, and the residue stayed for good — including
    // `reached.md`, which this file requires git *not* to ignore, one `git add -A` from a commit and
    // hashed into all four whole-tree keys until then.
    const residue = `${PROBE}/killed/probe`;
    mkdirSync(join(REPO_ROOT, PROBE, "killed"), { recursive: true });
    writeFileSync(join(REPO_ROOT, residue), SENTINEL);
    try {
      plant([residue])();
      expect(existsSync(join(REPO_ROOT, residue)), `${residue} outlived the run that planted it`).toBe(false);
      expect(existsSync(join(REPO_ROOT, PROBE)), `${PROBE}/ outlived the run that planted it`).toBe(false);
    } finally {
      rmSync(join(REPO_ROOT, PROBE), { recursive: true, force: true });
    }
  });

  test("the undo takes what it wrote, and never a directory something else is using", () => {
    // `PACKAGE_ARTIFACTS` reaches into a live package — `packages/core/.turbo`, `packages/core/dist` —
    // and under `bun run test` every task runs at once, with `@pithy-sh/core#test` writing
    // `packages/core/.turbo/turbo-test.log` while this file runs inside `@pithy-sh/cli#test`. On a clean
    // checkout the two race for the `mkdir`, and a recursive undo of the directory this test won took a
    // concurrent task's output with it.
    const mine = `${PROBE}/shared/probe`;
    const theirs = `${PROBE}/shared/turbo-test.log`;
    const remove = plant([mine]);
    try {
      writeFileSync(join(REPO_ROOT, theirs), "written by the task next door\n");
      remove();
      expect(existsSync(join(REPO_ROOT, mine)), `${mine} was this test's to remove`).toBe(false);
      expect(existsSync(join(REPO_ROOT, theirs)), `${theirs} was not`).toBe(true);
    } finally {
      rmSync(join(REPO_ROOT, PROBE), { recursive: true, force: true });
    }
  });

  test("no test task's key reaches into git's own directory", async () => {
    // `.git` is neither tracked nor ignored, so neither test above has an opinion about it — and a tree
    // glob picks it up. In a worktree it is one small file; in the main checkout it is a directory that
    // changes on every commit, fetch and index write, which is a key that can never hit twice.
    for (const task of TEST_TASKS) {
      for (const [name, key] of await planned(task)) {
        expect(
          [...key].filter((file) => file === ".git" || file.startsWith(".git/")),
          `${name}'s key for ${task} reaches into .git`,
        ).toEqual([]);
      }
    }
  });

  test("the test tasks of a package that names its own inputs are keyed identically", async () => {
    // Not tidiness. The three tasks run one package's vitest over one tree: `test` runs every project
    // it declares, and `test:node` and `test:workers` between them run every project too — which is a
    // claim rather than an assumption, so the sweep below holds them to it. `@pithy-sh/i18n` is why it
    // has to be put that way: its `test` runs `node`, `dom` and `workers`, its `test:node` runs the
    // first two and its `test:workers` the third, so "the same vitest" is false of any pair of them and
    // "the same files, between them" is true of all three.
    //
    // The guard above runs in `test`, and CI runs the other two (`.github/workflows/ci.yml`). So a
    // `test` keyed more narrowly than the `test:node` CI runs — or the reverse — would replay a green
    // guard over a declaration that had gone stale. Equal sets is the cheapest way to say that and the
    // only one a reader can check at a glance.
    const named = [...(await registered()).keys()];
    const plans = new Map(await Promise.all(TEST_TASKS.map(async (task) => [task, await planned(task)] as const)));

    for (const name of named) {
      const keys = TEST_TASKS.map((task) => plans.get(task)?.get(name)).filter((key) => key !== undefined);
      const [first, ...rest] = keys;
      if (first === undefined) continue;
      const expected = [...first].sort();
      for (const key of rest) expect([...key].sort(), `${name} keys its test tasks differently`).toEqual(expected);
    }
  });

  test("every gate in this directory is repo-wide, or is written down as not being one", async () => {
    // `src/ci/` is where this repository's tree-wide gates live, so the default here is the opposite of
    // the default everywhere else: a file landing in this directory is assumed to read past its own
    // package until somebody says otherwise. The exceptions are named below with what they read, which
    // makes this the tripwire beside the derivation — the same shape as `crossPackageReads.test.ts`'s
    // `RECORD`, and for the same reason. Derived and unnoticed are the same thing.
    //
    // Everything not named here is covered by the tree key, which the first two tests hold turbo to.
    const PACKAGE_SCOPED: Record<string, string> = {
      "jsoncWriters.test.ts":
        "It sweeps `packages/cli/src` for modules that write JSONC, which is inside its own package. Turbo's default inputs are already exactly right for it.",
    };

    // Recursive, because the defect #432 is about is exactly what a flat listing cannot see: a gate at
    // `src/ci/<subdir>/foo.test.ts` could read the whole tree, be keyed to one package, and leave this
    // tripwire green. Both sides key on the path below `src/ci/`, so two gates sharing a base name stay
    // two gates.
    const here = dirname(fileURLToPath(import.meta.url));
    const gates = sourcePaths(here, { keep: isTestFile, dotted: true })
      .map((path) => relative(here, path).split(sep).join("/"))
      .sort();
    expect(gates.length).toBeGreaterThan(5);

    const CI = "packages/cli/src/ci/";
    const { stdout } = await run("bun", [SCRIPT, "--json"], { cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 });
    const repoWide = new Set(
      (JSON.parse(stdout) as Read[])
        .filter((read) => read.file.startsWith(CI))
        .map((read) => read.file.slice(CI.length)),
    );

    expect(
      gates.filter((gate) => !repoWide.has(gate) && !(gate in PACKAGE_SCOPED)),
      "these read only their own package, or the register stopped seeing that they do not — say which, above",
    ).toEqual([]);
    expect(
      Object.keys(PACKAGE_SCOPED).filter((gate) => !gates.includes(gate)),
      "written down as package-scoped and no longer here",
    ).toEqual([]);
    // And nothing the register already sees is written down here as well. `turboInputs.test.ts` was,
    // on the claim that the register cannot see a path arriving from a subprocess — and the register
    // reports it with target `.`, because line 60 climbs to the repository the same way every other
    // gate in this directory does. An exception nobody re-checked is a sentence that stops being true
    // quietly, which is the shape this whole file exists to refuse.
    expect(
      Object.keys(PACKAGE_SCOPED).filter((gate) => repoWide.has(gate)),
      "the register already reports these reading past their package — the entry says nothing",
    ).toEqual([]);
  });
});

/**
 * **A vitest project no CI task names is a project nobody runs.**
 *
 * The sibling above holds three task keys equal to each other, and its comment used to justify that by
 * asserting `test` and `test:node` "run the same vitest for every package in the register". That was
 * false, and the false half is the interesting one: `@pithy-sh/ui-react` declares a `dom` project — the
 * rendering tests for the sign-in screen an adopter meets first — and its `test:node` named `--project=node`
 * alone. CI runs `turbo run test:node test:workers` and never `test`, so eleven test files were collected
 * by nobody for as long as that stood. Nothing was red. There was nothing to be red.
 *
 * So the premise is asserted rather than written down. Every project is asked of vitest itself
 * (`vitest list --filesOnly --json`, which reports the project each collected file belongs to) and the
 * task list is read out of the workflow, because a package's own scripts cannot say which of them CI
 * calls. A task that names no `--project` runs them all, which is how `@pithy-sh/cli` — one unnamed
 * project, `test:node` spelled `vitest run` — passes without being an exception.
 */

/**
 * Two at a time, and the budget that pays for it.
 *
 * Each package is one short-lived `vitest list`, which still loads that package's config — a workers
 * config takes about a second and a half of it. Twenty-two at once is a runner's memory; four at once,
 * measured, starved the rest of this suite badly enough to time out three of its own siblings. Two, with
 * a budget of its own, costs about half a minute and takes nothing from anybody.
 */
const LIST_CONCURRENCY = 2;

/** How long the sweep may take. `UNIT_BUDGETS`' 60s is a per-test budget, and this test is twenty-two spawns. */
const LIST_BUDGET = 300_000;

/**
 * The test tasks CI runs, read out of the workflow rather than written down here a second time.
 *
 * `test` is deliberately not among them, which is the whole reason this sweep exists: the task a
 * developer runs locally is not the task that gates a merge, so what `test` covers proves nothing.
 */
function ciTestTasks(): string[] {
  const workflow = readFileSync(join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8");
  const found = new Set<string>();
  for (const line of workflow.split("\n")) {
    const invocation = /\bturbo\S*\s+run\s+((?:test[\w:]*\s+)+)/.exec(line);
    if (invocation === null) continue;
    for (const task of (invocation[1] as string).trim().split(/\s+/)) found.add(task);
  }
  return [...found].sort();
}

/**
 * Every vitest project holding at least one test file in `directory`, as vitest itself lists them.
 *
 * The empty string is a package whose config declares one project and gives it no name — real, and
 * unnameable by a `--project=` filter, so the only task that can cover it is one that filters nothing.
 * The package's own `node_modules/.bin/vitest` rather than a package runner: the same reach as
 * {@link TURBO} above, and it resolves the version the package actually tests with.
 */
async function vitestProjects(directory: string): Promise<Set<string>> {
  const vitest = join(directory, "node_modules", ".bin", "vitest");
  const { stdout } = await run(vitest, ["list", "--filesOnly", "--json"], {
    cwd: directory,
    maxBuffer: 64 * 1024 * 1024,
  });
  const at = stdout.search(/^\[$/m);
  if (at === -1) throw new Error(`${fromRoot(directory)}: vitest listed no files as JSON`);
  const listed = JSON.parse(stdout.slice(at)) as { file: string; projectName?: string }[];
  return new Set(listed.map((entry) => entry.projectName ?? ""));
}

/** What `tasks` cover in a package with these `scripts`: every project, or the ones they name. */
function ciCoverage(scripts: Record<string, string>, tasks: readonly string[]): { all: boolean; named: Set<string> } {
  let all = false;
  const named = new Set<string>();
  for (const task of tasks) {
    const script = scripts[task];
    if (script === undefined) continue;
    const filters = [...script.matchAll(/--project[= ](\S+)/g)].map((match) => match[1] as string);
    if (filters.length === 0) all = true;
    for (const filter of filters) named.add(filter);
  }
  return { all, named };
}

describe("every vitest project a package declares is a project CI runs", () => {
  test(
    "no project's test files are collected by a task no merge gate calls",
    async () => {
      const tasks = ciTestTasks();
      expect(tasks, "no `turbo run test…` invocation in the CI workflow — the sweep has nothing to check").toContain(
        "test:node",
      );
      expect(tasks, "CI runs `test` now, and this sweep's premise has moved with it").not.toContain("test");

      const packages = readdirSync(join(REPO_ROOT, "packages")).sort();
      expect(packages.length, "no packages found at all").toBeGreaterThan(15);

      const unrun: string[] = [];
      const seen = new Set<string>();
      for (let index = 0; index < packages.length; index += LIST_CONCURRENCY) {
        await Promise.all(
          packages.slice(index, index + LIST_CONCURRENCY).map(async (name) => {
            const directory = join(REPO_ROOT, "packages", name);
            const manifest = join(directory, "package.json");
            if (!existsSync(manifest)) return;
            const scripts = (JSON.parse(readFileSync(manifest, "utf8")) as { scripts?: Record<string, string> })
              .scripts;
            if (scripts?.test === undefined) return;
            const projects = await vitestProjects(directory);
            for (const project of projects) seen.add(project);
            const { all, named } = ciCoverage(scripts, tasks);
            if (all) return;
            for (const project of projects) {
              if (!named.has(project)) unrun.push(`packages/${name} → ${project === "" ? "<unnamed>" : project}`);
            }
          }),
        );
      }

      expect(unrun, "these vitest projects hold test files and no task CI runs collects them").toEqual([]);
      // The floor. An empty answer above is also what a sweep that stopped listing anything would give,
      // and `dom` is the project this gate exists for — the one CI was not running.
      expect([...seen], "the sweep no longer sees the project that went unrun").toContain("dom");
    },
    LIST_BUDGET,
  );
});
