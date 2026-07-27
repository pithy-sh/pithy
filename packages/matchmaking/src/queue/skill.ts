/**
 * Read a player's skill number in a rating pool via the optional `@pithy-sh/rating` seam
 * (dynamic-imported). Returns `null` when rating is not installed, the pool is empty, or the player is
 * unrated — the queue then buckets that player by region only. Never throws for an absent dependency; a
 * missing skill is a `null`, not an error.
 */
export async function readSkill(db: D1Database, pool: string, userId: string): Promise<number | null> {
  try {
    const { ratingStore } = await import("@pithy-sh/rating/src/data/store");
    const { ratingDatabase } = await import("@pithy-sh/rating/src/data/tables");
    const record = await ratingStore(ratingDatabase(db)).get(pool, userId);
    return record?.skill ?? null;
  } catch {
    // Rating is an optional peer: a missing package, an unmigrated pool, or an unrated player is a `null`,
    // never a failure — the queue falls back to region-only bucketing.
    return null;
  }
}
