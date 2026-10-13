// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * **Waiting on an eventually consistent control plane, for the live suites.** One budget and one rule, shared
 * by `@pithy-sh/cloudflare`'s Vectorize suite and `@pithy-sh/vector`'s, because the cloudflare suite kept a
 * 60s budget and a single confirming read of its own and failed on exactly that (#709).
 *
 * **The budget is 120s, and 300s for a metadata index.** A Vectorize index became visible 25-50s after the
 * call that made it, measured live, and an upsert became queryable in about 30s. A metadata index is slower:
 * about 97s on one run of #709 and over 120s on the next, so its waits take {@link METADATA_INDEX_SETTLE_MS}.
 *
 * **A metadata-index wait compares names and types, never a count.** {@link metadataIndexesSettled} is the
 * predicate; a list of the right length can still be the wrong list.
 *
 * **One confirming read proves nothing.** The metadata-index list is eventually consistent *and not
 * monotonic*: a 3-minute probe watched it report `[]` for 26s, then both properties, then one of the two 18s
 * later with nothing else running, then both again. So {@link waitForStable} waits for {@link STABLE_READS}
 * agreeing reads in a row and hands back that snapshot, and a caller asserts against the snapshot rather
 * than a fresh read, which can disagree with the one before it.
 *
 * **A test that waits several times shares one deadline across them.** Each wait's own budget bounds that
 * wait and nothing else, so a test making eight of them in a row could outrun its vitest timeout with every
 * step inside budget. Vitest then abandoned the body mid-poll: the failure said only "Test timed out", and the
 * teardown that deletes the index never ran (#709). Pass the same {@link SettleOptions.deadline} to every
 * wait and the step in progress when it passes fails by name, inside the body, where the teardown still runs.
 */

/** Ceiling for any one wait. Measured at 25-50s for a control-plane change, and about 30s for an upsert. */
export const SETTLE_TIMEOUT_MS = 120_000;

/**
 * Ceiling for a metadata-index wait, and only for that. A metadata index is the slowest change Vectorize
 * applies: on #709 one settled in about 97s and the next was still unsettled at 120s, so the shared budget
 * undercut exactly this wait. `pithy vector provision` waits on the same measurement.
 */
export const METADATA_INDEX_SETTLE_MS = 300_000;

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
  /**
   * An absolute deadline (ms since the epoch) shared by every wait in a test. A wait gives up at whichever
   * comes first, its own `timeoutMs` or this, and says which.
   */
  deadline?: number;
}

/** When a wait gives up, and the clause its timeout message ends the step name with. */
function limitOf(options: SettleOptions, started: number): { deadline: number; why: string } {
  const own = started + (options.timeoutMs ?? SETTLE_TIMEOUT_MS);
  if (options.deadline !== undefined && options.deadline < own) {
    return { deadline: options.deadline, why: " (the shared deadline for this test ran out)" };
  }
  return { deadline: own, why: "" };
}

function seconds(ms: number): number {
  return Math.round(ms / 1000);
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll until `ready`, or fail with a message naming what was being waited for. A bare timeout tells the next
 * reader nothing; naming the step tells them whether Cloudflare was slow or something is actually broken.
 */
export async function waitFor(what: string, ready: () => Promise<boolean>, options: SettleOptions = {}): Promise<void> {
  const started = Date.now();
  const { deadline, why } = limitOf(options, started);
  for (;;) {
    if (await ready()) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out after ${seconds(Date.now() - started)}s waiting for ${what}${why}. Cloudflare applies this change asynchronously — this is either a slower-than-usual apply or a real failure.`,
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
  const started = Date.now();
  const needed = options.stableReads ?? STABLE_READS;
  const { deadline, why } = limitOf(options, started);
  let agreed = 0;
  let last = await read();
  for (;;) {
    agreed = settled(last) ? agreed + 1 : 0;
    if (agreed >= needed) return last;
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out after ${seconds(Date.now() - started)}s waiting for ${what} to settle across ${needed} reads${why}. Last read: ${JSON.stringify(last)}.`,
      );
    }
    await pause(options.intervalMs ?? POLL_INTERVAL_MS);
    last = await read();
  }
}

/**
 * The settle predicate for a metadata-index list: every declared index is live, under its own name and its own
 * type. The rule `compareMetadataIndexes` applies with nothing missing and nothing mismatched, restated here
 * because this package cannot import `@pithy-sh/vector`. A count is not enough: a list of the right length
 * with the wrong names passed the predicate this replaced. An undeclared extra does not block it.
 */
export function metadataIndexesSettled(
  declared: readonly { propertyName: string; indexType: string }[],
): (live: readonly { propertyName: string; indexType: string }[]) => boolean {
  return (live) => {
    const types = new Map(live.map((entry) => [entry.propertyName, entry.indexType]));
    return declared.every((entry) => types.get(entry.propertyName) === entry.indexType);
  };
}
