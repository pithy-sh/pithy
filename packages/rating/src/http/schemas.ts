import { z } from "zod";

/**
 * HTTP-boundary shapes for the rating routes. Declared on the route line with
 * `zValidator(target, Schema, validationHook)`, so a malformed request becomes a
 * `validation/invalid_input` 400 before any handler runs, never an unhandled throw.
 *
 * The param schemas are **shape** checks, not existence checks: they bound what may reach a store or a
 * config lookup. Resolving a game key against the configured games stays in the handler, and an unknown
 * game is still a `rating/game_not_found` 404.
 */

/**
 * A game key is a URL path segment, so it is lowercase, digits, and dashes — the same shape
 * `RatingGame.key` enforces at config assembly. A key that cannot be configured cannot resolve, so
 * bounding the segment here rejects it a step earlier without narrowing what already works.
 */
const GAME_KEY = /^[a-z0-9][a-z0-9-]*$/;

export const RatingGameParams = z
  .object({
    game: z
      .string()
      .max(64)
      .regex(GAME_KEY, "A game key is lowercase, digits, and dashes — it is a URL path segment.")
      .describe("The configured game the request addresses. Resolved against the games in the handler."),
  })
  .describe("The path params of a game-scoped rating route.");
export type RatingGameParams = z.output<typeof RatingGameParams>;

export const RatingPlayerParams = z
  .object({
    game: z
      .string()
      .max(64)
      .regex(GAME_KEY, "A game key is lowercase, digits, and dashes — it is a URL path segment.")
      .describe("The configured game the request addresses. Resolved against the games in the handler."),
    userId: z
      .string()
      .min(1)
      .max(200)
      .describe("The player whose standing is read. Opaque to this capability — bounded, not parsed."),
  })
  .describe("The path params of a read of one player's standing in a game.");
export type RatingPlayerParams = z.output<typeof RatingPlayerParams>;

export const RecordOutcomeBody = z
  .object({
    ranks: z
      .record(z.string(), z.number().int().min(1))
      .describe("Each player's finishing place, keyed by user id — 1 is the winner, ties share a place."),
    teams: z
      .record(z.string(), z.string())
      .optional()
      .describe("Optional team grouping (player id → team id), for a team format."),
    sharedRoom: z
      .boolean()
      .optional()
      .describe("Whether the game was played in a shared room with a friend. Gates XP/rank, never the skill rating."),
  })
  .describe("The body of a record-outcome request — the result of one rated game.");
export type RecordOutcomeBody = z.output<typeof RecordOutcomeBody>;
