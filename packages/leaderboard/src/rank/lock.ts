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
 * with `LEADERBOARD_LOCK_STALE_MS` if a deployment refreshes boards larger than that.
 */
export const DEFAULT_LOCK_STALE_MS = 60 * 60 * 1000;

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
  const staleBefore = LeaderboardLock.shape.acquiredAt.encode(new Date(now.getTime() - staleMs));
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
