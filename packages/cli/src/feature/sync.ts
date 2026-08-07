// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { access } from "node:fs/promises";
import { join } from "node:path";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { discoverWorkers as discoverWorkersDefault, type WorkerTarget } from "../project/workers";
import {
  buildDevConfig,
  type DevConfig,
  devConfigPath,
  readDevConfig,
  scanPinnedBlocks,
  writeDevConfig,
} from "./devConfig";
import { wireFeatureDevVars } from "./devVars";
import { allocatePortBlock, type PortBlock, reclaimPortBlocks } from "./ports";

/**
 * Reconcile a feature's worktree with the workers actually in it — the operation behind `pithy feature sync`
 * and the shared middle of `pithy feature create`.
 *
 * Adding a worker to a feature is a normal thing to do, and it must not require re-running creation or
 * re-typing the feature's identity. This re-discovers the worker set, gives any new worker a port from the
 * feature's *already reserved* block, and leaves every existing worker exactly where it was — so an addition
 * never moves a sibling's address, and never reaches into another feature's block.
 */

/** Whether a path exists. */
async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

/**
 * Whether a pinned block still belongs to a worktree that exists.
 *
 * Reclaim rebuilds a lost registry from the blocks worktrees still hold, so it must only re-register blocks
 * a **live** feature is using. `pithy feature destroy` prunes a worktree by dropping its gitlink and pruning
 * the registration — never a recursive delete (CLAUDE.md) — so a torn-down worktree is a directory with no
 * `.git`. Re-registering its block would hand a destroyed feature its ports back forever.
 *
 * Judged only where a positive answer is possible: a directory that is not where this branch's worktree
 * would live says nothing about liveness, so it stays reclaimable. Only "the directory is there and its
 * gitlink is gone" is treated as dead — the one state teardown leaves behind.
 */
async function isLiveWorktree(mainRoot: string, branch: string): Promise<boolean> {
  const dir = join(mainRoot, ".worktrees", branch.replace(/^feature\//, ""));
  if (!(await exists(dir))) return true;
  return exists(join(dir, ".git"));
}

/** The outcome of a sync: the reconciled config plus what actually changed. */
export interface SyncReport {
  /** The feature branch. */
  branch: string;
  /** The feature's reserved port block. */
  block: PortBlock;
  /** The reconciled dev config. */
  dev: DevConfig;
  /** Workers that gained a port on this run. */
  added: string[];
  /** Workers that went away and released their port. */
  removed: string[];
}

/** Options for {@link syncFeatureDevConfig}. */
export interface SyncFeatureOptions {
  /** The main checkout root — where the central port registry lives. */
  mainRoot: string;
  /** The worktree to reconcile. */
  worktreePath: string;
  /** The feature branch, the registry's key. */
  branch: string;
  /** Ports per block, when a block still has to be reserved. */
  blockSize?: number;
  /** Worker-discovery seam (default: `discoverWorkers`). */
  discoverWorkers?: (projectDir: string) => Promise<WorkerTarget[]>;
}

/**
 * Reconcile the feature's `.dev.config.json` with its current workers, then re-point every worker's
 * `.dev.vars` at the repo's shared file. Idempotent: with no worker changes it rewrites the same config and
 * reports nothing added or removed. The port block is reserved on first use and reused thereafter, so a
 * feature's ports are stable for its whole life.
 *
 * Refuses to run when `worktreePath` is the main checkout root. `pithy feature sync` derives its identity
 * from the current branch and takes no path argument, so running it from the main checkout while on a
 * feature branch is a plausible slip: it would reserve a port block against the main checkout, write a
 * feature's `.dev.config.json` at the project root, and point every worker there at a file it already
 * owns. The main checkout is not a feature, and none of that is recoverable by re-running anything.
 *
 * It no longer guards the `.dev.vars` files themselves. `wireFeatureDevVars` used to `unlink` and replace
 * every real `apps/*.dev.vars` it found, which permanently lost git-ignored content, and this guard was
 * the only thing standing in front of it — for one caller. It now leaves a real file alone and reports it,
 * so the loss is closed at the source, for every caller. This guard stays because syncing the main
 * checkout as a feature is still wrong, not because it is the last line of defence.
 */
export async function syncFeatureDevConfig(options: SyncFeatureOptions): Promise<SyncReport> {
  if (options.worktreePath === options.mainRoot) {
    throw new ValidationError({
      message: "Refusing to sync the main checkout as if it were a feature worktree.",
      action:
        "Run pithy feature sync from inside the feature's worktree (.worktrees/<issue>-<slug>), not the main checkout.",
      detail: `worktreePath (${options.worktreePath}) is the main repository root.`,
    });
  }

  // Rebuild any registry entry lost since the worktrees were created before reserving, so a fresh registry
  // can never hand out a block a live feature still holds. A destroyed feature's leftover config is not a
  // claim: reclaiming it would undo the teardown that just freed its block.
  const registryPath = join(options.mainRoot, ".dev-ports.json");
  const pinned = await scanPinnedBlocks(options.mainRoot);
  const reservations: typeof pinned = [];
  for (const reservation of pinned) {
    if (await isLiveWorktree(options.mainRoot, reservation.branch)) reservations.push(reservation);
  }
  await reclaimPortBlocks({ registryPath, reservations });

  const block = await allocatePortBlock({
    registryPath,
    branch: options.branch,
    ...(options.blockSize !== undefined ? { size: options.blockSize } : {}),
  });

  const workers = await (options.discoverWorkers ?? discoverWorkersDefault)(options.worktreePath);
  const configPath = devConfigPath(options.worktreePath);
  const previous = await readDevConfig(configPath);
  const dev = buildDevConfig({ branch: options.branch, block, workers, previous });
  await writeDevConfig(configPath, dev);

  await wireFeatureDevVars({ mainRoot: options.mainRoot, worktreePath: options.worktreePath, workers });

  const before = new Set(Object.keys(previous?.workers ?? {}));
  const after = new Set(Object.keys(dev.workers));
  return {
    branch: options.branch,
    block,
    dev,
    added: [...after].filter((name) => !before.has(name)),
    removed: [...before].filter((name) => !after.has(name)),
  };
}
