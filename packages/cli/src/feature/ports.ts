import { execFile } from "node:child_process";
import { open, readFile, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { writeFileAtomic } from "../project/atomic";

const execFileAsync = promisify(execFile);

/** First port of block 0. */
export const BASE_PORT = 8787;
/** Ports per feature block. */
export const BLOCK_SIZE = 10;

/** How many times `withLock` retries acquiring the lock before giving up. */
const LOCK_MAX_ATTEMPTS = 50;
/** Delay between lock-acquire retries, in ms. */
const LOCK_RETRY_DELAY_MS = 100;

/** A contiguous block of ports assigned to one feature branch. */
export interface PortBlock {
  /** The block index (0-based). */
  block: number;
  /** The first port in the block. */
  base: number;
  /** How many ports the block spans. */
  size: number;
}

/** The registry file shape: branch name → its allocated block. */
export interface PortsRegistry {
  [branch: string]: PortBlock;
}

/** Inputs to `allocatePortBlock`. */
export interface AllocateOptions {
  /** Absolute path to the .dev-ports.json registry (at the main repo root). */
  registryPath: string;
  /** The feature branch key, e.g. "feature/69-media-cli". */
  branch: string;
  /** Ports per block (default BLOCK_SIZE). */
  size?: number;
}

/** Inputs to `freePortBlock`. */
export interface FreeOptions {
  /** Absolute path to the .dev-ports.json registry (at the main repo root). */
  registryPath: string;
  /** The feature branch key to release. */
  branch: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/** Acquire an advisory lock on `${registryPath}.lock`, retrying until it succeeds or times out. */
async function acquireLock(registryPath: string): Promise<string> {
  const lockPath = `${registryPath}.lock`;
  for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt++) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.close();
      return lockPath;
    } catch {
      await sleep(LOCK_RETRY_DELAY_MS);
    }
  }
  throw new InternalError({
    message: "Could not lock the port registry.",
    action: "Another pithy process may be allocating ports. Retry in a moment.",
    detail: `Timed out acquiring ${lockPath} after ${LOCK_MAX_ATTEMPTS} attempts.`,
  });
}

/** Release the advisory lock, swallowing any error (e.g. already removed). */
async function releaseLock(lockPath: string): Promise<void> {
  await unlink(lockPath).catch(() => {});
}

/** Run `fn` while holding the advisory lock on `registryPath`, always releasing it after. */
async function withLock<T>(registryPath: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = await acquireLock(registryPath);
  try {
    return await fn();
  } finally {
    await releaseLock(lockPath);
  }
}

/** Read the registry file. A missing file is an empty registry. Invalid JSON/shape throws `InternalError`. */
async function readRegistry(registryPath: string): Promise<PortsRegistry> {
  let raw: string;
  try {
    raw = await readFile(registryPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw new InternalError({
      message: "Could not read the port registry.",
      action: "Check permissions on .dev-ports.json.",
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new InternalError({
      message: "The port registry is corrupt.",
      action: "Delete .dev-ports.json and re-run pithy feature create to rebuild it.",
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new InternalError({
      message: "The port registry is corrupt.",
      action: "Delete .dev-ports.json and re-run pithy feature create to rebuild it.",
      detail: `Expected a JSON object at ${registryPath}.`,
    });
  }

  return parsed as PortsRegistry;
}

/** Write the registry file atomically as pretty-printed JSON with a trailing newline. */
async function writeRegistry(registryPath: string, registry: PortsRegistry): Promise<void> {
  await writeFileAtomic(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
}

/** The lowest non-negative integer not present in `taken`. */
function lowestFreeBlock(taken: ReadonlySet<number>): number {
  let i = 0;
  while (taken.has(i)) {
    i++;
  }
  return i;
}

/**
 * Allocate (or return the existing) port block for a branch, under a file lock. Idempotent: if the
 * branch already has a block, returns it unchanged. Otherwise assigns the LOWEST free block index not
 * overlapping any taken block, writes the registry atomically, and returns it.
 */
export async function allocatePortBlock(options: AllocateOptions): Promise<PortBlock> {
  const { registryPath, branch } = options;
  const size = options.size ?? BLOCK_SIZE;

  return withLock(registryPath, async () => {
    const registry = await readRegistry(registryPath);

    const existing = registry[branch];
    if (existing) {
      return existing;
    }

    const taken = new Set(Object.values(registry).map((entry) => entry.block));
    const block = lowestFreeBlock(taken);
    const allocated: PortBlock = { block, base: BASE_PORT + block * size, size };

    registry[branch] = allocated;
    await writeRegistry(registryPath, registry);

    return allocated;
  });
}

/**
 * Re-register blocks that a worktree already holds but the registry has lost, under the lock.
 *
 * `.dev-ports.json` is git-ignored, so it can vanish — a fresh clone, a stray clean — while the worktrees
 * that were allocated from it still exist and still have their ports pinned in `.dev.config.json`. Without
 * this, the next allocation would restart at block 0 and hand out a block a live feature is already using.
 * Reclaiming those blocks first makes the registry self-healing.
 *
 * Only fills gaps: a branch already in the registry is left exactly as it is, so this never overwrites a
 * live allocation. Returns the branches it re-registered.
 */
export async function reclaimPortBlocks(options: {
  /** The central registry path. */
  registryPath: string;
  /** Blocks observed on disk, one per existing worktree. */
  reservations: { branch: string; block: PortBlock }[];
}): Promise<string[]> {
  if (options.reservations.length === 0) return [];

  return withLock(options.registryPath, async () => {
    const registry = await readRegistry(options.registryPath);
    const reclaimed: string[] = [];
    for (const { branch, block } of options.reservations) {
      if (branch in registry) continue; // a live allocation always wins.
      registry[branch] = block;
      reclaimed.push(branch);
    }
    if (reclaimed.length > 0) await writeRegistry(options.registryPath, registry);
    return reclaimed;
  });
}

/** Free a branch's block under the lock (idempotent: a missing branch/registry is a no-op). */
export async function freePortBlock(options: FreeOptions): Promise<void> {
  const { registryPath, branch } = options;

  await withLock(registryPath, async () => {
    const registry = await readRegistry(registryPath);
    if (!(branch in registry)) {
      return;
    }
    delete registry[branch];
    await writeRegistry(registryPath, registry);
  });
}

/** Resolve the .dev-ports.json path from any cwd (main checkout or a worktree) via git-common-dir. */
export async function resolvePortsRegistryPath(cwd: string): Promise<string> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("git", ["rev-parse", "--git-common-dir"], { cwd }));
  } catch (err) {
    throw new InternalError({
      message: "Could not resolve the repo's git directory.",
      action: "Run pithy from inside a git repository.",
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  const commonDir = stdout.trim();
  const absoluteCommonDir = isAbsolute(commonDir) ? commonDir : resolve(cwd, commonDir);
  const mainRoot = dirname(absoluteCommonDir);

  return join(mainRoot, ".dev-ports.json");
}
