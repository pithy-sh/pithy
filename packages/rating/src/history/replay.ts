// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { ConflictError, InternalError } from "@pithy-sh/core/src/error/pithyError";
import type { RatingEntry } from "../algorithm/algorithm";
import type { ResolvedRatingGame } from "../config/config";
import type { RatingSnapshot } from "../data/adjustment";
import type { RatingOutcome, RatingOutcomePlayer } from "../data/outcome";

/**
 * Recalculation: one player's rating, rebuilt from the outcome log (#818). Pure — no clock, no storage —
 * so the walk is tested on its own and the D1 reads that feed it stay in `recalculate.ts`.
 *
 * ## Why it lands where live application did
 *
 * Live application handed the algorithm every participant's state as it stood when the game was played,
 * and the log kept each of those states (`stateBefore`). A replay walks the player's own outcomes in
 * order, carrying the player's state forward itself, and hands every opponent the state the log says they
 * had. The algorithm sees exactly the inputs it saw live, so with nothing voided it returns exactly the
 * rating live application left.
 *
 * ## What a void and a reset change
 *
 * A voided outcome is skipped whole: no skill, no experience, no game. That corrects the players it
 * touched, each from the outcomes that remain. It does not chase the ripple — an opponent who later beat
 * somebody else did so at the rating they held then, and the log keeps that game as it was played.
 *
 * A reset is a floor. Skill replays from the algorithm's starting state, over only the outcomes after it,
 * so a later recalculation or void cannot replay through a reset and undo it. Experience and the game
 * count are not touched by a reset, so they keep counting every outcome that is not void.
 *
 * ## Where a replay starts
 *
 * From the standing the player's first logged outcome found them at. For a player who arrived after the
 * log did, that is the starting state, nothing earned and no games. For a rating older than the log, it
 * is the rating as the log first saw it, which is the most the log can honestly say. A rating with no
 * logged outcome at all has nothing to replay, and is refused rather than reset in silence.
 */

/** What a replay of one player is handed: their log rows, the outcomes behind them, and every participant. */
export interface ReplayHistory {
  /** The player's own rows in the pool, oldest first. */
  entries: readonly RatingOutcomePlayer[];
  /** The outcomes those rows belong to, by id. */
  outcomes: ReadonlyMap<number, RatingOutcome>;
  /** Every participant row of those outcomes — the player's and their opponents'. */
  participants: readonly RatingOutcomePlayer[];
  /** The latest reset's floor: entries at or below it do not move skill. Undefined when never reset. */
  floorEntry?: number;
}

export interface ReplayInput {
  /** The player being recalculated. */
  userId: string;
  /** The game that speaks for the pool — its algorithm, and the params of last resort. */
  pool: ResolvedRatingGame;
  /** The configured game behind an outcome's key, or undefined once it is gone. */
  resolve(game: string): ResolvedRatingGame | undefined;
  /** The log, as {@link ReplayHistory}. */
  history: ReplayHistory;
}

/** Rebuild one player's rating from the log. Throws `core/conflict` when there is nothing to rebuild from. */
export function replayPlayer(input: ReplayInput): RatingSnapshot {
  const { userId, pool, history } = input;
  const { algorithm } = pool;
  const first = history.entries[0];
  if (!first) {
    throw new ConflictError({
      message: "This rating predates its history: no outcome behind it was logged, so there is nothing to replay.",
      action: "Reset the rating instead, or leave it as it stands.",
      detail: `Player "${userId}" has no rows in pithy_rating_outcome_players for pool "${pool.game.pool}".`,
    });
  }

  const byOutcome = new Map<number, RatingOutcomePlayer[]>();
  for (const row of history.participants) {
    const rows = byOutcome.get(row.outcomeId) ?? [];
    rows.push(row);
    byOutcome.set(row.outcomeId, rows);
  }

  const floor = history.floorEntry;
  let state: unknown =
    floor === undefined ? algorithm.state.parse(first.stateBefore) : algorithm.initial(pool.params as never);
  let xp = first.xpBefore;
  let games = first.gamesBefore;

  for (const entry of history.entries) {
    const outcome = history.outcomes.get(entry.outcomeId);
    if (!outcome) {
      throw new InternalError({
        message: "The outcome log is missing an outcome a player's history names.",
        detail: `Row ${entry.id} names outcome ${entry.outcomeId}, which was not loaded.`,
      });
    }
    if (outcome.voidedAt !== null) continue;
    xp += entry.xpGained;
    games += 1;
    if (floor !== undefined && entry.id <= floor) continue;

    const rated = input.resolve(outcome.game) ?? pool;
    const roster = byOutcome.get(outcome.id) ?? [];
    const entries: RatingEntry[] = roster.map((row) => ({
      playerId: row.userId,
      state: row.userId === userId ? state : rated.algorithm.state.parse(row.stateBefore),
    }));
    const next = rated.algorithm.update(rated.params, entries, {
      ranks: outcome.ranks,
      ...(outcome.teams ? { teams: outcome.teams } : {}),
    });
    state = next[userId];
    if (state === undefined) {
      throw new InternalError({
        message: "The rating algorithm did not return a state for every player.",
        detail: `Algorithm "${rated.algorithm.id}" omitted player "${userId}" replaying outcome ${outcome.id}.`,
      });
    }
  }

  return { algorithm: algorithm.id, state, skill: algorithm.skill(pool.params, state), xp, games };
}
