// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { type Dirent, readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";

/**
 * The one walk over this repository's own source.
 *
 * Several tripwires here read every source file in the tree and assert something about the set —
 * which modules can reach a `rename` (`project/atomic.test.ts`), which can probe with something that
 * follows a link or run a recursive delete (`project/scaffold.test.ts`), which can resolve an editor
 * (`platform/editor.test.ts`), which can export a pure value out of a Workers-runtime module
 * (`capabilities/configEntrypoints.test.ts`) — and both halves of CI's own planner read every test file,
 * one to work out which suites assert about which paths (`.github/scripts/crossPackageReads.ts`) and one
 * to weight the shards they are dealt into (`.github/scripts/planShards.ts`).
 *
 * Each of those had written its own traversal, which made each one a separate place to get the same
 * two things wrong. #157's was hardened when it was written and `atomic.test.ts`'s was not, so
 * `atomic.test.ts` kept the bug: `ENOENT … packages/cli/.smoke-OXGbGb/pithy.config.ts` on a full-suite
 * run (#185). A tripwire that flakes gets muted, and a muted tripwire is the defect it was built to
 * catch, shipping.
 *
 * **Both halves of that failure live here, once.**
 *
 * 1. **The tree is not still.** Other suites scaffold whole projects into `packages/cli/.smoke-*` and
 *    `.e2e-*` and delete them on the way out, and `.worktrees/` holds entire second checkouts of this
 *    repository. A dotted directory is skipped — `.github` excepted, because its scripts are source
 *    this repository runs its CI on — which removes most of that outright, and a directory that
 *    cannot be listed and a file that vanished between the listing and the read are both skipped
 *    rather than fatal. A file that is not there is not a file that breaks a rule.
 *    `packages/cli/templates/`, which appears and disappears around `bun pm pack`, is the one that
 *    cannot be dotted; see {@link VENDORED_TEMPLATES}. The dotted rule is the one thing a caller may
 *    turn off — `dotted: true`, off by default, for the caller asking about *shipped files* rather than
 *    about this tree's source; see {@link SourceWalk.dotted} (#215).
 * 2. **A symlink is not descended.** `withFileTypes` reports a link as a link rather than as the
 *    directory behind it, so a walk cannot loop on a link to an ancestor or read a package twice
 *    through the `node_modules` entry that points at it.
 *
 * Synchronous on purpose. It is read-only, it is called from tests and from the two CI scripts that run
 * before `bun install`, and the async form bought a sequential `await` per directory rather than any
 * concurrency. This module imports nothing but `node:fs` and `node:path` for the same reason: the
 * `plan` job in `ci.yml` has no install step, so its whole import graph has to be builtins and relative
 * paths. Adding a package dependency here breaks both scripts at once and is a change to that job.
 *
 * **That this is the only walk is a gate, not a claim.** #185 said it in a changeset and it was not true —
 * five private traversals were never migrated, and none of them received the ENOENT tolerance above or
 * #192's `templates` exclusion (#202). `sourceFiles.test.ts` now fails the build on any module that defines
 * a function which lists a directory and calls itself, with the handful that cannot reach this one written
 * down by name and reason. That list is now only the ones that *cannot*: `planShards.ts` was the last that
 * merely had not been, and its `statSync` was the #185 race sitting in the script the whole matrix hangs
 * off (#211).
 */

/** A file the walk found, with the text it still held when the walk read it. */
export interface SourceFile {
  /** Absolute path to the file. */
  readonly path: string;
  /** Its contents at the moment it was read. */
  readonly text: string;
}

/** How a walk narrows the tree — and, in one case, widens it. */
export interface SourceWalk {
  /** Directory names never descended into, on top of the built-in set. */
  readonly skip?: readonly string[];
  /** Which files to keep, by base name. Defaults to {@link isShippedSource}. */
  readonly keep?: (name: string) => boolean;
  /**
   * Enter dotted directories as well. **Off unless a caller says otherwise**, because the rule it lifts
   * is what keeps `.smoke-*`, `.e2e-*` and `.worktrees/` out of every other caller (#185).
   *
   * For the caller whose question is about *shipped files* rather than about this repository's source: a
   * licence audit asks that every file a template carries has the right header, and a template that grew
   * a `.vscode/` or a `.husky/` would ship every file in it unchecked. A gate whose reach is narrower
   * than the rule it enforces under-reports in silence (#215).
   *
   * It widens the dotted rule and nothing else. `node_modules`, `dist`, `coverage`, whatever the caller
   * named in `skip`, the vendored template copy and a symlinked directory are all still refused, and
   * `keep` still decides which files are taken.
   *
   * **It has no caller in this repository, deliberately, and it stays (#222).** The caller it was built
   * for is `tooling/license-headers`, which cannot import `@pithy-sh/cli` — #211 declined that edge on
   * direction of narrowing, since the linter that stamps this package's own headers running in
   * `lint-staged` must not become a dependent of the largest thing it lints. What the option buys is not
   * a call site. It is that the exception recorded against that walk in `./sourceFiles.test.ts` states a
   * true reason: #202's entry named the `templates` skip as the blocker and #211 found that false, and
   * the real blocker it recorded in its place — this walker cannot enter a dotted directory, and the
   * licence audit must — would be false in the other direction if this were removed. An exception list
   * whose reasons have quietly stopped being true is the failure mode #211 corrected, and removing the
   * option to re-add it with the edge would cost the same work twice. One branch, asserted where it is.
   */
  readonly dotted?: boolean;
}

/**
 * Never walked: dependencies, build output, coverage. Every other exclusion is the dotted rule, which
 * covers `.git`, `.turbo`, `.changeset`, `.worktrees`, and the test scaffolds this exists for.
 */
const NEVER = ["node_modules", "dist", "coverage"];

/** The one dotted directory that holds source: this repository's CI scripts. */
const DOTTED_SOURCE = ".github";

/**
 * The one transient the dotted rule cannot cover: `packages/cli/templates`, the copy of the repo root's
 * `templates/starter` that `prepack` vendors in and `postpack` takes out again.
 *
 * It cannot be dotted and it cannot move. `files` in the CLI's manifest carries exactly this path, and
 * that is the entire mechanism by which a published `@pithy-sh/cli` ships a starter at all (#143, #152).
 * So the walk skips it by where it is instead — by path, never by name, because the repo root's
 * `templates/` is the source of truth these tripwires exist to read.
 *
 * **Skipping is right whether or not a pack is in flight.** It is a file-by-file copy of a directory the
 * same walk already visits at the repo root, so descending into it can only ever report a source twice,
 * under a second path that `postpack` is about to delete — and a pack that fails after `prepack` leaves
 * the copy behind for good, gitignored and silent, which makes the duplicate permanent rather than
 * transient. Either way a gate that reports a path, counts files, or asserts a set gets a different
 * answer depending on what a packer did, and a report naming the copy names a file nobody can open (#192).
 */
const VENDORED_TEMPLATES = join("packages", "cli", "templates");

/** A `.ts` file that ships — neither a test nor a generated declaration. */
export function isShippedSource(name: string): boolean {
  return name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts");
}

/** A test file, in every spelling this repository uses — `x.test.ts` and `x.workers.test.ts` alike. */
export function isTestFile(name: string): boolean {
  return name.endsWith(".test.ts");
}

/** A walk with every default resolved, so {@link descend} decides nothing for itself. */
interface Walk {
  /** Directory names never descended into: the built-in set and the caller's own. */
  readonly skip: ReadonlySet<string>;
  /** Which files to keep, by base name. */
  readonly keep: (name: string) => boolean;
  /** Whether a dotted directory is entered. See {@link SourceWalk.dotted}. */
  readonly dotted: boolean;
}

/** Every file under `root` that `keep` accepts, absolute and sorted. A root that is not there is empty. */
export function sourcePaths(root: string, options: SourceWalk = {}): string[] {
  const walk: Walk = {
    skip: new Set([...NEVER, ...(options.skip ?? [])]),
    keep: options.keep ?? isShippedSource,
    dotted: options.dotted ?? false,
  };
  const found: string[] = [];
  descend(root, walk, found);
  return found.sort();
}

/** `path`'s contents, or null if it is no longer there — or was never readable. */
export function readSource(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Every file {@link sourcePaths} finds, with its text. One that vanished before the read is dropped. */
export function sourceFiles(root: string, options?: SourceWalk): SourceFile[] {
  const found: SourceFile[] = [];
  for (const path of sourcePaths(root, options)) {
    const text = readSource(path);
    if (text !== null) found.push({ path, text });
  }
  return found;
}

/** One directory, and everything below it. A directory that cannot be listed contributes nothing. */
function descend(directory: string, walk: Walk, into: string[]): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (walk.skip.has(entry.name)) continue;
      if (!walk.dotted && entry.name.startsWith(".") && entry.name !== DOTTED_SOURCE) continue;
      // Whatever root the walk began at, the path it built carries the ancestry that identifies the copy.
      if (path === VENDORED_TEMPLATES || path.endsWith(`${sep}${VENDORED_TEMPLATES}`)) continue;
      descend(path, walk, into);
      continue;
    }
    if (entry.isFile() && walk.keep(entry.name)) into.push(path);
  }
}
