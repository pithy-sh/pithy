// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fromZodError, InternalError } from "@pithy-sh/core/src/error/pithyError";
import { z } from "zod";
import { writeFileAtomic } from "../project/atomic";
import type { WorkerTarget } from "../project/workers";
import type { PortBlock } from "./ports";

/**
 * The per-feature dev config — a git-ignored `.dev.config.json` at the worktree root, written once by
 * `pithy feature create` and fixed for the life of the feature.
 *
 * It exists because `.dev.vars` is a single file shared repo-wide across every worktree (each worktree's
 * copy is a symlink to the main checkout's), so it cannot carry per-feature values without one feature
 * clobbering another. This file is that per-feature surface.
 *
 * Ports are **assigned here at creation time, not discovered at startup** — that is the whole point.
 * Probing for a free port when a worker boots is a time-of-check/time-of-use race: two `pithy dev`
 * processes in two worktrees can both see the same port free and both try to bind it. Pre-assigning every
 * worker its own port from the feature's reserved block makes N features run simultaneously with no
 * probing, no race, and stable addresses each worker can use to auto-wire to its siblings.
 *
 * It is named for what it is — the feature's dev config — not for ports alone, so later per-feature dev
 * settings land here too without a rename.
 */

/** One worker's fixed local endpoint for the life of the feature. */
export const DevWorkerConfig = z
  .object({
    port: z.number().int().positive().describe("The port this worker binds locally, reserved at feature creation."),
    origin: z.string().describe("The origin sibling workers reach this one at, e.g. http://localhost:8787."),
  })
  .describe("One worker's fixed local endpoint within its feature's reserved port block.");
export type DevWorkerConfig = z.output<typeof DevWorkerConfig>;

/** The feature's reserved slice of the central port registry. */
export const DevPortBlock = z
  .object({
    index: z.number().int().nonnegative().describe("The block's index in the central .dev-ports.json registry."),
    base: z.number().int().positive().describe("The first port in the block."),
    size: z.number().int().positive().describe("How many ports the block spans — its worker capacity."),
  })
  .describe("The contiguous port block this feature owns, allocated from the central registry.");
export type DevPortBlock = z.output<typeof DevPortBlock>;

/** The `.dev.config.json` document. */
export const DevConfig = z
  .object({
    version: z.literal(1).describe("Dev-config schema version."),
    branch: z.string().describe("The feature branch this config belongs to, e.g. feature/69-media-cli."),
    ports: DevPortBlock.describe("The feature's reserved port block."),
    workers: z
      .record(z.string(), DevWorkerConfig)
      .describe("Each worker's fixed endpoint, keyed by worker name — the map pithy dev starts from."),
  })
  .describe("A feature's per-worktree dev configuration (git-ignored): its reserved ports and per-worker endpoints.");
export type DevConfig = z.output<typeof DevConfig>;

/** The dev-config path for a worktree: `<worktreeDir>/.dev.config.json`. */
export function devConfigPath(worktreeDir: string): string {
  return join(worktreeDir, ".dev.config.json");
}

/**
 * Build the feature's dev config: one port per worker, drawn from the reserved block.
 *
 * **Assignment is sticky.** A worker that already has a port in `previous` keeps it, whatever the current
 * discovery order — worker discovery is alphabetical, so a purely positional assignment would renumber every
 * later worker the moment someone adds one that sorts earlier, moving addresses out from under a running dev
 * session. Only genuinely new workers are assigned, each taking the lowest port in the block that nothing
 * else holds; a worker that goes away releases its port back to the block for reuse.
 *
 * Fails when the feature has more workers than its block holds rather than spilling into the next feature's
 * ports — a silent overlap is exactly the collision the block allocation exists to prevent.
 */
export function buildDevConfig(args: {
  branch: string;
  block: PortBlock;
  workers: WorkerTarget[];
  /** The feature's current dev config, whose worker→port pairs are preserved. Omit on first creation. */
  previous?: DevConfig | null;
}): DevConfig {
  if (args.workers.length > args.block.size) {
    throw new InternalError({
      message: `This feature has ${args.workers.length} workers but its port block holds only ${args.block.size}.`,
      // The count includes each composed capability's host Worker, which `pithy dev` starts beside the
      // `apps/*` set — so removing a capability is as much a fix here as removing a Worker.
      action: "Remove a worker or a capability, or widen the feature port-block size.",
    });
  }

  const inBlock = (port: number): boolean => port >= args.block.base && port < args.block.base + args.block.size;
  const kept = new Map<string, number>();
  for (const worker of args.workers) {
    // Carry a port over only when it still falls inside the block (a resized or reallocated block invalidates it).
    const port = args.previous?.workers[worker.name]?.port;
    if (port !== undefined && inBlock(port)) kept.set(worker.name, port);
  }

  const taken = new Set(kept.values());
  const nextFree = (): number => {
    for (let port = args.block.base; port < args.block.base + args.block.size; port += 1) {
      if (!taken.has(port)) return port;
    }
    // Unreachable: the worker-count guard above already bounds demand to the block's size.
    throw new InternalError({ detail: `No free port left in block ${args.block.block}.` });
  };

  const workers: Record<string, DevWorkerConfig> = {};
  for (const worker of args.workers) {
    let port = kept.get(worker.name);
    if (port === undefined) {
      port = nextFree();
      taken.add(port);
    }
    workers[worker.name] = { port, origin: `http://localhost:${port}` };
  }

  return {
    version: 1,
    branch: args.branch,
    ports: { index: args.block.block, base: args.block.base, size: args.block.size },
    workers,
  };
}

/** Zod-validate then write the dev config atomically (pretty JSON, trailing newline). */
export async function writeDevConfig(path: string, config: DevConfig): Promise<void> {
  const parsed = DevConfig.safeParse(config);
  if (!parsed.success) {
    throw fromZodError(parsed.error, {
      message: "The feature dev config is invalid.",
      action: "Re-run pithy feature create to rebuild .dev.config.json.",
    });
  }
  await writeFileAtomic(path, `${JSON.stringify(parsed.data, null, 2)}\n`);
}

/**
 * Every port block currently pinned on disk, read from each worktree's own `.dev.config.json` under
 * `<mainRoot>/.worktrees`. This is what lets a lost `.dev-ports.json` be rebuilt from the worktrees that
 * outlived it (see `reclaimPortBlocks`).
 * Unreadable or malformed configs are skipped rather than failing the scan — one bad worktree must not block
 * creating a new feature.
 */
export async function scanPinnedBlocks(mainRoot: string): Promise<{ branch: string; block: PortBlock }[]> {
  let entries: string[];
  try {
    entries = await readdir(join(mainRoot, ".worktrees"));
  } catch {
    return []; // no .worktrees yet — nothing to reclaim.
  }

  const found: { branch: string; block: PortBlock }[] = [];
  for (const entry of entries) {
    const config = await readDevConfig(devConfigPath(join(mainRoot, ".worktrees", entry))).catch(() => null);
    if (!config) continue;
    found.push({
      branch: config.branch,
      block: { block: config.ports.index, base: config.ports.base, size: config.ports.size },
    });
  }
  return found;
}

/** Read and validate the dev config, or `null` when the file does not exist. */
export async function readDevConfig(path: string): Promise<DevConfig | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (cause) {
    throw new InternalError({
      message: "The feature dev config is corrupt.",
      action: "Delete .dev.config.json and re-run pithy feature create.",
      detail: cause instanceof Error ? cause.message : String(cause),
    });
  }

  const parsed = DevConfig.safeParse(value);
  if (!parsed.success) {
    throw fromZodError(parsed.error, {
      message: "The feature dev config is invalid.",
      action: "Delete .dev.config.json and re-run pithy feature create.",
    });
  }
  return parsed.data;
}
