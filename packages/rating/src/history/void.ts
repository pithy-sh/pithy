// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { type ResolvedRatingGame, resolveGame, resolvePool } from "../config/config";
import { runBatch } from "../data/batch";
import { outcomeLog } from "../data/log";
import { RatingOutcome } from "../data/outcome";
import { ratingStore, upsertQuery } from "../data/store";
import { RATING_OUTCOMES_TABLE, type RatingDatabase } from "../data/tables";
import { RatingPoolNotFoundError } from "../error/errors";
import type { RatingVoidedPlayer, RatingVoidReport } from "../http/responses";
import { historyOf, recordOf, snapshotOf } from "./history";
import { replayPlayer } from "./replay";

/**
 * The void consumer: take a result back out of every rating it moved (#818, for #820's cascade).
 *
 * Every outcome recorded with the result id is marked void, and every player those outcomes touched is
 * recalculated from the outcomes that remain. **Computed first, written once.** Each rating is rebuilt in
 * memory with the voided outcomes treated as void, and then the marks and every new rating go in one batch.
 * So a void that fails part-way writes nothing, and the retry finds the outcomes still counting — a void
 * that marked first and recalculated after would leave a retry nothing to do and the ratings wrong.
 *
 * **A stand-in is not a player.** A purge leaves the erased person's place in the log under `erased-…` with no
 * rating behind it, so the opponents' replays stay exact. A void recalculates only players who hold a rating, and
 * never gives a stand-in one.
 *
 * **Idempotent.** A result whose outcomes are all void already, or that rating never saw, changes nothing
 * and reports no players.
 */

/**
 * What a void did, and each player it recalculated — exactly the `RatingVoidReport` the void consumer
 * declares in `http/responses.ts`, never a copy of it, so a field can only be added to both at once.
 */
export type RatingVoidResult = RatingVoidReport;
export type VoidedPlayer = RatingVoidedPlayer;

export async function voidResult(
  db: RatingDatabase,
  games: readonly ResolvedRatingGame[],
  resultId: string,
  now: Date,
): Promise<RatingVoidResult> {
  const log = outcomeLog(db);
  const counting = (await log.byResult(resultId)).filter((outcome) => outcome.voidedAt === null);
  if (counting.length === 0) return { resultId, outcomes: 0, players: [] };

  const voided = new Set(counting.map((outcome) => outcome.id));
  const touched = new Map<string, { pool: string; userId: string }>();
  for (const row of await log.participants([...voided])) {
    touched.set(`${row.pool}\u0000${row.userId}`, { pool: row.pool, userId: row.userId });
  }

  const store = ratingStore(db);
  const players: VoidedPlayer[] = [];
  for (const { pool, userId } of touched.values()) {
    const speaking = resolvePool(games, pool);
    if (!speaking) {
      throw new RatingPoolNotFoundError({
        message: `The result touched pool "${pool}", which no configured game rates any more.`,
        detail: `Void of "${resultId}" cannot recalculate "${userId}" in an unconfigured pool.`,
      });
    }
    const stored = await store.get(pool, userId);
    // A player with log rows and no rating is a stand-in a purge left (#814): it has nobody behind it, and a
    // void never gives it a rating. Its outcomes are still marked, so every real player's replay skips them.
    if (!stored) continue;
    const before = snapshotOf(stored);
    const after = replayPlayer({
      userId,
      pool: speaking,
      resolve: (key) => resolveGame(games, key),
      history: await historyOf(log, pool, userId, voided),
    });
    players.push({ pool, userId, before, after });
  }

  await runBatch(db, [
    db
      .updateTable(RATING_OUTCOMES_TABLE)
      .set({ voidedAt: RatingOutcome.shape.voidedAt.encode(now) } as never)
      .where("id", "in", [...voided])
      .where("voidedAt", "is", null),
    ...players.map((player) => upsertQuery(db, recordOf(player.pool, player.userId, player.after, now))),
  ]);
  return { resultId, outcomes: voided.size, players };
}
