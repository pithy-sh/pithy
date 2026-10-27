// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { SQLiteDate, sqliteJson } from "@pithy-sh/core/src/data/codecs";
import { z } from "zod";

/**
 * The control-plane acts on a rating, kept as rows — the row in `pithy_rating_adjustments` (#818).
 *
 * **Two jobs, one table.** The unique `idempotencyKey` is what makes an act safe to retry: a second request
 * with a key already spent finds this row, changes nothing and emits nothing, and answers with what the
 * first one did. And a `reset` row is the floor a later recalculation replays from — without it, the next
 * void or recalculate would replay straight through the reset and undo it.
 */

/** What a control-plane act did to a rating. */
export const RatingAdjustmentAct = z
  .enum(["recalculate", "reset"])
  .describe(
    "The act: `recalculate` replays the player's outcomes from the log, `reset` returns them to the algorithm's starting state.",
  );
export type RatingAdjustmentAct = z.output<typeof RatingAdjustmentAct>;

/** A rating as an act found or left it — enough to show before and after, and to answer a replay. */
export const RatingSnapshot = z
  .object({
    algorithm: z.string().describe("The algorithm that produced `state`."),
    state: z.unknown().describe("The algorithm's per-player state."),
    skill: z.number().describe("The conservative skill number the state yields."),
    xp: z.number().describe("The experience total in the pool."),
    games: z.number().int().describe("How many rated games count toward the rating."),
  })
  .describe("One player's rating at a moment: its state, skill, experience and game count.");
export type RatingSnapshot = z.output<typeof RatingSnapshot>;

/** One control-plane act on one player's rating in one pool. */
export const RatingAdjustment = z
  .object({
    id: z.number().int().describe("Autoincrement PK. Internal only."),
    idempotencyKey: z
      .string()
      .describe("The client's key for this act. Unique: a request repeating it changes nothing a second time."),
    act: RatingAdjustmentAct,
    pool: z.string().describe("The pool the act addressed."),
    userId: z.string().describe("The player the act addressed."),
    reason: z.string().describe("Why, as the operator wrote it. Required, and carried verbatim on the audit event."),
    before: sqliteJson(RatingSnapshot)
      .nullable()
      .describe("The rating the act found, or null when the player had none in the pool."),
    after: sqliteJson(RatingSnapshot).describe("The rating the act left."),
    floorEntry: z
      .number()
      .int()
      .describe(
        "The highest `pithy_rating_outcome_players.id` the player had when the act ran, or 0. On a reset, a replay skips every entry at or below it for skill.",
      ),
    at: SQLiteDate.describe("When the act ran."),
  })
  .describe("One control-plane act on a rating, as `pithy_rating_adjustments` keeps it.");
export type RatingAdjustment = z.output<typeof RatingAdjustment>;
export type RatingAdjustmentRow = z.input<typeof RatingAdjustment>;
