// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { join } from "node:path";
import { projectConfigDir, type StatePathOptions } from "../notifier/state";

/**
 * Where a dev session's log lives: `<config>/<project>/logs/dev.<branch>.<worker>.jsonl` — **outside
 * every checkout, one file per worker** (#671).
 *
 * **Why not in the repo.** It was `join(projectDir, "logs", "dev.log")`, which means `pithy feature
 * destroy` deletes the worktree and takes the session log with it — precisely the session you then want
 * to read back. That is #156's argument, unedited: *"a worktree with no secrets at all (#155), and an
 * `rm -rf` on a checkout taking every dev credential with it."* A log that outlives the worktree is the
 * whole reason to read one back. It also means there is nothing to gitignore, which matters because
 * `.gitignore`'s `*.log` is what ignored the old file — a rename to `.jsonl` inside the checkout would
 * have made the files untracked *and* unignored, one `git add -A` from committed.
 *
 * **This is #131's and #156's directory, resolved through the same {@link projectConfigDir}** —
 * `$PITHY_CONFIG_DIR`, then `%APPDATA%\pithy`, then `$XDG_CONFIG_HOME/pithy`, then `~/.config/pithy`.
 * Two implementations of "where does config live" is the defect shape, and the Windows branch is the
 * half a second one forgets. `logs/` is the fourth kind of file under that root and is held to the
 * root's existing rule: 0700 on the directory, owner-only on every file.
 *
 * **A stale `logs/dev.log` in somebody's checkout is left alone.** Nothing here deletes it, and `*.log`
 * still ignores it. `<project>/logs/` itself stays — `pithy seed` writes `logs/dev-login.json` there and
 * `pithy dev` reads it on every run — so the rule is that nothing `pithy dev` *logs* lands in a checkout,
 * not that the directory is gone.
 */

/** The subdirectory of `<config>/<project>/` the session logs sit in. Undotted: nothing here is hidden. */
export const DEV_LOG_DIR_NAME = "logs";

/** What every session log file is named `dev.` … `.jsonl` around. */
export const DEV_LOG_PREFIX = "dev.";
export const DEV_LOG_SUFFIX = ".jsonl";

/**
 * Every character a Windows filename may not hold, plus both path separators.
 *
 * `< > : " / \ | ? *` and the C0 control range are what `CreateFile` rejects outright, and `/` and `\`
 * are what would turn one segment into two on any platform. A branch name reaches this unfiltered — git
 * allows `/`, and `pithy dev` runs on whatever branch is checked out — so the replacement is by
 * construction rather than by a test on one platform: **Windows is unverified in this project**, and a
 * path that is merely untested on it must still be a path it could hold.
 *
 * Not covered, because they cannot arise: a trailing dot or space (git refuses both in a ref name, and
 * the suffix is `.jsonl` regardless), and a reserved device name — `CON`, `NUL`, `COM1` — which Windows
 * reads off the segment before the first dot, and that segment is always the literal `dev`.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the C0 range is exactly what a filename may not hold.
const UNSAFE_IN_FILENAME = /[\u0000-\u001f<>:"/\\|?*]/g;

/**
 * One path segment of a log filename: every path separator and every Windows-illegal character as `-`.
 *
 * **Lossy, deliberately, and the loss is documented rather than hashed away.** `feature/a-b` and
 * `feature/a/b` both become `feature-a-b`, so two such branches share one file — and because a session
 * truncates, the second one would truncate the first's log. `hash6` exists for exactly this class of
 * disambiguation, but spending it here would put a digest in every filename a developer reads and every
 * `--branch` value they type, to separate a pair the kit cannot create: `pithy feature create` composes
 * `feature/<issue>-<slug>` with exactly one `/` and a `kebab`ed slug, so no two branches it produces
 * collide. A hand-made pair can, and `docs/commands/dev.md` says so.
 */
export function devLogSegment(value: string): string {
  return value.replace(UNSAFE_IN_FILENAME, "-");
}

/**
 * The branch a log file is filed under, from the branch git reports — or `detached` off a branch.
 *
 * A detached HEAD is not a name, and the old path had nothing to key on at all. `detached` is a word a
 * branch could in principle also be called, which would share a file; the same acceptance as above.
 */
export function devLogBranch(branch: string | null | undefined): string {
  const named = branch === null || branch === undefined || branch.trim() === "" ? "detached" : branch;
  return devLogSegment(named);
}

/** `<config>/<project>/logs/` — the directory a session's files are written into and read back from. */
export function devLogDir(project: string, options: StatePathOptions = {}): string {
  return join(projectConfigDir(project, options), DEV_LOG_DIR_NAME);
}

/** `dev.<branch>.<worker>.jsonl`, both segments made filename-safe. */
export function devLogFileName(branch: string | null | undefined, worker: string): string {
  return `${DEV_LOG_PREFIX}${devLogBranch(branch)}.${devLogSegment(worker)}${DEV_LOG_SUFFIX}`;
}

/** The absolute path of one worker's session log on one branch. */
export function devLogFile(
  args: { project: string; branch: string | null | undefined; worker: string },
  options: StatePathOptions = {},
): string {
  return join(devLogDir(args.project, options), devLogFileName(args.branch, args.worker));
}

/**
 * Read a filename back into the branch and worker it was written for, or `null` when it is not one.
 *
 * **Split from the right, because a branch may hold a dot and a worker may not.** `release/1.2` is a
 * legal branch and slugs to `release-1.2`; a Worker name is `[a-z0-9]+(-[a-z0-9]+)*` (`WORKER_NAME` in
 * `project/scaffold.ts`), so the last dotted segment before `.jsonl` is the worker and everything
 * between `dev.` and it is the branch. Reading left-to-right would hand `release` back as the branch.
 */
export function parseDevLogFileName(name: string): { branch: string; worker: string } | null {
  if (!name.startsWith(DEV_LOG_PREFIX) || !name.endsWith(DEV_LOG_SUFFIX)) return null;
  const middle = name.slice(DEV_LOG_PREFIX.length, -DEV_LOG_SUFFIX.length);
  const split = middle.lastIndexOf(".");
  if (split <= 0 || split === middle.length - 1) return null;
  return { branch: middle.slice(0, split), worker: middle.slice(split + 1) };
}
