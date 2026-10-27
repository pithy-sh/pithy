// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { RatingAdjustmentAct } from "../data/adjustment";

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

// --- The control-plane management surface (#818) ---

/** One rating pool, as a management client lists it. */
export const RatingAdminPool = z
  .object({
    pool: z.string().describe("The pool's name."),
    algorithm: z.string().describe("The algorithm every game in the pool rates with."),
    games: z.array(z.string()).describe("The configured games that rate this pool, by key."),
  })
  .describe("One rating pool: its algorithm and the games that rate it.");
export type RatingAdminPool = z.infer<typeof RatingAdminPool>;

/** What `GET {base}/admin/pools` returns. */
export const RatingAdminPoolsResponse = z
  .object({ pools: z.array(RatingAdminPool).describe("Every pool a configured game rates.") })
  .describe("Every rating pool this Worker configures.");
export type RatingAdminPoolsResponse = z.infer<typeof RatingAdminPoolsResponse>;

/** One stored rating, whole — what an operator sees, `hideSkill` or not. */
export const RatingAdminRating = z
  .object({
    pool: z.string().describe("The pool."),
    userId: z.string().describe("The player."),
    algorithm: z.string().describe("The algorithm that produced `state`."),
    state: z.unknown().describe("The algorithm's per-player state, in the shape that algorithm keeps."),
    skill: z.number().describe("The conservative skill number. Shown here even when a game sets `hideSkill`."),
    xp: z.number().describe("The experience total in the pool."),
    games: z.number().int().describe("How many rated games count toward the rating."),
    updatedAt: z.string().describe("When the rating last changed, ISO-8601."),
  })
  .describe("One player's stored rating in one pool.");
export type RatingAdminRating = z.infer<typeof RatingAdminRating>;

/** What `GET {base}/admin/pools/:pool/players` returns. */
export const RatingAdminPlayersResponse = z
  .object({
    pool: z.string().describe("The pool listed."),
    players: z.array(RatingAdminRating).describe("This page of ratings, highest skill first."),
    nextCursor: z.string().nullable().describe("Where the next page resumes, or null at the end. Opaque."),
  })
  .describe("A page of the ratings in one pool.");
export type RatingAdminPlayersResponse = z.infer<typeof RatingAdminPlayersResponse>;

/** One outcome in a player's history, from where that player stood. */
export const RatingAdminOutcome = z
  .object({
    game: z.string().describe("The game the outcome was recorded against."),
    resultId: z.string().nullable().describe("The result the outcome came from, or null when none was named."),
    rank: z.number().int().describe("This player's finishing place. 1 is the winner; ties share a place."),
    ranks: z.record(z.string(), z.number().int()).describe("Every player's finishing place, keyed by user id."),
    teams: z.record(z.string(), z.string()).nullable().describe("The team grouping for a team format, or null."),
    sharedRoom: z.boolean().describe("Whether it was a shared-room game, which gates experience."),
    voided: z.boolean().describe("Whether the outcome was voided. A voided outcome counts toward nothing."),
    voidedAt: z.string().nullable().describe("When it was voided, ISO-8601, or null while it counts."),
    skillBefore: z.number().describe("This player's skill going into the game."),
    xpBefore: z.number().describe("This player's experience total going into the game."),
    gamesBefore: z.number().int().describe("How many rated games this player had completed before it."),
    xpGained: z.number().describe("The experience the game awarded this player."),
    at: z.string().describe("When the outcome was applied, ISO-8601."),
  })
  .describe("One logged outcome, from where one player stood.");
export type RatingAdminOutcome = z.infer<typeof RatingAdminOutcome>;

/** What `GET {base}/admin/pools/:pool/players/:userId` returns. */
export const RatingAdminPlayerResponse = z
  .object({
    pool: z.string().describe("The pool."),
    userId: z.string().describe("The player."),
    rating: RatingAdminRating.nullable().describe("The player's stored rating, or null when they have none here."),
    outcomes: z.array(RatingAdminOutcome).describe("This page of the player's logged outcomes, newest first."),
    nextCursor: z.string().nullable().describe("Where the next page of outcomes resumes, or null at the end."),
  })
  .describe("One player's rating in a pool, and a page of the outcomes behind it.");
export type RatingAdminPlayerResponse = z.infer<typeof RatingAdminPlayerResponse>;

/** A rating at one moment, as an act or a void reports it. */
export const RatingSnapshotView = z
  .object({
    algorithm: z.string().describe("The algorithm that produced `state`."),
    state: z.unknown().describe("The algorithm's per-player state."),
    skill: z.number().describe("The conservative skill number the state yields."),
    xp: z.number().describe("The experience total in the pool."),
    games: z.number().int().describe("How many rated games count toward the rating."),
  })
  .describe("One player's rating at a moment.");
export type RatingSnapshotView = z.infer<typeof RatingSnapshotView>;

/** What a recalculate or a reset returns. */
export const RatingAdjustmentResponse = z
  .object({
    pool: z.string().describe("The pool."),
    userId: z.string().describe("The player."),
    act: RatingAdjustmentAct.describe("The act."),
    reason: z.string().describe("The reason, verbatim."),
    before: RatingSnapshotView.nullable().describe("The rating the act found."),
    after: RatingSnapshotView.describe("The rating the act left."),
    at: z.string().describe("When the act ran, ISO-8601."),
    replayed: z
      .boolean()
      .describe(
        "True when the idempotency key was already spent: nothing changed this time, and this is what the first request did.",
      ),
  })
  .describe("What one act on a rating did.");
export type RatingAdjustmentResponse = z.infer<typeof RatingAdjustmentResponse>;

/** One player a void recalculated. */
export const RatingVoidedPlayer = z
  .object({
    pool: z.string().describe("The pool."),
    userId: z.string().describe("The player."),
    before: RatingSnapshotView.nullable().describe("The rating before the void, or null when none was stored."),
    after: RatingSnapshotView.describe("The rating the remaining outcomes add up to."),
  })
  .describe("One player a void recalculated, before and after.");
export type RatingVoidedPlayer = z.infer<typeof RatingVoidedPlayer>;

/** What voiding a result did to rating — the consumer's report in a void cascade. */
export const RatingVoidReport = z
  .object({
    resultId: z.string().describe("The result voided."),
    outcomes: z
      .number()
      .int()
      .describe("How many outcomes this void marked. 0 when the result was already void, or rating never saw it."),
    players: z.array(RatingVoidedPlayer).describe("Every player recalculated."),
  })
  .describe("What voiding one result did to rating: the outcomes marked and every player recalculated.");
export type RatingVoidReport = z.infer<typeof RatingVoidReport>;
