// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { decodeCursor, type PageCursor, pageLimit, toPage } from "@pithy-sh/core/src/data/cursor";
import type { ResolvedRatingGame } from "../config/config";
import { RatingRecord } from "../data/rating";
import { RATING_RATINGS_TABLE, type RatingDatabase } from "../data/tables";
import type { RatingAdminPool } from "../http/responses";

/**
 * The management read model behind the control-plane reads (#818) — and nothing else. It reads across
 * every player in a pool, which is a different operation from a player reading their own standing, so it
 * stays out of the store the player routes and matchmaking use.
 */

/** Every pool the configured games rate, in the order each first appears, in the shape `RatingAdminPool` declares. */
export function listPools(games: readonly ResolvedRatingGame[]): RatingAdminPool[] {
  const pools = new Map<string, RatingAdminPool>();
  for (const { game, algorithm } of games) {
    const found = pools.get(game.pool);
    if (found) found.games.push(game.key);
    else pools.set(game.pool, { pool: game.pool, algorithm: algorithm.id, games: [game.key] });
  }
  return [...pools.values()];
}

/** A row's position in the descending `(skill, id)` order. */
function position(row: RatingRecord): PageCursor {
  return { sort: row.skill, id: row.id };
}

/**
 * The ratings in one pool, highest skill first, a page at a time.
 *
 * Keyset on `(skill, id)`, descending. `skill` is not unique, so `id` breaks the tie, and a cursor resumes
 * strictly after both: a row is on the next page when its skill is lower, or equal with a lower id. The
 * `(pool, skill)` index from `0001` serves the order. A cursor that is not one of ours is a first page.
 */
export async function listRatings(
  db: RatingDatabase,
  pool: string,
  query: { cursor?: string; limit?: number },
): Promise<{ items: RatingRecord[]; nextCursor: string | null }> {
  const limit = pageLimit(query.limit);
  const decoded = decodeCursor(query.cursor);
  let selection = db
    .selectFrom(RATING_RATINGS_TABLE)
    .selectAll()
    .where("pool", "=", pool)
    .orderBy("skill", "desc")
    .orderBy("id", "desc")
    .limit(limit + 1);
  if (decoded && typeof decoded.sort === "number" && typeof decoded.id === "number") {
    const { sort, id } = decoded;
    selection = selection.where((eb) =>
      eb.or([eb("skill", "<", sort), eb.and([eb("skill", "=", sort), eb("id", "<", id)])]),
    );
  }
  const rows = await selection.execute();
  return toPage(
    rows.map((row) => RatingRecord.parse(row)),
    limit,
    position,
  );
}
