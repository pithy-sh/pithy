// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { LeaderboardLock } from "../data/lock";
import { LEADERBOARD_LOCKS_TABLE, type LeaderboardDatabase } from "../data/tables";

/**
 * The rank-refresh advisory lock: at most one refresh runs at a time.
 *
 * Why it exists: the materialize refresh writes ranks in chunks, not atomically. If a cron fired again
 * before a refresh finished, two passes would run concurrently and their chunked writes would interleave
 * into an incoherent rank set — duplicate or gapped rank numbers — until the next fire corrected it. The
 * lock serializes them: a second instance that cannot acquire it simply skips, and the pass it would have
 * done is redundant anyway (the holder is already producing fresh ranks).
 *
 * The lock lives in D1, not in DO or KV, because the refresh already has the `DB` binding and D1's
 * single-threaded execution makes the acquire genuinely atomic — the whole point.
 */

/** The one lock name the refresh uses. A single-row lock; there is no per-board locking. */
export const REFRESH_LOCK = "rank-refresh";

/**
 * How long a held lock stays valid before it is treated as abandoned by a crashed instance.
 *
 * A refresh that finishes releases the lock immediately, so this only matters when an instance dies
 * mid-pass. It must be comfortably longer than any real refresh so a slow-but-alive instance is never
 * stolen from; one hour is far past the ~5-minute worst case at the ~1M-player shard boundary. Override
 * with `LEADERBOARD_LOCK_STALE_MS` if a deployment refreshes boards larger than that, within the bounds
 * {@link requireLockStaleMs} enforces.
 */
export const DEFAULT_LOCK_STALE_MS = 60 * 60 * 1000;

/**
 * The longest stale horizon this lock accepts — a day, and it is refused rather than clamped.
 *
 * The ceiling is not decoration on the finiteness check, for the reason `MAX_SECRETS_CACHE_TTL_SECONDS`
 * records: `Infinity` is the loud spelling of *never reclaim*, and a number typed in the wrong unit is
 * the quiet one. `3_600_000` is the default written in milliseconds, which is right; the same number
 * typed as seconds-since-somebody-thought-it-was-seconds is `3_600_000_000` — forty-one days, during
 * which a crashed instance's lock is never reclaimed, every cron fire stands down, and the ranks a
 * board serves quietly stop moving. There is no error in that, and no line in the log; the boards just
 * stop. A day is far past the ~5-minute worst case at the ~1M-player shard boundary and still short
 * enough that a wedged lock is a today problem.
 */
export const MAX_LOCK_STALE_MS = 24 * 60 * 60 * 1000;

/**
 * Refuse a stale horizon that is not a duration — checked before anything is compared to it.
 *
 * `Number(env.LEADERBOARD_LOCK_STALE_MS)` is `NaN` for `"1h"`, `"3600 ms"` or a typo, and `Infinity`
 * for `"1e999"`. Neither widens the horizon, and neither is caught by the `??` default one frame up,
 * which answers `undefined` and nothing else. What each does instead is the whole reason this exists,
 * and the two directions are different failures:
 *
 * - **Fails open — a negative or zero horizon.** `staleBefore` lands at or after `now`, so the takeover
 *   `WHERE acquiredAt < staleBefore` is true of *every* row, fresh ones included. Each cron fire steals
 *   the lock from the instance still holding it, both keep writing, and their chunked rank writes
 *   interleave into the duplicate-and-gapped rank set the lock exists to prevent. At-most-one is gone,
 *   silently, and every board reads as ranked.
 * - **Fails obscurely — `NaN`, `Infinity`, or past the JS date range.** `new Date(now - NaN)` is an
 *   Invalid Date, which `SQLiteDate`'s encode side refuses, so a `ZodError` — *"expected date, received
 *   Date"* — leaves `acquireRefreshLock` outside any Workflow step and kills the run. It names nothing
 *   an operator can act on, and it does it on every fire.
 *
 * There is no safe number to clamp a typo to, so it is named and refused, exactly as
 * `@pithy-sh/email`'s `assertBatchSize` refuses `SCHEDULER_BATCH_SIZE` (#250) — this repository's own
 * precedent, and the production bug that taught it. `core/internal`, because the number is ours to fix
 * and the operator reading our logs is who can fix it (#521).
 *
 * It returns the value it checked so the env boundary reads as one expression: the coercion cannot be
 * written without the check beside it, which is what `ci/environmentNumbers.test.ts` gates repo-wide.
 */
export function requireLockStaleMs(staleMs: number): number {
  if (!Number.isInteger(staleMs) || staleMs < 1 || staleMs > MAX_LOCK_STALE_MS) {
    throw new InternalError({
      message: "The leaderboard rank refresh is misconfigured.",
      action: `Set LEADERBOARD_LOCK_STALE_MS to a whole number of milliseconds from 1 to ${MAX_LOCK_STALE_MS}, or unset it for the default of ${DEFAULT_LOCK_STALE_MS}.`,
      detail: `LEADERBOARD_LOCK_STALE_MS resolved to ${String(staleMs)}; a stale horizon must be a whole number of milliseconds from 1 to ${MAX_LOCK_STALE_MS}. At or below zero every cron fire steals a live holder's lock and two refreshes interleave their rank writes; above the range the horizon is not a date at all and the refresh cannot run.`,
    });
  }
  return staleMs;
}

/**
 * Try to take the refresh lock for `holder`, returning whether it was acquired.
 *
 * Atomic on D1's single thread: the upsert either inserts the row (no holder yet) or, on conflict, takes
 * it over only if the current holder's lock is older than `staleMs` — a fresh lock is left untouched.
 * A concurrent second caller therefore either finds no row and loses the insert race, or finds a fresh
 * lock and is refused by the `WHERE`. Either way it reads back a `holder` that is not its own and knows
 * to stand down.
 */
export async function acquireRefreshLock(
  db: LeaderboardDatabase,
  holder: string,
  now: Date,
  staleMs: number = DEFAULT_LOCK_STALE_MS,
): Promise<boolean> {
  // Before the upsert, and on the resolved value rather than on the caller's argument, so the check
  // covers every route in: this worker's env var, an adopter who merged the Workflow into their own
  // worker and passed a number of their own, and the default. The comparison two lines down is the only
  // thing that reads this number, and it cannot be reached around.
  const horizon = requireLockStaleMs(staleMs);
  const staleBefore = LeaderboardLock.shape.acquiredAt.encode(new Date(now.getTime() - horizon));
  const row = LeaderboardLock.encode({ name: REFRESH_LOCK, holder, acquiredAt: now });

  await db
    .insertInto(LEADERBOARD_LOCKS_TABLE)
    // biome-ignore lint/suspicious/noExplicitAny: the encoded row is the schema's `z.input` side.
    .values(row as any)
    .onConflict((oc) =>
      oc
        .column("name")
        .doUpdateSet({ holder, acquiredAt: LeaderboardLock.shape.acquiredAt.encode(now) })
        // Take over only an abandoned lock; a live holder's row is left as-is.
        .where("pithyLeaderboardLocks.acquiredAt", "<", staleBefore),
    )
    .execute();

  const current = await db
    .selectFrom(LEADERBOARD_LOCKS_TABLE)
    .select("holder")
    .where("name", "=", REFRESH_LOCK)
    .executeTakeFirst();
  return current?.holder === holder;
}

/** Release the lock if `holder` still holds it. A no-op if it was already reclaimed or released. */
export async function releaseRefreshLock(db: LeaderboardDatabase, holder: string): Promise<void> {
  await db.deleteFrom(LEADERBOARD_LOCKS_TABLE).where("name", "=", REFRESH_LOCK).where("holder", "=", holder).execute();
}
