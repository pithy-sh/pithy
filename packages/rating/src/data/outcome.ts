// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { SQLiteBoolean, SQLiteDate, sqliteJson } from "@pithy-sh/core/src/data/codecs";
import { z } from "zod";

/**
 * The outcome log — every outcome rating applied, appended and never rewritten for a game's sake (#818).
 *
 * `pithy_rating_ratings` holds one row per player per pool: where a player stands, and nothing about how
 * they got there. That is enough to play on and not enough to correct anything. A rating cannot be
 * recalculated without the outcomes that produced it, and a voided result cannot be taken out of one. So
 * every applied outcome lands here first, and recalculation replays it.
 *
 * ## Two tables, because a roster is unbounded
 *
 * `pithy_rating_outcomes` is the outcome itself: its pool and game, the placements, the result it came
 * from, and when. `pithy_rating_outcome_players` is one row per participant, and it is what makes a replay
 * exact. Each row records the state that player went **into** the game with, as live application read it,
 * and the experience the game awarded them. Replaying one player then needs nothing but their own rows and
 * their opponents' rows for the same games: the opponents enter at the state live application saw, so the
 * algorithm is handed exactly what it was handed then, and lands where it landed then.
 *
 * ## Append-only, with two exceptions
 *
 * Nothing here is updated or deleted, save `voidedAt`. A void marks an outcome rather than removing it, so
 * the record of what was played survives the decision that it should not count.
 *
 * The other is a person's purge (#814): their user id is replaced by an `erased-` stand-in, one per outcome, in
 * the participant row and in `ranks` and `teams`. Nothing else moves, so every opponent still replays exactly.
 */

/** One applied outcome — the row in `pithy_rating_outcomes`. */
export const RatingOutcome = z
  .object({
    id: z.number().int().describe("Autoincrement PK. Monotonic, so it is also the order outcomes were applied in."),
    pool: z.string().describe("The rating pool the outcome was applied to."),
    game: z.string().describe("The configured game key the outcome was recorded against."),
    resultId: z
      .string()
      .nullable()
      .describe(
        "The id of the result this outcome came from — a multiplayer session result, or the adopter's own. Null when the recorder named none. A void addresses outcomes by it.",
      ),
    ranks: sqliteJson(z.record(z.string(), z.number().int())).describe(
      "Each player's finishing place, keyed by user id, exactly as recorded.",
    ),
    teams: sqliteJson(z.record(z.string(), z.string()))
      .nullable()
      .describe("The team grouping (player id → team id) for a team format, or null."),
    sharedRoom: SQLiteBoolean.describe("Whether the game was played in a shared room. Gated XP, never skill."),
    voidedAt: SQLiteDate.nullable().describe(
      "When the outcome was voided, or null while it counts. A voided outcome is skipped by every replay.",
    ),
    at: SQLiteDate.describe("When the outcome was applied."),
  })
  .describe("One outcome rating applied, as `pithy_rating_outcomes` keeps it.");
export type RatingOutcome = z.output<typeof RatingOutcome>;
export type RatingOutcomeRow = z.input<typeof RatingOutcome>;

/** One participant in one applied outcome — the row in `pithy_rating_outcome_players`. */
export const RatingOutcomePlayer = z
  .object({
    id: z
      .number()
      .int()
      .describe("Autoincrement PK. Monotonic, so a player's rows in id order are their history in order."),
    outcomeId: z.number().int().describe("The outcome this row belongs to (`pithy_rating_outcomes.id`)."),
    pool: z.string().describe("The outcome's pool, repeated so a player's history is one indexed range."),
    userId: z.string().describe("The participant's authenticated user id."),
    stateBefore: sqliteJson(z.unknown()).describe(
      "The algorithm state the player went into the game with, exactly as live application read it — the algorithm's starting state for a newcomer. A replay hands it to the algorithm for an opponent.",
    ),
    xpBefore: z.number().describe("The player's experience total in the pool before this outcome."),
    gamesBefore: z.number().int().describe("How many rated games the player had completed in the pool before it."),
    xpGained: z
      .number()
      .describe("The experience this outcome awarded the player. 0 when the game awards none, or the room gated it."),
  })
  .describe("One participant in one applied outcome, as `pithy_rating_outcome_players` keeps it.");
export type RatingOutcomePlayer = z.output<typeof RatingOutcomePlayer>;
export type RatingOutcomePlayerRow = z.input<typeof RatingOutcomePlayer>;
