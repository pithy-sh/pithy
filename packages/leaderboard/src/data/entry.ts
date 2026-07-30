// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { SQLiteBoolean, SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import { z } from "zod";

/**
 * One player's state on one board in one window — the row in `pithy_leaderboard_entries`.
 *
 * `z.output` is the app shape (Dates, booleans); `z.input` is the SQLite row (ms-epoch, 0|1). All
 * JS↔SQLite conversion runs through the core codecs — no raw `0/1`, epoch, or `new Date()` in query code.
 *
 * The entry is keyed `(boardId, windowKey, userId)`: each window carries its own aggregation state rather
 * than being a query-time filter over an append log. That is what makes `best` and `sum` expressible per
 * window at all, and what keeps a read O(one row) instead of O(a player's whole history).
 *
 * `id` is an autoincrement integer, not a UUID: an entry id is never handed to a client or embedded in a
 * URL — every route addresses an entry by its natural key — so there is nothing to enumerate.
 */
export const LeaderboardEntry = z
  .object({
    id: z.number().int().describe("Autoincrement primary key. Internal only; entries are addressed by natural key."),
    boardId: z.string().describe("The board key this entry ranks on, from `boards` in pithy.config.ts."),
    windowKey: z
      .string()
      .describe(
        "The window this entry belongs to: the ISO instant the board's CRON last fired at or before the score, or `all` on an all-time board.",
      ),
    userId: z
      .string()
      .describe(
        "The authenticated player, from the core AuthContext seam. Never read from the request body — that would let any caller score as anyone.",
      ),
    score: z
      .number()
      .describe("The player's current score for this window, already folded by the board's aggregation."),
    achievedAt: SQLiteDate.describe(
      "When the current score was first reached. The primary tiebreak: on equal scores the player who got there first ranks higher.",
    ),
    submittedAt: SQLiteDate.describe(
      "When this entry was last written. Distinct from achievedAt — a submission that fails to improve a `best` board still touches this.",
    ),
    visible: SQLiteBoolean.describe(
      "Whether the player consents to appear. Gates every read, including friends and segment queries.",
    ),
    hidden: SQLiteBoolean.describe(
      "Whether an admin has hidden this entry. Distinct from `visible` so a moderator action cannot be undone by the player toggling their own consent.",
    ),
    rank: z
      .number()
      .int()
      .nullish()
      .describe(
        "The materialized rank, refreshed by the rank worker. Null while rank is live, and null on a fresh entry until the next refresh pass reaches it.",
      ),
  })
  .describe("One player's entry on one board in one window — the row in `pithy_leaderboard_entries`.");
export type LeaderboardEntry = z.output<typeof LeaderboardEntry>;
export type LeaderboardEntryRow = z.input<typeof LeaderboardEntry>;
