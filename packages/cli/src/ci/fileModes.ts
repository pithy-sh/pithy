// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFileSync } from "node:child_process";
import { chmodSync, lstatSync } from "node:fs";
import { join } from "node:path";

/**
 * **The permission bits of this repository's own files, as a rule rather than as a habit.**
 *
 * `bun install` chmods `packages/cli/src/bin.ts` to `0777`. It is the only `bin` declared anywhere in
 * the workspace, `tooling/browser-scopes` depends on `@pithy-sh/cli`, and bun links a workspace bin by
 * symlinking `node_modules/.bin/pithy` straight at the source file — then makes the target executable
 * with a mode nobody chose. Not `0755`. `0777` (#345).
 *
 * Two harms, and they are not the same size.
 *
 * 1. **`rwxrwxrwx` on the program that reads an adopter's dev secrets and holds their Cloudflare
 *    credentials.** Any local account can rewrite it, and the next `pithy` the user runs is whatever
 *    that account wrote. This is the one that matters.
 * 2. **Every worktree dirty at birth.** git records the file `100644`, so `git status` reported
 *    `mode change 100644 => 100755` in a tree nobody had touched — six of thirteen worktrees on one
 *    machine at once. A tree that is dirty by default is how an unrelated change gets swept into
 *    somebody's commit, and this repository already carries that defect class.
 *
 * **The exec bit is wanted; `0777` is not.** `bin.ts` opens `#!/usr/bin/env bun` and is declared as a
 * `bin`, and bun's workspace link points at the source rather than at a shim, so
 * `node_modules/.bin/pithy` is only runnable if the source file itself is executable. Clearing the bit
 * would fix `git status` by breaking the link bun had just made. So git records `100755` and the rule
 * below keeps the mode narrow, rather than the other way round.
 *
 * ## The rule, frozen
 *
 * For every path git tracks, or that is written and not ignored:
 *
 * - **No other-write.** `0777`'s `o+w` is the whole security finding, and no umask a person actually
 *   runs produces it.
 * - **No setuid, setgid or sticky bit.** Nothing in a source tree has any use for one.
 * - **The exec bits agree with what git records** — set for `100755`, clear for `100644`. This is the
 *   half that keeps `git status` clean, and it only applies to a path git has an opinion about.
 * - **And a file git records executable is not group-writable either**, so the three programs in this
 *   tree that something else runs by path land at `0755` and no wider.
 *
 * **Group-write is permitted everywhere else, and that is a limit rather than a decision.** git checks a
 * file out at `0666 & ~umask`, so under this repository's own reproduction umask of `0002` all 2,368
 * ordinary tracked files land at `0664`. A rule banning `g+w` across the tree would be red on files git
 * itself had just written, red again after every `git switch` and every `git pull`, and muted within a
 * day — and a muted gate is the defect it was built to catch, shipping. So the tree-wide invariant is the
 * one that survives any umask a person runs, and the tighter one is spent where it costs least and buys
 * most: three files, rewritten by git only when they change, each of them a program.
 *
 * ## Where it runs
 *
 * Both halves, from one rule. {@link violations} is the gate in `./fileModes.test.ts`; {@link repair}
 * is what the repo root's `postinstall` runs, so the tree is corrected by the same command that breaks
 * it and an already-affected worktree is fixed by re-running `bun install` rather than by hand.
 *
 * **Builtins only, on purpose.** This module is executed by `bun install` itself, through
 * `scripts/fileModes.ts`. A bare specifier here would be resolved through the very `node_modules` the
 * install is still assembling, which is the one import graph a postinstall hook cannot assume. It is
 * also why the errors below are plain — this is build-time tooling in the same class as
 * `scripts/worktree.ts`, not the shipped runtime that owes a `PithyError`.
 */

/** What `git ls-files -s` writes for a regular file. */
const RECORDED_REGULAR = "100644";

/** And for one git records executable. */
const RECORDED_EXECUTABLE = "100755";

/** The byte `-z` separates paths with. Never a literal one; a path may hold anything else. */
const NUL = String.fromCharCode(0);

/** Every permission bit a chmod can carry, `setuid` through `other-execute`. */
const PERMISSIONS = 0o7777;

/** setuid, setgid and sticky. Nothing in a source tree has any use for one. */
const SPECIAL = 0o7000;

/** Write for other. The whole of the security finding in #345, and no umask anyone runs produces it. */
const OTHER_WRITE = 0o002;

/** Write for group. Refused on a file git records executable, permitted on the rest. See above. */
const GROUP_WRITE = 0o020;

/** The three execute bits. */
const EXECUTE = 0o111;

/** The owner's, which is the one a file git records executable always gets back. */
const OWNER_EXECUTE = 0o100;

/** The three read bits — where an execute bit belongs, when one belongs at all. */
const READ = 0o444;

/** One path, what git records about it, and what the filesystem says. */
export interface TrackedFile {
  /** Repository-relative, forward slashes, exactly as git wrote it. */
  readonly path: string;
  /**
   * Whether git records the file executable, or `null` for a path git records nothing about — one
   * that is written and not ignored, and so has no recorded mode to agree with yet.
   */
  readonly recorded: boolean | null;
  /** The on-disk permission bits, or `null` when the path was not there to stat. */
  readonly mode: number | null;
}

/** Run git in `root` and hand back what it wrote. */
function git(root: string, args: string[]): string[] {
  const written = execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return written.split(NUL).filter((entry) => entry !== "");
}

/**
 * What git records for one index entry.
 *
 * **An unrecognised mode throws rather than being skipped.** git can record a symlink (`120000`) and a
 * submodule (`160000`), and this repository has neither; the rule above has no sentence about either
 * one, and a gate that quietly drops what it has no rule for is a gate that shrinks as the tree grows.
 * Whoever adds the first one gets to decide what the rule is, once, out loud.
 */
export function recordedExecutable(mode: string, path: string): boolean {
  if (mode === RECORDED_REGULAR) return false;
  if (mode === RECORDED_EXECUTABLE) return true;
  throw new Error(`git records ${path} as mode ${mode}, and packages/cli/src/ci/fileModes.ts has no rule for it.`);
}

/** `path`'s permission bits, or `null` if it is not there. `lstat`, so a link is never followed. */
function onDisk(path: string): number | null {
  try {
    return lstatSync(path).mode & PERMISSIONS;
  } catch {
    return null;
  }
}

/**
 * Every path git carries: the index, **plus what is written and not ignored**.
 *
 * The index alone would make the world-writable half of the rule one run late by construction — a file
 * exists before anything stages it, and the pre-commit hook runs Biome rather than this suite. The
 * second listing closes that, and closes it without noise: `--exclude-standard` drops `node_modules`,
 * `dist`, and the whole-project scaffolds this repository's own suites write into `packages/cli/.smoke-*`
 * and `.e2e-*`. The same argument `sourceFiles.test.ts` makes about a NUL byte, about a mode.
 */
export function trackedFiles(root: string): TrackedFile[] {
  const found: TrackedFile[] = [];
  for (const entry of git(root, ["ls-files", "-s", "-z"])) {
    // `<mode> <sha> <stage>\t<path>` — and a path may hold a tab, so the first one ends the header.
    const tab = entry.indexOf("\t");
    if (tab < 0) throw new Error(`git ls-files -s wrote an entry with no path: ${entry}`);
    const path = entry.slice(tab + 1);
    const record = recordedExecutable(entry.slice(0, entry.indexOf(" ")), path);
    found.push({ path, recorded: record, mode: onDisk(join(root, path)) });
  }
  for (const path of git(root, ["ls-files", "-z", "--others", "--exclude-standard"])) {
    found.push({ path, recorded: null, mode: onDisk(join(root, path)) });
  }
  return found.sort((left, right) => (left.path < right.path ? -1 : 1));
}

/**
 * What `file` should have been, given what git records about it.
 *
 * **It only ever narrows.** For an ordinary file it is not `chmod 644`: forcing an absolute mode would
 * fight the umask of whoever ran it and then disagree with what `git checkout` writes on the next branch
 * switch, so only the bits the rule refuses are cleared and `0664` stays `0664`. For a file git records
 * executable there is an absolute answer, and it is `0755` — the exec bits go back wherever a read bit
 * is, group-write comes off, and `0777` lands where the issue asked for it. Running it twice changes
 * nothing either way.
 */
export function repairedMode(recordedExecutable: boolean, mode: number): number {
  const forbidden = SPECIAL | OTHER_WRITE | (recordedExecutable ? GROUP_WRITE : 0);
  const narrowed = mode & ~forbidden & ~EXECUTE;
  if (!recordedExecutable) return narrowed;
  // The owner's bit unconditionally, because a file git records executable and nobody can read — `0000`,
  // and the rest of that corner — would otherwise come back still not executable, which is the one thing
  // the repair was asked for. Everyone else gets one only where they already have a read bit.
  return narrowed | OWNER_EXECUTE | ((narrowed & READ) >> 2);
}

/** Why one file breaks the rule, in the words the gate prints. Null when it does not. */
export function offense(file: TrackedFile): string | null {
  if (file.mode === null) return null;
  const found: string[] = [];
  const octal = `0${file.mode.toString(8).padStart(3, "0")}`;
  if ((file.mode & SPECIAL) !== 0) found.push(`${octal} carries a setuid, setgid or sticky bit`);
  if ((file.mode & OTHER_WRITE) !== 0) found.push(`${octal} is world-writable`);
  if (file.recorded === true && (file.mode & GROUP_WRITE) !== 0) {
    found.push(`${octal} is group-writable and git records it executable`);
  }
  if (file.recorded !== null && ((file.mode & EXECUTE) !== 0) !== file.recorded) {
    const records = file.recorded ? "100755" : "100644";
    found.push(`${octal} is ${file.recorded ? "not " : ""}executable and git records it ${records}`);
  }
  return found.length === 0 ? null : found.join("; ");
}

/** Every file breaking the rule, path → why. Empty is what passing looks like. */
export function violations(files: readonly TrackedFile[]): Record<string, string> {
  const found: Record<string, string> = {};
  for (const file of files) {
    const why = offense(file);
    if (why !== null) found[file.path] = why;
  }
  return found;
}

/**
 * Narrow every file that breaks the rule, and say which ones those were.
 *
 * Only the offenders are touched. Chmodding all ~2,371 tracked files on every install would churn a
 * tree that is already correct and hide, in the noise, the one file that was not.
 */
export function repair(root: string): string[] {
  const fixed: string[] = [];
  for (const file of trackedFiles(root)) {
    if (file.mode === null || offense(file) === null) continue;
    chmodSync(join(root, file.path), repairedMode(file.recorded === true, file.mode));
    fixed.push(file.path);
  }
  return fixed;
}
