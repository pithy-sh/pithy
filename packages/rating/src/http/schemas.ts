import { z } from "zod";

/**
 * HTTP-boundary shapes for the rating routes. Validated with `safeParse` → `fromZodError` so a malformed
 * body becomes a `validation/invalid_input` 400, never an unhandled throw.
 */

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
