// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { lstat, open, unlink } from "node:fs/promises";
import type { PithyError } from "@pithy-sh/core/src/error/pithyError";

/**
 * **An advisory lock beside a file in the config directory: `${path}.lock`, created `O_EXCL`.**
 *
 * One lock, for every read-modify-write the CLI does under `<config>`. It was the port registry's alone
 * until #759 needed the same thing twice more — the profile bindings, and a session's refresh, where two
 * `pithy` processes renewing one profile at once would each write the other's refresh token over its
 * own. A second copy of these forty lines is how the stale-lock reclaim, the one part that took an
 * incident to get right, would have been missing from one of them.
 */

/** How many times {@link withFileLock} retries acquiring the lock before giving up. */
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
 * A lock file older than this is treated as abandoned, not held. A legitimate hold spans one small
 * read-modify-write — at most one token-endpoint call, which times out well inside this — so it never
 * approaches it. Anything this old can only be a lock a process left behind by dying mid-hold (Ctrl-C,
 * SIGKILL), which used to brick the port registry — and, worse, block `feature destroy` teardown —
 * forever. 30s leaves a wide margin over real hold times while still recovering promptly.
 */
export const LOCK_STALE_MS = 30_000;

/** What a timed-out lock is refused with: the caller names what it was locking. */
export type LockRefusal = (facts: { lockPath: string; attempts: number }) => PithyError;

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
    // `lstat`: the lock file's own clock. A link wearing the lock's name is aged as itself, never as its target.
    ({ mtimeMs } = await lstat(lockPath));
  } catch {
    return; // Already gone — released or reclaimed by someone else. The next open() attempt will settle it.
  }

  if (Date.now() - mtimeMs < LOCK_STALE_MS) {
    return; // Fresh enough that another process may genuinely be holding it.
  }

  await unlink(lockPath).catch(() => {}); // Tolerate losing the race to reclaim it.
}

/**
 * Acquire an advisory lock on `${path}.lock`, retrying until it succeeds or the budget is spent. A lock
 * left behind by a process that died mid-hold is reclaimed once it goes stale (see `LOCK_STALE_MS`)
 * instead of bricking whatever it guards forever.
 *
 * The directory must already exist: every errno but `EEXIST` is a sleep-and-retry here, so a missing
 * directory would spend the whole budget and then blame the lock.
 */
async function acquireLock(path: string, refusal: LockRefusal, budget: LockBudget = {}): Promise<string> {
  const lockPath = `${path}.lock`;
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
  throw refusal({ lockPath, attempts: maxAttempts });
}

/** Release the advisory lock, swallowing any error (e.g. already removed). */
async function releaseLock(lockPath: string): Promise<void> {
  await unlink(lockPath).catch(() => {});
}

/** Run `fn` holding the lock beside `path`, and release it however `fn` ends. */
export async function withFileLock<T>(
  path: string,
  fn: () => Promise<T>,
  options: { refusal: LockRefusal; budget?: LockBudget },
): Promise<T> {
  const lockPath = await acquireLock(path, options.refusal, options.budget);
  try {
    return await fn();
  } finally {
    await releaseLock(lockPath);
  }
}
