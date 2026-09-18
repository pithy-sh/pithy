// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

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
import { allocatePortBlock, type PortBlock, portsRegistryPath, reclaimPortBlocks } from "./ports";
import { heldReservations } from "./prune";

/**
 * Reconcile a feature's worktree with the workers actually in it — the operation behind `pithy feature sync`
 * and the shared middle of `pithy feature create`.
 *
 * Adding a worker to a feature is a normal thing to do, and it must not require re-running creation or
 * re-typing the feature's identity. This re-discovers the worker set, gives any new worker a port from the
 * feature's *already reserved* block, and leaves every existing worker exactly where it was — so an addition
 * never moves a sibling's address, and never reaches into another feature's block.
 */

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
  /** The main checkout root — the port registry's key, and the tree the worktree scan walks. */
  mainRoot: string;
  /** The registry file (default: `<config>/dev-ports.json`). A seam, so a test never writes the real one. */
  registryPath?: string;
  /** The worktree to reconcile. */
  worktreePath: string;
  /** The feature branch, the registry's key. */
  branch: string;
  /** Ports per block, when a block still has to be reserved. */
  blockSize?: number;
  /**
   * The branch this feature was cut from, whose local autostart answer a **new** block entry copies.
   *
   * Only the creating allocation reads it, so `pithy feature sync` on an existing feature can pass it
   * freely and never has its own answer overwritten by the branch it came from.
   */
  inheritAutostartFrom?: string;
  /** Worker-discovery seam (default: `discoverWorkers`). */
  discoverWorkers?: (projectDir: string) => Promise<WorkerTarget[]>;
}

/**
 * Reconcile the feature's `.dev.config.json` with its current workers. Idempotent: with no worker changes
 * it rewrites the same config and reports nothing added or removed. The port block is reserved on first use and reused thereafter, so a
 * feature's ports are stable for its whole life.
 *
 * Refuses to run when `worktreePath` is the main checkout root. `pithy feature sync` derives its identity
 * from the current branch and takes no path argument, so running it from the main checkout while on a
 * feature branch is a plausible slip: it would reserve a port block against the main checkout, write a
 * feature's `.dev.config.json` at the project root, and take a port block a real feature is holding. The
 * main checkout is not a feature, and none of that is recoverable by re-running anything.
 *
 * It touches no `.dev.vars` at all. It used to `unlink` and replace every real `apps/*.dev.vars` it found,
 * which permanently lost git-ignored content, and this guard was the only thing standing in front of it —
 * for one caller. A worktree generates its own from the same machine-local sources now (#154), so there is
 * nothing here to share and nothing to lose. This guard stays because syncing the main checkout as a
 * feature is still wrong, not because it is the last line of defense.
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
  // can never hand out a block a live feature still holds. Which pins still hold a block is prune's
  // question, answered by prune's predicate (#637): a second answer here is how a block prune keeps gets
  // handed out, or one it frees comes back. `destroy` removes the pin before freeing, so it leaves none.
  //
  // The path comes from the one resolver (#435). It was composed here, from `mainRoot`, which made this a
  // second derivation of a location that has exactly one — and a second derivation is how `create`/`sync`
  // end up writing one file while `destroy` frees a key in another, both exiting 0.
  const registryPath = options.registryPath ?? portsRegistryPath();
  const reservations = await heldReservations(options.worktreePath, await scanPinnedBlocks(options.mainRoot));
  await reclaimPortBlocks({ registryPath, root: options.mainRoot, reservations });

  const block = await allocatePortBlock({
    registryPath,
    root: options.mainRoot,
    branch: options.branch,
    ...(options.blockSize !== undefined ? { size: options.blockSize } : {}),
    ...(options.inheritAutostartFrom !== undefined ? { inheritAutostartFrom: options.inheritAutostartFrom } : {}),
  });

  const workers = await (options.discoverWorkers ?? discoverWorkersDefault)(options.worktreePath);
  const configPath = devConfigPath(options.worktreePath);
  const previous = await readDevConfig(configPath);
  const dev = buildDevConfig({ branch: options.branch, block, workers, previous });
  await writeDevConfig(configPath, dev);

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
