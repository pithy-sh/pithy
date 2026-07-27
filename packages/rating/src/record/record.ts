import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import type { RatedOutcome, RatingEntry } from "../algorithm/algorithm";
import type { ResolvedRatingGame } from "../config/config";
import type { RatingRecord } from "../data/rating";
import type { RatingStore } from "../data/store";
import { awardXp, classifyLevel, type XpOutcome, xpFor } from "../experience/xp";

/**
 * Recording a game's outcome — the heart of the tracker. It loads each player's current standing in the
 * game's pool (a newcomer starts at the algorithm's `initial`), runs the algorithm's pure `update` to get
 * everyone's new skill state, folds in experience, and upserts each row.
 *
 * Two rules from the issue live here:
 * - **Skill rating (MMR) always updates from a real result** — a game is a game.
 * - **Experience / rank is gated**: a shared-room (friend) game counts toward XP only when the game opts
 *   in with `sharedRoomCounts`. By default friends cannot farm each other for XP.
 */

/** The outcome to record: a placement per player, an optional team grouping, and provenance. */
export interface RecordOutcomeInput {
  /** Each player's finishing place (1 = winner; ties share a place). Every roster member must appear. */
  ranks: Record<string, number>;
  /** Optional team grouping (player id → team id), for a team format. */
  teams?: Record<string, string>;
  /** Whether this game was played in a shared room with a friend. Gates XP/rank, never MMR. */
  sharedRoom?: boolean;
  /** When the game finished. */
  at: Date;
}

/** One player's standing after a recorded game. */
export interface RecordedPlayer {
  /** The player's user id. */
  userId: string;
  /** Their new conservative skill number (the MMR the matchmaker buckets on). */
  skill: number;
  /** Their new monotonic experience total in the pool. */
  xp: number;
  /** Their rank/level from the game's ladder, or null. */
  level: string | null;
  /** Their new algorithm state blob. */
  state: unknown;
  /** How many rated games they have now completed in the pool. */
  games: number;
}

export async function recordOutcome(
  store: RatingStore,
  resolved: ResolvedRatingGame,
  input: RecordOutcomeInput,
): Promise<RecordedPlayer[]> {
  const { game, algorithm, params } = resolved;
  const playerIds = Object.keys(input.ranks);

  if (playerIds.length !== game.players) {
    throw new ValidationError({
      message: `This game expects ${game.players} players, but the outcome names ${playerIds.length}.`,
      action: "Report exactly the game's roster in `ranks`.",
      detail: `Game "${game.key}" players=${game.players}, ranks has ${playerIds.length}.`,
    });
  }
  if (input.teams) {
    for (const id of playerIds) {
      if (!(id in input.teams)) {
        throw new ValidationError({
          message: "Every player must be assigned to a team.",
          action: "Include each player id in `teams`.",
          detail: `Player "${id}" is in ranks but not teams.`,
        });
      }
    }
  }

  const existing = await store.getMany(game.pool, playerIds);
  const byUser = new Map(existing.map((record) => [record.userId, record]));

  const entries: RatingEntry[] = playerIds.map((userId) => {
    const record = byUser.get(userId);
    const state = record ? algorithm.state.parse(record.state) : algorithm.initial(params);
    return { playerId: userId, state };
  });

  const outcome: RatedOutcome = { ranks: input.ranks, teams: input.teams };
  const nextStates = algorithm.update(params, entries, outcome);

  const countsForXp = !input.sharedRoom || game.sharedRoomCounts;
  const results: RecordedPlayer[] = [];

  for (const userId of playerIds) {
    const nextState = nextStates[userId];
    if (nextState === undefined) {
      throw new ValidationError({
        message: "The rating algorithm did not return a state for every player.",
        detail: `Algorithm "${algorithm.id}" omitted player "${userId}" from its update.`,
      });
    }
    const prior = byUser.get(userId);
    const priorXp = prior?.xp ?? 0;
    const gained = game.xp && countsForXp ? xpFor(game.xp, xpOutcome(userId, input.ranks)) : 0;
    const xp = awardXp(priorXp, gained);

    const record: RatingRecord = {
      id: 0,
      pool: game.pool,
      userId,
      algorithm: algorithm.id,
      state: nextState,
      skill: algorithm.skill(params, nextState),
      xp,
      games: (prior?.games ?? 0) + 1,
      updatedAt: input.at,
    };
    await store.upsert(record);

    results.push({
      userId,
      skill: record.skill,
      xp,
      level: game.levels ? classifyLevel(game.levels, xp) : null,
      state: nextState,
      games: record.games,
    });
  }

  return results;
}

/** A player's win/draw/loss for XP: sole top place is a win, a shared top place is a draw, else a loss. */
function xpOutcome(userId: string, ranks: Record<string, number>): XpOutcome {
  const mine = ranks[userId];
  const best = Math.min(...Object.values(ranks));
  if (mine !== best) return "loss";
  const atBest = Object.values(ranks).filter((r) => r === best).length;
  return atBest === 1 ? "win" : "draw";
}
