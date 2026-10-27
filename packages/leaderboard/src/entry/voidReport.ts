// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";

/**
 * What the leaderboard did when a result was voided — the consumer half of `@pithy-sh/multiplayer`'s void
 * cascade (#817, #820).
 *
 * A Zod object rather than an interface because the cascade reports it, consumer by consumer, to a
 * management client that validates what comes back. It imports nothing but Zod, so a browser program can
 * name it. **A field added here later is `.optional()`**, for the reason `http/responses.ts` gives.
 */

/** An entry the void removed, because the voided result alone held its score. */
export const VoidedEntry = z
  .object({
    board: z.string().describe("The board's key."),
    window: z.string().describe("The window the entry was in."),
    userId: z.string().describe("The player whose entry was removed."),
    score: z.number().describe("The score the entry held when it was removed."),
  })
  .describe("An entry the void removed.");
export type VoidedEntry = z.infer<typeof VoidedEntry>;

/** A `sum` entry the void took the result's points back out of, and left standing. */
export const AdjustedEntry = z
  .object({
    board: z.string().describe("The board's key."),
    window: z.string().describe("The window the entry is in."),
    userId: z.string().describe("The player whose entry was adjusted."),
    before: z.number().describe("The entry's score before the voided result's points came out."),
    after: z.number().describe("The entry's score now."),
  })
  .describe("A `sum` entry the void subtracted a result's points from.");
export type AdjustedEntry = z.infer<typeof AdjustedEntry>;

export const LeaderboardVoidReport = z
  .object({
    resultId: z.string().describe("The voided result."),
    removed: z.array(VoidedEntry).describe("Every entry the void removed. Empty when there was none."),
    adjusted: z.array(AdjustedEntry).describe("Every `sum` entry the void adjusted. Empty when there was none."),
  })
  .describe(
    "What the leaderboard took back for one voided result. Ranks recompute on the next read of a `live` board, and on the next refresh pass of a materialized one, whose stored rank for each adjusted entry is cleared.",
  );
export type LeaderboardVoidReport = z.infer<typeof LeaderboardVoidReport>;
