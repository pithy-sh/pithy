// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * **Waiting on an eventually consistent control plane, for the live suites.** One budget and one rule, shared
 * by `@pithy-sh/cloudflare`'s Vectorize suite and `@pithy-sh/vector`'s, because the cloudflare suite kept a
 * 60s budget and a single confirming read of its own and failed on exactly that (#709).
 *
 * **The budget is 120s.** A Vectorize index and a metadata index each became visible 25-50s after the call
 * that made them, measured live, and an upsert became queryable in about 30s.
 *
 * **One confirming read proves nothing.** The metadata-index list is eventually consistent *and not
 * monotonic*: a 3-minute probe watched it report `[]` for 26s, then both properties, then one of the two 18s
 * later with nothing else running, then both again. So {@link waitForStable} waits for {@link STABLE_READS}
 * agreeing reads in a row and hands back that snapshot, and a caller asserts against the snapshot rather
 * than a fresh read, which can disagree with the one before it.
 */

/** Ceiling for any one wait. Measured at 25-50s for a control-plane change, and about 30s for an upsert. */
export const SETTLE_TIMEOUT_MS = 120_000;

/**
 * Consecutive agreeing reads that count as settled. Three, because one confirming read can be a stale replica,
 * and two in a row six seconds apart is a far weaker coincidence.
 */
export const STABLE_READS = 3;

/** How often a poll re-checks. Vectorize applies changes in tens of seconds, so a tighter loop only burns quota. */
export const POLL_INTERVAL_MS = 2_000;

/** How long to wait and how often to look. Every field defaults to the shared budget above. */
export interface SettleOptions {
  /** Give up after this long. Defaults to {@link SETTLE_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Re-check this often. Defaults to {@link POLL_INTERVAL_MS}. */
  intervalMs?: number;
  /** Agreeing reads in a row that count as settled, for {@link waitForStable}. Defaults to {@link STABLE_READS}. */
  stableReads?: number;
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll until `ready`, or fail with a message naming what was being waited for. A bare timeout tells the next
 * reader nothing; naming the step tells them whether Cloudflare was slow or something is actually broken.
 */
export async function waitFor(what: string, ready: () => Promise<boolean>, options: SettleOptions = {}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? SETTLE_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await ready()) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${what}. Cloudflare applies this change asynchronously — this is either a slower-than-usual apply or a real failure.`,
      );
    }
    await pause(options.intervalMs ?? POLL_INTERVAL_MS);
  }
}

/**
 * Poll until `settled` holds on {@link STABLE_READS} consecutive reads, and return the last value read. The
 * caller asserts against the returned snapshot, never against a fresh read.
 */
export async function waitForStable<T>(
  what: string,
  read: () => Promise<T>,
  settled: (value: T) => boolean,
  options: SettleOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? SETTLE_TIMEOUT_MS;
  const needed = options.stableReads ?? STABLE_READS;
  const deadline = Date.now() + timeoutMs;
  let agreed = 0;
  let last = await read();
  for (;;) {
    agreed = settled(last) ? agreed + 1 : 0;
    if (agreed >= needed) return last;
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${what} to settle across ${needed} reads. Last read: ${JSON.stringify(last)}.`,
      );
    }
    await pause(options.intervalMs ?? POLL_INTERVAL_MS);
    last = await read();
  }
}
