// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { lstat, symlink, unlink } from "node:fs/promises";
import { join } from "node:path";
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

/** The outcome of {@link wireFeatureDevVars}: the shared file linked to, and every directory wired to it. */
export interface WireDevVarsResult {
  /** The shared `.dev.vars` in the main checkout that everything points at, or null when it has none. */
  source: string | null;
  /** The directories whose `.dev.vars` now symlink to the shared file. */
  wired: string[];
}

/**
 * Point the worktree — and each of its workers — at the main checkout's shared `.dev.vars`. A worker whose
 * directory *is* the worktree root is already covered by the worktree-root link. No-ops cleanly when the
 * main checkout has no `.dev.vars`. Idempotent: an existing file or stale link at a target is replaced, so
 * re-running re-points everything.
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
  if (!(await exists(source))) return { source: null, wired: [] };

  const wired: string[] = [];
  const targets = [options.worktreePath, ...options.workers.map((worker) => worker.dir)];
  for (const dir of new Set(targets)) {
    if (dir === options.mainRoot) continue; // never link the shared file to itself.
    await link(source, join(dir, ".dev.vars"));
    wired.push(dir);
  }
  return { source, wired };
}

/** Replace whatever is at `target` (file or stale link) with a symlink to `source`. */
async function link(source: string, target: string): Promise<void> {
  if (target === source) return;
  await unlinkIfPresent(target);
  await symlink(source, target);
}

/** Whether a path exists, following no links (a dangling symlink still counts as present). */
async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/** Remove a path if it exists (a stale file or link), so a fresh symlink can replace it. */
async function unlinkIfPresent(path: string): Promise<void> {
  if (await exists(path)) await unlink(path);
}
