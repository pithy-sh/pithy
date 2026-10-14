// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";

/**
 * What the rating routes return, as Zod objects a client can validate against and the OpenAPI contract
 * can describe.
 *
 * `schemas.ts` bounds what a caller may send; this file states what it gets back. These describe JSON on
 * the wire, and nothing here carries a codec or a transform: parsing a response hands back exactly what
 * went in, which is what lets `routes.workers.test.ts` parse a real answer and compare it with the
 * original.
 *
 * **A field added here later is `.optional()` as well as `.nullable()`.** A client generated from the
 * contract reads Workers on older releases too, and a required key they cannot send fails it outright.
 */

/** One player's standing after a recorded game. */
export const RecordedPlayerView = z
  .object({
    userId: z.string().describe("The player's id, from `@pithy-sh/auth`."),
    skill: z
      .number()
      .describe(
        "The player's new conservative skill number, the MMR the matchmaker buckets on. Returned to the recording server even when the game sets `hideSkill`.",
      ),
    xp: z.number().describe("The player's new experience total in the game's pool. It never goes down."),
    level: z
      .string()
      .nullable()
      .describe("The player's level from the game's XP ladder, or null when the game has none."),
    state: z
      .unknown()
      .describe("The player's new rating state, in the shape the game's algorithm keeps. Opaque to a client."),
    games: z.number().int().describe("How many rated games the player has now completed in the pool."),
  })
  .describe("One player's standing after a recorded game.");
export type RecordedPlayerView = z.infer<typeof RecordedPlayerView>;

/** What recording an outcome returns. */
export const RecordedOutcome = z
  .object({
    game: z.string().describe("The game's key."),
    pool: z.string().describe("The rating pool the outcome was recorded in."),
    players: z.array(RecordedPlayerView).describe("Each player in the outcome, with their standing after it."),
  })
  .describe("The result of recording one rated game.");
export type RecordedOutcome = z.infer<typeof RecordedOutcome>;

/** A player-facing view of one player's standing in a game's pool. */
export const RatingView = z
  .object({
    pool: z.string().describe("The rating pool the game reads."),
    userId: z.string().describe("The player's id."),
    skill: z
      .number()
      .nullable()
      .describe(
        "The player's conservative skill number, or null when the game sets `hideSkill`. An unrated player reads the algorithm's starting value.",
      ),
    xp: z.number().describe("The player's experience total in the pool. 0 for an unrated player."),
    level: z
      .string()
      .nullable()
      .describe("The player's level from the game's XP ladder, or null when the game has none."),
    games: z.number().int().describe("How many rated games the player has completed in the pool."),
    provisional: z.boolean().describe("True when the player has no stored rating in the pool yet."),
  })
  .describe("One player's standing in a game's rating pool.");
export type RatingView = z.infer<typeof RatingView>;
