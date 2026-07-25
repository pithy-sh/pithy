import { join } from "node:path";
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
 */
export async function syncFeatureDevConfig(options: SyncFeatureOptions): Promise<SyncReport> {
  // Rebuild any registry entry lost since the worktrees were created before reserving, so a fresh registry
  // can never hand out a block a live feature still holds.
  const registryPath = join(options.mainRoot, ".dev-ports.json");
  await reclaimPortBlocks({ registryPath, reservations: await scanPinnedBlocks(options.mainRoot) });

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
