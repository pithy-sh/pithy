// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";

/**
 * What the leaderboard routes return, as Zod objects a client can validate against and the OpenAPI
 * contract can describe.
 *
 * `schemas.ts` bounds what a caller may send; this file states what it gets back. These describe JSON on
 * the wire, so a date is the ISO-8601 string `c.json` writes, and nothing here carries a codec or a
 * transform: parsing a response hands back exactly what went in, which is what lets
 * `routes.workers.test.ts` parse a real answer and compare it with the original.
 *
 * **A field added here later is `.optional()` as well as `.nullable()`.** A client generated from the
 * contract reads Workers on older releases too, and a required key they cannot send fails it outright.
 */

/** One ranked player on a board. */
export const RankedEntryView = z
  .object({
    userId: z.string().describe("The player's id, from `@pithy-sh/auth`."),
    score: z.number().describe("The player's score in this window, after the board's aggregation."),
    achievedAt: z.iso.datetime().describe("When the score that counts was recorded, ISO-8601."),
    rank: z.number().int().describe("Position on the board, from 1. Ties share a rank."),
    tier: z.string().nullable().describe("The tier the score falls in, or null when the board has no tiers."),
  })
  .describe("One ranked player on a board.");
export type RankedEntryView = z.infer<typeof RankedEntryView>;

/** A page of a board: the top, a segment, or the players around the caller. */
export const BoardPage = z
  .object({
    board: z.string().describe("The board's key."),
    window: z
      .string()
      .describe("The window this page reads: the key of a scheduled window, or `all` for an all-time board."),
    entries: z.array(RankedEntryView).describe("The entries, best first."),
  })
  .describe("A page of ranked entries from one board and window.");
export type BoardPage = z.infer<typeof BoardPage>;

/** The caller's own standing on a board. */
export const OwnRank = z
  .object({
    board: z.string().describe("The board's key."),
    window: z.string().describe("The window read."),
    userId: z.string().describe("The caller's id."),
    score: z.number().describe("The caller's score in this window."),
    rank: z.number().int().nullable().describe("The caller's position, from 1, or null while it is not ranked yet."),
    tier: z.string().nullable().describe("The caller's tier, or null when the board has no tiers."),
    visible: z.boolean().describe("Whether the caller appears to other players. False after they opted out."),
    rankStale: z.boolean().describe("True when `rank` came from the stored column and may lag the score beside it."),
  })
  .describe("The caller's own standing on a board.");
export type OwnRank = z.infer<typeof OwnRank>;

/** What a score submission returns. */
export const SubmitResult = z
  .object({ window: z.string().describe("The window the score was recorded in.") })
  .describe("The score was recorded.");
export type SubmitResult = z.infer<typeof SubmitResult>;

/** What setting the caller's own visibility returns. */
export const VisibilityResult = z
  .object({ visible: z.boolean().describe("The caller's visibility, as now stored.") })
  .describe("The caller's visibility was set.");
export type VisibilityResult = z.infer<typeof VisibilityResult>;

/** What hiding an entry returns. */
export const HideResult = z
  .object({ hidden: z.boolean().describe("Whether the entry is now hidden from other players.") })
  .describe("The entry's moderation state was set.");
export type HideResult = z.infer<typeof HideResult>;

/** What removing an entry returns. */
export const RemoveResult = z
  .object({ removed: z.boolean().describe("True when an entry existed and is gone; false when there was none.") })
  .describe("The entry was removed, or there was none.");
export type RemoveResult = z.infer<typeof RemoveResult>;

/** One configured board, as a board picker needs it. */
export const BoardSummary = z
  .object({
    key: z.string().describe("The board's key. What every other route takes as `:board`."),
    store: z.string().describe("Where the board's entries live. Always `d1` today."),
    direction: z.string().describe("`desc` when a higher score ranks first, `asc` when a lower one does."),
    aggregation: z.string().describe("How repeat submissions combine: `best`, `latest` or `sum`."),
    window: z
      .string()
      .nullable()
      .describe("The UTC CRON expression marking where each window opens, or null for an all-time board."),
    tiers: z
      .array(
        z
          .object({
            key: z.string().describe("The tier's key."),
            from: z.number().describe("The score at which the tier begins, inclusive, read in the board's direction."),
          })
          .describe("One tier."),
      )
      .describe("The board's tiers, worst to best. Empty when it has none."),
  })
  .describe("One configured board.");
export type BoardSummary = z.infer<typeof BoardSummary>;

/** Every configured board. */
export const BoardList = z
  .object({ boards: z.array(BoardSummary).describe("Every board this Worker serves.") })
  .describe("The configured boards.");
export type BoardList = z.infer<typeof BoardList>;
