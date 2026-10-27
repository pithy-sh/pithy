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
  .object({
    removed: z
      .boolean()
      .describe(
        "Always true: the entry existed and is gone. An entry that does not exist is a 404, `leaderboard/entry_not_found`.",
      ),
  })
  .describe("The entry was removed.");
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

// --- The management surface (#817) -------------------------------------------------------------------
//
// Read by a management client across a version boundary, so a field added to any of these later is
// `.optional()` as well as `.nullable()` (CLAUDE.md §HTTP).

/** One configured board, as a management pane needs it. */
export const AdminBoardView = z
  .object({
    key: z.string().describe("The board's key. What every other management route takes as `:board`."),
    store: z.string().describe("Where the board's entries live. Always `d1` today."),
    direction: z.enum(["asc", "desc"]).describe("`desc` when a higher score ranks first, `asc` when a lower one does."),
    aggregation: z.enum(["best", "latest", "sum"]).describe("How repeat submissions combine."),
    window: z
      .string()
      .nullable()
      .describe("The UTC CRON expression marking where each window opens, or null for an all-time board."),
    currentWindow: z.string().describe("The key of the window open now, or `all` on an all-time board."),
    min: z.number().nullable().describe("The lowest score the board accepts, or null when it has no floor."),
    max: z.number().nullable().describe("The highest score the board accepts, or null when it has no ceiling."),
    rank: z
      .enum(["live", "materialized"])
      .describe(
        "How the board ranks: `live` counts on every read, `materialized` stores a rank its refresh pass renumbers.",
      ),
  })
  .describe("One configured board, with the window open now.");
export type AdminBoardView = z.infer<typeof AdminBoardView>;

export const AdminBoardList = z
  .object({ boards: z.array(AdminBoardView).describe("Every board this Worker serves, in config order.") })
  .describe("The configured boards.");
export type AdminBoardList = z.infer<typeof AdminBoardList>;

/** One entry, with everything a moderator needs to decide about it. */
export const AdminEntryView = z
  .object({
    userId: z.string().describe("The player's id."),
    score: z.number().describe("The entry's score, after the board's aggregation."),
    rank: z
      .number()
      .int()
      .nullable()
      .describe("The entry's position, counted live, from 1; null while it is hidden or the player opted out."),
    achievedAt: z.iso.datetime().describe("When the score that counts was first reached, ISO-8601. The tiebreak."),
    submittedAt: z.iso.datetime().describe("When the entry was last written, ISO-8601."),
    visible: z.boolean().describe("Whether the player consents to appear. Theirs to set."),
    hidden: z.boolean().describe("Whether a moderator has hidden the entry. Only a moderator clears it."),
    resultId: z
      .string()
      .nullable()
      .describe(
        "The result that wrote the score this entry holds, such as a multiplayer session id; null for a plain submission.",
      ),
  })
  .describe("One entry on a board, with its moderation state.");
export type AdminEntryView = z.infer<typeof AdminEntryView>;

export const AdminEntriesPage = z
  .object({
    board: z.string().describe("The board's key."),
    window: z.string().describe("The window read."),
    entries: z.array(AdminEntryView).describe("The entries in the board's order, best first, hidden ones in place."),
    nextCursor: z
      .string()
      .nullable()
      .describe("Where the next page resumes, or null at the end of the board. Opaque; hand it back verbatim."),
  })
  .describe("A page of one window of a board.");
export type AdminEntriesPage = z.infer<typeof AdminEntriesPage>;

/** A held lock. */
export const AdminLockView = z
  .object({
    name: z
      .string()
      .describe("The lock's name. `rank-refresh` is the only one: it serializes the refresh across every board."),
    holder: z.string().describe("The token of the refresh instance holding it. What a clear must name."),
    acquiredAt: z.iso.datetime().describe("When the holder took it, ISO-8601. A refresh releases it when it finishes."),
  })
  .describe("A held rank-refresh lock.");
export type AdminLockView = z.infer<typeof AdminLockView>;

export const AdminLockList = z
  .object({
    locks: z
      .array(AdminLockView)
      .describe("Every lock held now. Empty when no refresh is running and none was left behind."),
  })
  .describe("The rank-refresh locks held now.");
export type AdminLockList = z.infer<typeof AdminLockList>;

/** An entry's moderated state. */
export const AdminEntryState = z
  .object({
    score: z.number().describe("The entry's score."),
    visible: z.boolean().describe("Whether the player consents to appear."),
    hidden: z.boolean().describe("Whether a moderator has hidden the entry."),
  })
  .describe("An entry's score and moderation state.");
export type AdminEntryState = z.infer<typeof AdminEntryState>;

/** What hiding, unhiding or correcting an entry answers. */
export const AdminModerationResult = z
  .object({
    act: z.enum(["hide", "unhide", "correct"]).describe("What was done."),
    board: z.string().describe("The board's key."),
    window: z.string().describe("The window the entry is in."),
    userId: z.string().describe("The player whose entry it is."),
    before: AdminEntryState.describe("What the act found. On a correction, the original score."),
    after: AdminEntryState.describe("What the act left."),
    reason: z.string().describe("The reason the act was recorded with."),
    changed: z
      .boolean()
      .describe("False when the entry was already where the act asked to put it. Nothing was written or emitted."),
    replayed: z
      .boolean()
      .describe("True when this idempotency key was seen before, and this is the first request's answer."),
    ranks: z
      .enum(["live", "next-refresh"])
      .describe(
        "When ranks reflect the act: `live` on the next read, or `next-refresh` when the board's stored rank is renumbered by its next refresh pass, a closed window's included.",
      ),
  })
  .describe("A moderation act's outcome.");
export type AdminModerationResult = z.infer<typeof AdminModerationResult>;

/** What clearing a lock answers. */
export const AdminLockClearResult = z
  .object({
    lock: AdminLockView.describe("The lock as it was before it was cleared."),
    reason: z.string().describe("The reason the clear was recorded with."),
    replayed: z
      .boolean()
      .describe("True when this idempotency key was seen before, and this is the first request's answer."),
  })
  .describe("The lock was cleared. The next refresh pass takes it fresh.");
export type AdminLockClearResult = z.infer<typeof AdminLockClearResult>;
