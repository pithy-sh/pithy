// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import type { RatingPeer } from "@pithy-sh/rating/src/peer";

/**
 * Read a player's skill number in a rating pool through the optional `@pithy-sh/rating` seam — the surface the
 * composition handed over, never an import (#645). Returns `null` when rating is not composed, the pool is
 * empty, or the player is unrated — the queue then buckets that player by region only. Never throws for an
 * absent dependency; a missing skill is a `null`, not an error.
 */
export async function readSkill(
  db: D1Database,
  pool: string,
  userId: string,
  rating: RatingPeer | undefined,
): Promise<number | null> {
  if (rating === undefined) return null;
  try {
    const record = await rating.ratingStore(rating.ratingDatabase(db)).get(pool, userId);
    return record?.skill ?? null;
  } catch {
    // Rating is an optional peer: an unmigrated pool or an unrated player is a `null`, never a failure — the
    // queue falls back to region-only bucketing.
    return null;
  }
}
