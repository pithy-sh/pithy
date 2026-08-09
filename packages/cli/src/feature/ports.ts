// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFile } from "node:child_process";
import { open, stat, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fromZodError, InternalError } from "@pithy-sh/core/src/error/pithyError";
import { z } from "zod";
import { writeFileAtomic } from "../project/atomic";
import { readOptionalFile } from "../project/readOptionalFile";

const execFileAsync = promisify(execFile);

/**
 * The remedy for a file that is there and would not open, chosen from the errno (#217).
 *
 * `readOptionalFile`'s `unreadable` is **every errno but `ENOENT`**. *Check permissions on X* answers
 * one of them, and a registry that is a directory, a symlink loop, or a failing disk got the same
 * sentence. See `manifest.ts` for the same helper over the same decision, and for why two copies are
 * under this repository's threshold for hoisting it.
 */
function unreadableAction(code: string | undefined, name: string): string {
  switch (code) {
    case "EACCES":
    case "EPERM":
      return `Check permissions on ${name}.`;
    case "EISDIR":
      return `${name} is a directory, not a file. Remove it, then re-run.`;
    case "ELOOP":
      return `${name} is a symlink loop. Replace it with a regular file, then re-run.`;
    default:
      return `${name} is there and would not open (${code ?? "unknown error"}). Check that file, then re-run.`;
  }
}

/** Read a property off an unknown throwable without widening anything to `any`. */
function prop(cause: unknown, key: string): unknown {
  if (typeof cause !== "object" || cause === null) return undefined;
  return (cause as Record<string, unknown>)[key];
}

/**
 * The remedy for a failed `git rev-parse`, chosen from the failure (#217).
 *
 * *Run pithy from inside a git repository* is right for one of the three ways this can fail, and it is
 * the one an adopter is least likely to be in — a machine without `git` on PATH fails to **spawn**, and
 * the sentence tells them to go somewhere they already are. Duck-typed on purpose: `execFile`'s rejection
 * is not required to be an `Error` subclass by anything the CLI controls, and its `code` is a string
 * errno for a spawn failure and a number for a non-zero exit.
 */
function gitResolveAction(cause: unknown): string {
  const code = prop(cause, "code");
  if (code === "ENOENT") return "Install git, or put it on PATH, then re-run.";
  const stderr = prop(cause, "stderr");
  const text = typeof stderr === "string" ? stderr : "";
  if (/not a git repository|this operation must be run in a work tree/i.test(text)) {
    return "Run pithy from inside a git repository.";
  }
  return "git rev-parse --git-common-dir failed. Run it here to see why, then re-run.";
}

/** First port of block 0. */
export const BASE_PORT = 8787;
/** Ports per feature block. */
export const BLOCK_SIZE = 10;

/** How many times `withLock` retries acquiring the lock before giving up. */
export const LOCK_MAX_ATTEMPTS = 50;
/** Delay between lock-acquire retries, in ms. */
export const LOCK_RETRY_DELAY_MS = 100;

/**
 * How long a caller is willing to wait for the lock. Both values default to the two constants above,
 * which are what every command uses; nothing in the CLI passes this.
 *
 * **It exists so a test can assert the rule rather than the clock** (#194). The one test that has to
 * *exhaust* the budget — a fresh lock must not be reclaimed, so every retry must fail — cost
 * `LOCK_MAX_ATTEMPTS × LOCK_RETRY_DELAY_MS`, which is 5000ms, which is vitest's default timeout to the
 * millisecond. It passed on an idle machine and failed on a busy one, having proved nothing that three
 * attempts at 10ms do not: the assertion is that a fresh lock survives a spent budget, and the size of
 * the budget is not part of it. Two unrelated numbers matching is what made it marginal, and a test one
 * scheduling hiccup from red now runs on every pull request (#173).
 */
export interface LockBudget {
  /** Attempts before giving up. Defaults to {@link LOCK_MAX_ATTEMPTS}. */
  maxAttempts?: number;
  /** Delay between attempts, in ms. Defaults to {@link LOCK_RETRY_DELAY_MS}. */
  retryDelayMs?: number;
}
/**
 * A lock file older than this is treated as abandoned, not held. A legitimate hold only ever spans one
 * registry read-modify-write — a single small JSON file, no network calls — so it never approaches this.
 * Anything this old can only be a lock a process left behind by dying mid-hold (Ctrl-C, SIGKILL), which
 * used to brick the registry — and, worse, block `feature destroy` teardown — forever. 30s leaves a wide
 * margin over real hold times while still recovering promptly.
 */
export const LOCK_STALE_MS = 30_000;

/** A contiguous block of ports assigned to one feature branch. */
export const PortBlock = z
  .object({
    block: z.number().int().nonnegative().describe("The block index (0-based)."),
    base: z.number().int().positive().describe("The first port in the block."),
    size: z.number().int().positive().describe("How many ports the block spans."),
  })
  .describe("A contiguous block of ports assigned to one feature branch.");
export type PortBlock = z.output<typeof PortBlock>;

/** The registry file shape: branch name → its allocated block. */
export const PortsRegistry = z
  .record(z.string(), PortBlock)
  .describe("The registry file shape: branch name → its allocated block.");
export type PortsRegistry = z.output<typeof PortsRegistry>;

/** Inputs to `allocatePortBlock`. */
export interface AllocateOptions {
  /** Absolute path to the .dev-ports.json registry (at the main repo root). */
  registryPath: string;
  /** The feature branch key, e.g. "feature/69-media-cli". */
  branch: string;
  /** Ports per block (default BLOCK_SIZE). */
  size?: number;
  /** How long to wait for the registry lock. Defaults to the production budget — see {@link LockBudget}. */
  lock?: LockBudget;
}

/** Inputs to `freePortBlock`. */
export interface FreeOptions {
  /** Absolute path to the .dev-ports.json registry (at the main repo root). */
  registryPath: string;
  /** The feature branch key to release. */
  branch: string;
  /** How long to wait for the registry lock. Defaults to the production budget — see {@link LockBudget}. */
  lock?: LockBudget;
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/** Identifying content written into a freshly-acquired lock file, so a stuck one can be diagnosed by hand. */
function lockContents(): string {
  return JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() });
}

/**
 * If `lockPath` is older than `LOCK_STALE_MS`, remove it so the next `open(lockPath, "wx")` attempt can
 * succeed. Staleness is judged from the file's own mtime, not its JSON content — the content write happens
 * a moment after the atomic create, so trusting mtime avoids treating that narrow window as corrupt.
 *
 * Never assumes the removal wins: another process racing the same stale lock may reclaim or release it
 * first, in which case this is a harmless no-op and the caller's next `open` attempt settles who gets it.
 */
async function reclaimIfStale(lockPath: string): Promise<void> {
  let mtimeMs: number;
  try {
    ({ mtimeMs } = await stat(lockPath));
  } catch {
    return; // Already gone — released or reclaimed by someone else. The next open() attempt will settle it.
  }

  if (Date.now() - mtimeMs < LOCK_STALE_MS) {
    return; // Fresh enough that another process may genuinely be holding it.
  }

  await unlink(lockPath).catch(() => {}); // Tolerate losing the race to reclaim it.
}

/**
 * Acquire an advisory lock on `${registryPath}.lock`, retrying until it succeeds or times out. A lock
 * left behind by a process that died mid-hold is reclaimed once it goes stale (see `LOCK_STALE_MS`)
 * instead of bricking the registry forever.
 */
async function acquireLock(registryPath: string, budget: LockBudget = {}): Promise<string> {
  const lockPath = `${registryPath}.lock`;
  const maxAttempts = budget.maxAttempts ?? LOCK_MAX_ATTEMPTS;
  const retryDelayMs = budget.retryDelayMs ?? LOCK_RETRY_DELAY_MS;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(lockContents());
      } finally {
        await handle.close();
      }
      return lockPath;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        await reclaimIfStale(lockPath);
      }
      await sleep(retryDelayMs);
    }
  }
  // The budget that was actually spent, not the constant — a refusal naming 50 after 3 attempts is a
  // refusal that sends the reader to the wrong number.
  throw new InternalError({
    message: "Could not lock the port registry.",
    action: `If no other pithy process is running, delete ${lockPath} by hand and retry.`,
    detail: `Timed out acquiring ${lockPath} after ${maxAttempts} attempts (stale threshold ${LOCK_STALE_MS}ms).`,
  });
}

/** Release the advisory lock, swallowing any error (e.g. already removed). */
async function releaseLock(lockPath: string): Promise<void> {
  await unlink(lockPath).catch(() => {});
}

/** Run `fn` while holding the advisory lock on `registryPath`, always releasing it after. */
async function withLock<T>(registryPath: string, fn: () => Promise<T>, budget?: LockBudget): Promise<T> {
  const lockPath = await acquireLock(registryPath, budget);
  try {
    return await fn();
  } finally {
    await releaseLock(lockPath);
  }
}

/**
 * Read the registry file. A **missing** file is an empty registry; invalid JSON/shape throws
 * `InternalError`, and so does one that is there and will not open.
 *
 * That distinction is {@link readOptionalFile}'s. It matters here as much as anywhere: every writer
 * below is a read-modify-write, so a registry read as empty is a registry rewritten holding only this
 * branch — and every other feature's block handed straight back out.
 */
async function readRegistry(registryPath: string): Promise<PortsRegistry> {
  const raw = await readOptionalFile(registryPath, {
    unreadable: ({ code, cause }) =>
      new InternalError({
        message: "Could not read the port registry.",
        action: unreadableAction(code, ".dev-ports.json"),
        detail: `${code ?? "unknown error"}: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  });
  if (raw === null) return {};

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

  const result = PortsRegistry.safeParse(parsed);
  if (!result.success) {
    throw fromZodError(result.error, {
      message: "The port registry is corrupt.",
      action: "Delete .dev-ports.json and re-run pithy feature create to rebuild it.",
    });
  }

  return result.data;
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

  return withLock(
    registryPath,
    async () => {
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
    },
    options.lock,
  );
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
  /** How long to wait for the registry lock. Defaults to the production budget — see {@link LockBudget}. */
  lock?: LockBudget;
}): Promise<string[]> {
  if (options.reservations.length === 0) return [];

  return withLock(
    options.registryPath,
    async () => {
      const registry = await readRegistry(options.registryPath);
      const reclaimed: string[] = [];
      for (const { branch, block } of options.reservations) {
        if (branch in registry) continue; // a live allocation always wins.
        registry[branch] = block;
        reclaimed.push(branch);
      }
      if (reclaimed.length > 0) await writeRegistry(options.registryPath, registry);
      return reclaimed;
    },
    options.lock,
  );
}

/** Free a branch's block under the lock (idempotent: a missing branch/registry is a no-op). */
export async function freePortBlock(options: FreeOptions): Promise<void> {
  const { registryPath, branch } = options;

  await withLock(
    registryPath,
    async () => {
      const registry = await readRegistry(registryPath);
      if (!(branch in registry)) {
        return;
      }
      delete registry[branch];
      await writeRegistry(registryPath, registry);
    },
    options.lock,
  );
}

/** Resolve the .dev-ports.json path from any cwd (main checkout or a worktree) via git-common-dir. */
export async function resolvePortsRegistryPath(cwd: string): Promise<string> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("git", ["rev-parse", "--git-common-dir"], { cwd }));
  } catch (err) {
    // Three failures reach here and one sentence used to answer all of them (#217). `git` absent from
    // PATH is a spawn `ENOENT` and no amount of standing in a repository fixes it; a non-repository is
    // the exit-128 case the sentence was written for; anything else gets no remedy, only git's own words.
    // Duck-typed: `code` is the string errno on a spawn failure and the numeric exit status otherwise.
    throw new InternalError({
      message: "Could not resolve the repo's git directory.",
      action: gitResolveAction(err),
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  const commonDir = stdout.trim();
  const absoluteCommonDir = isAbsolute(commonDir) ? commonDir : resolve(cwd, commonDir);
  const mainRoot = dirname(absoluteCommonDir);

  return join(mainRoot, ".dev-ports.json");
}
