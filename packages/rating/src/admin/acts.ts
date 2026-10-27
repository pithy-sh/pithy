// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { ConflictError, NotFoundError } from "@pithy-sh/core/src/error/pithyError";
import { type ResolvedRatingGame, resolveGame } from "../config/config";
import { RatingAdjustment, type RatingAdjustmentAct, type RatingSnapshot } from "../data/adjustment";
import { isUniqueViolation, runBatch } from "../data/batch";
import { outcomeLog } from "../data/log";
import { ratingStore, upsertQuery } from "../data/store";
import { RATING_ADJUSTMENTS_TABLE, type RatingDatabase } from "../data/tables";
import { historyOf, recordOf, snapshotOf } from "../history/history";
import { replayPlayer } from "../history/replay";

/**
 * The control-plane acts on one player's rating — recalculate and reset (#818).
 *
 * ## Idempotent by a unique key, decided by the database
 *
 * The act's row in `pithy_rating_adjustments` and the rating it writes go in **one batch**, and the row's
 * `idempotencyKey` is unique. So of two requests carrying one key, exactly one batch commits; the other
 * aborts on the constraint, writes nothing, and answers with what the first did. A key already spent is
 * found before any work is done, and answers the same way. A replay changes nothing, and the route emits
 * nothing for it.
 *
 * A key spent on a different act, pool or player is refused rather than answered: handing back somebody
 * else's result for a request that asked for something else would tell the caller its act happened.
 */

/** One act, as the route asks for it. */
export interface RatingActRequest {
  /** Which act. */
  act: RatingAdjustmentAct;
  /** The pool's speaking game: its algorithm and params. */
  pool: ResolvedRatingGame;
  /** The player. */
  userId: string;
  /** The client's idempotency key. */
  idempotencyKey: string;
  /** Why, verbatim. */
  reason: string;
}

/** What an act did, and whether this request was the one that did it. */
export interface RatingActResult {
  /** The act's row — the rating before and after, the reason, when. */
  adjustment: RatingAdjustment;
  /** True when the key was already spent and nothing changed this time. */
  replayed: boolean;
}

export async function adjustRating(
  db: RatingDatabase,
  games: readonly ResolvedRatingGame[],
  request: RatingActRequest,
  now: Date,
): Promise<RatingActResult> {
  const log = outcomeLog(db);
  const poolName = request.pool.game.pool;

  const spent = await log.adjustment(request.idempotencyKey);
  if (spent) return { adjustment: matching(spent, request), replayed: true };

  const current = await ratingStore(db).get(poolName, request.userId);
  if (!current) {
    throw new NotFoundError({
      message: "This player has no rating in that pool.",
      detail: `No pithy_rating_ratings row for "${request.userId}" in pool "${poolName}".`,
    });
  }

  const history = await historyOf(log, poolName, request.userId);
  const after: RatingSnapshot =
    request.act === "recalculate"
      ? replayPlayer({
          userId: request.userId,
          pool: request.pool,
          resolve: (key) => resolveGame(games, key),
          history,
        })
      : resetSnapshot(request.pool, current.xp, current.games);

  const adjustment: RatingAdjustment = {
    id: 0,
    idempotencyKey: request.idempotencyKey,
    act: request.act,
    pool: poolName,
    userId: request.userId,
    reason: request.reason,
    before: snapshotOf(current),
    after,
    floorEntry: history.entries.at(-1)?.id ?? 0,
    at: now,
  };
  const row = RatingAdjustment.encode(adjustment) as Record<string, unknown>;
  delete row.id;

  try {
    await runBatch(db, [
      db.insertInto(RATING_ADJUSTMENTS_TABLE).values(row as never),
      upsertQuery(db, recordOf(poolName, request.userId, after, now)),
    ]);
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // Another request with this key committed first. Its row is the answer, and this one wrote nothing.
    const winner = await log.adjustment(request.idempotencyKey);
    if (!winner) throw error;
    return { adjustment: matching(winner, request), replayed: true };
  }

  const stored = await log.adjustment(request.idempotencyKey);
  return { adjustment: stored ?? adjustment, replayed: false };
}

/** The algorithm's starting state, with the experience and game count the player already has. */
function resetSnapshot(pool: ResolvedRatingGame, xp: number, games: number): RatingSnapshot {
  const { algorithm, params } = pool;
  const state = algorithm.initial(params);
  return { algorithm: algorithm.id, state, skill: algorithm.skill(params, state), xp, games };
}

/** The spent key's row, when it was spent on this same act — otherwise the refusal. */
function matching(spent: RatingAdjustment, request: RatingActRequest): RatingAdjustment {
  if (spent.act === request.act && spent.pool === request.pool.game.pool && spent.userId === request.userId) {
    return spent;
  }
  throw new ConflictError({
    message: "That idempotency key was already used for a different act.",
    action: "Send a new key for a new act. Reuse a key only to retry the request it was made for.",
    detail: `Key "${request.idempotencyKey}" was spent on ${spent.act} of "${spent.userId}" in "${spent.pool}".`,
  });
}
