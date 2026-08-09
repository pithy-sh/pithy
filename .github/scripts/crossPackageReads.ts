/**
 * Finds the tests that assert about files outside their own package, and maps those files back to
 * the package whose suite has to run when they change.
 *
 * `turbo --affected` maps a changed file to the package that owns it and to that package's
 * dependents. That is the whole model, and it has one blind spot: **a test that asserts about
 * another package's files is invisible to it.** `packages/cli` is not a dependent of
 * `packages/leaderboard`, so editing `packages/leaderboard/pithy.manifest.json` plans no CLI job —
 * and the sweep in `capabilities/reconcile.test.ts` that exists to hold every shipped manifest to a
 * line width simply does not run on the change it guards. Green, and unverified.
 *
 * This is the second time that shape landed. #148 was the same defect on `templates/starter`, fixed
 * by hardcoding `^templates/` in the workflow, and #173 was found *on the branch that fixed it*. So
 * the list is not written down anywhere here either: it is derived from the tests themselves, every
 * run, and a cross-package read added tomorrow is planned tomorrow with no edit to this file.
 *
 * Derivation, in full. For every `*.test.ts` under a workspace package's `src/`, take each run of
 * adjacent string literals — `resolve(HERE, "../../../../templates/starter")` and
 * `join(HERE, "..", "..", "..")` are the two spellings in the tree, and a run covers both — resolve
 * it against the file's own directory, and keep it when it lands outside the package that owns the
 * file. That is a cross-package read, and the resolved path is what has to be watched.
 *
 * The resolved path must exist on disk, which is not a nicety. `testers/src/crypto/token.test.ts`
 * feeds `"../../../etc/passwd"` to a path-traversal guard as *hostile input*; it never opens it, and
 * it resolves to `packages/etc/passwd`, which is nothing. Requiring the target to exist is what
 * separates a path a test reads from a path a test rejects.
 *
 * It over-approximates on purpose. A target of `packages` (the tripwires in `atomic.test.ts` and the
 * migration-order scan really do walk every package's source) means any change under `packages/`
 * plans the CLI, and a target of `.` means any change at all does. Over-planning costs a job.
 * Under-planning costs the gate, silently, which is the failure this exists to end.
 *
 * Not turbo's `inputs`, and not `globalDependencies`. Measured on turbo 2.10.7:
 * `inputs: ["$TURBO_ROOT$/packages/*​/pithy.manifest.json"]` on the CLI's `test:node` changes the
 * task hash and nothing else — the affected set is byte-identical, because `--affected` never
 * consults task inputs. `globalDependencies` does reach the change mapper, but only for files no
 * package owns: `templates/**` there works and escalates to *all 23 packages*, while
 * `packages/*​/pithy.manifest.json` is ignored outright because those files already have an owner.
 * There is no turbo-native way to say "this path belongs to that package's tests", so the mapping is
 * made here and handed to the planner as extra `--filter` arguments.
 *
 * Usage:
 *
 *   bun .github/scripts/crossPackageReads.ts             # the record, for a human
 *   bun .github/scripts/crossPackageReads.ts --json      # every read, for a test
 *   git diff --name-only base HEAD | bun .github/scripts/crossPackageReads.ts --filters
 *
 * `--filters` is what CI runs: changed paths on stdin, `--filter=<package>` on stdout for every
 * package that asserts about one of them. No dependencies — two `node:` builtins and one relative
 * path, whose own imports are two more builtins — so the `plan` job can run it before `bun install`.
 * `planShards.ts` next door reaches the same module the same way, for the same reason (#211).
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isTestFile, readSource, sourcePaths } from "../../packages/cli/src/ci/sourceFiles";

/** One test file's read of a path outside the package that owns it. */
export type CrossPackageRead = {
  /** The package whose suite asserts about the path, e.g. `@pithy-sh/cli`. */
  package: string;
  /** That package's directory, relative to the repo root, e.g. `packages/cli`. */
  directory: string;
  /** The test file doing the reading, relative to the repo root. */
  file: string;
  /** What it resolves to, relative to the repo root. `.` is the repo root itself. */
  target: string;
};

/** `.github/scripts/` → the repository. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The workspace globs from the root `package.json`, minus their `/*`. */
const WORKSPACE_GROUPS = ["packages", "tooling", "apps"];

/**
 * A run of adjacent string literals separated only by commas — the arguments of one `join` or
 * `resolve` call. Written as one pattern rather than "find every literal" because `join(d, "..",
 * "..", "..")` climbs three levels and each literal alone climbs one; splitting them would report
 * `packages/cli/src` instead of `packages`, which is inside the package and would be dropped.
 */
const LITERAL_RUN = /(["'])((?:\\.|(?!\1)[^\\\n])*)\1(?:\s*,\s*(["'])((?:\\.|(?!\3)[^\\\n])*)\3)*/g;

/** One literal within a run. */
const LITERAL = /(["'])((?:\\.|(?!\1)[^\\\n])*)\1/g;

/**
 * Every `*.test.ts` under `dir`, recursively. Missing directories are simply empty.
 *
 * The traversal is `packages/cli/src/ci/sourceFiles.ts` — one walk for every reader of this tree's own
 * source, rather than one per reader (#185). Imported by relative path and importing nothing but
 * `node:fs` and `node:path` itself, so this script still runs before `bun install` — which is the whole
 * reason that module was placed where both `plan`-job scripts could reach it. `planShards.ts` next door
 * weighs the shards with the same call and the same constraint (#211).
 */
function testFiles(dir: string): string[] {
  return sourcePaths(dir, { keep: isTestFile });
}

/** Every workspace package directory, absolute. */
function packageDirs(root: string): string[] {
  const dirs: string[] = [];
  for (const group of WORKSPACE_GROUPS) {
    let entries: string[];
    try {
      entries = readdirSync(join(root, group));
    } catch {
      continue; // `apps/` does not exist yet. The workspace glob still declares it.
    }
    for (const name of entries) {
      const dir = join(root, group, name);
      if (statSync(dir).isDirectory()) dirs.push(dir);
    }
  }
  return dirs.sort();
}

/** A path relative to the repo root, in POSIX form. `.` for the root itself. */
function fromRoot(root: string, path: string): string {
  return relative(root, path).split(sep).join("/") || ".";
}

/** Every cross-package read in the tree, sorted and deduplicated. */
export function crossPackageReads(root: string = REPO_ROOT): CrossPackageRead[] {
  const found = new Map<string, CrossPackageRead>();
  for (const dir of packageDirs(root)) {
    let name: string;
    try {
      name = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name as string;
    } catch {
      continue;
    }
    for (const file of testFiles(join(dir, "src"))) {
      // A test file removed between the listing and this read is not a test file that reads anything.
      const source = readSource(file);
      if (source === null) continue;
      for (const [run] of source.matchAll(LITERAL_RUN)) {
        const segments = [...run.matchAll(LITERAL)].map((match) => match[2] as string);
        // Only a run that starts by climbing can leave the package.
        if (!segments[0]?.startsWith("..")) continue;
        const target = resolve(dirname(file), ...segments);
        if (!relative(dir, target).startsWith("..")) continue; // still inside its own package
        // Hostile input, not a read: `"../../../etc/passwd"` resolves to nothing on disk.
        try {
          statSync(target);
        } catch {
          continue;
        }
        const read: CrossPackageRead = {
          package: name,
          directory: fromRoot(root, dir),
          file: fromRoot(root, file),
          target: fromRoot(root, target),
        };
        // NUL separates the two halves because it is the one byte a path cannot hold, and it is
        // written as the escape rather than typed. A raw one here is what made git call this file
        // binary for its whole life: `Bin 10043 -> 10128 bytes` on every pull request, `-` in
        // `--numstat`, and not one line of it ever reviewable — including the two comments that
        // spent three commits asserting something false (#216, #211). Keep it two characters.
        found.set(`${read.file}\0${read.target}`, read);
      }
    }
  }
  return [...found.values()].sort((a, b) => a.file.localeCompare(b.file) || a.target.localeCompare(b.target));
}

/** Whether `changed` is `target` or sits under it. `.` is the repo root and matches everything. */
export function matches(target: string, changed: string): boolean {
  if (target === ".") return true;
  return changed === target || changed.startsWith(`${target}/`);
}

/**
 * The packages whose suites assert about at least one of `changed`, sorted. These are the packages
 * `--affected` will not plan on its own and that CI has to add by name.
 */
export function affectedByReads(changed: readonly string[], reads: readonly CrossPackageRead[]): string[] {
  const names = new Set<string>();
  for (const read of reads) {
    if (changed.some((path) => matches(read.target, path))) names.add(read.package);
  }
  return [...names].sort();
}

function main(): void {
  const reads = crossPackageReads();

  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(reads)}\n`);
    return;
  }

  if (process.argv.includes("--filters")) {
    const changed = readFileSync(0, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const names = affectedByReads(changed, reads);
    process.stdout.write(names.map((name) => `--filter=${name}`).join("\n"));
    if (names.length > 0) process.stdout.write("\n");
    return;
  }

  // The record. Grouped by what is read, because that is the question a reader arrives with:
  // "if I touch this path, whose tests run?"
  const byTarget = new Map<string, CrossPackageRead[]>();
  for (const read of reads) {
    const list = byTarget.get(read.target) ?? [];
    list.push(read);
    byTarget.set(read.target, list);
  }
  for (const target of [...byTarget.keys()].sort()) {
    const list = byTarget.get(target) as CrossPackageRead[];
    process.stdout.write(
      `${target === "." ? "<repo root>" : target}  →  ${[...new Set(list.map((r) => r.package))].join(", ")}\n`,
    );
    for (const read of list) process.stdout.write(`    ${read.file}\n`);
  }
}

main();
