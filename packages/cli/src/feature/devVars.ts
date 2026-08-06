// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { lstat, symlink, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import type { WorkerTarget } from "../project/workers";

/**
 * `.dev.vars` is **one shared file for the whole repo**: the main checkout owns it, and every worktree —
 * and every worker inside a worktree — symlinks to it. wrangler loads one `.dev.vars` from each worker's
 * own directory and does not merge, so the symlink is what gives every worker the same team secrets from a
 * single source of truth; editing the main checkout's file propagates everywhere at once, with no copies to
 * drift.
 *
 * That sharing is precisely why per-feature values do **not** live here — one feature's ports would clobber
 * another's. Those live in the per-worktree `.dev.config.json` ({@link ./devConfig}).
 */

/** The outcome of {@link wireFeatureDevVars}: the shared file linked to, and what happened at each target. */
export interface WireDevVarsResult {
  /** The shared `.dev.vars` in the main checkout that everything points at, or null when it has none. */
  source: string | null;
  /** The directories whose `.dev.vars` now symlink to the shared file. */
  wired: string[];
  /**
   * The directories left alone, because a real `.dev.vars` file is already there. Reported rather than
   * replaced — see the policy on {@link wireFeatureDevVars} — so a caller can say so.
   */
  kept: string[];
}

/**
 * Point the worktree — and each of its workers — at the main checkout's shared `.dev.vars`. A worker whose
 * directory *is* the worktree root is already covered by the worktree-root link. No-ops cleanly when the
 * main checkout has no `.dev.vars`.
 *
 * **A symlink is replaced; a real file is never deleted.** Replacing a link is what makes this idempotent
 * and what re-points a worktree after a rename, and a link holds nothing that is not in the file it points
 * at. A regular file holds the only copy of itself: `.dev.vars` is git-ignored, so what is deleted here is
 * gone from the machine and from history both. And every caller wires *every* worker it discovers, so one
 * command touching one worker used to rewrite the `.dev.vars` of all of them — `pithy worker add web` took
 * a secret only `apps/board` had, replaced it with the root file's contents, and exited 0 without a word.
 * Such a directory is reported in {@link WireDevVarsResult.kept} instead, so the adopter is told rather
 * than robbed.
 *
 * **The link is relative wherever one can reach.** An absolute link into the checkout survives nothing that
 * moves the tree — `mv`, `cp -a`, rsync, a Docker build context — and a dangling `.dev.vars` makes wrangler
 * report every secret absent while the file sits right there, which is the exact misleading failure the
 * wiring exists to end. Relative when the target is inside `mainRoot` (init, and every `.worktrees/<x>/`),
 * absolute only when the target genuinely lives outside the tree, where nothing relative could reach.
 */
export async function wireFeatureDevVars(options: {
  /** The main checkout root — owner of the one shared `.dev.vars`. */
  mainRoot: string;
  /** The worktree root to wire. */
  worktreePath: string;
  /** The workers discovered in the worktree. */
  workers: WorkerTarget[];
}): Promise<WireDevVarsResult> {
  const source = join(options.mainRoot, ".dev.vars");
  if (!(await exists(source))) return { source: null, wired: [], kept: [] };

  const wired: string[] = [];
  const kept: string[] = [];
  const targets = [options.worktreePath, ...options.workers.map((worker) => worker.dir)];
  for (const dir of new Set(targets)) {
    if (dir === options.mainRoot) continue; // never link the shared file to itself.
    const target = join(dir, ".dev.vars");
    if (await link({ source, target, mainRoot: options.mainRoot })) wired.push(dir);
    else kept.push(dir);
  }
  return { source, wired, kept };
}

/**
 * Point `target` at `source`, unless something that is not a symlink is already there. Answers whether the
 * link was made — false means a real file (or directory) was found and left untouched.
 */
async function link(options: { source: string; target: string; mainRoot: string }): Promise<boolean> {
  if (options.target === options.source) return false;
  const present = await lstatOrNull(options.target);
  if (present && !present.isSymbolicLink()) return false;
  if (present) await unlink(options.target);
  await symlink(linkPath(options.source, options.target, options.mainRoot), options.target);
  return true;
}

/**
 * How the link should spell its source: relative from the target's directory when the target lives inside
 * `mainRoot`, absolute otherwise. `relative` alone cannot answer it — it happily walks up out of the tree
 * with `../..`, which is exactly the link that breaks the moment either end moves independently.
 */
function linkPath(source: string, target: string, mainRoot: string): string {
  const inside = relative(mainRoot, target);
  if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) return source;
  return relative(dirname(target), source);
}

/** The `lstat` of a path, or null when nothing is there. Follows no links — the link itself is the answer. */
async function lstatOrNull(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(path);
  } catch {
    return null;
  }
}

/** Whether a path exists, following no links (a dangling symlink still counts as present). */
async function exists(path: string): Promise<boolean> {
  return (await lstatOrNull(path)) !== null;
}
