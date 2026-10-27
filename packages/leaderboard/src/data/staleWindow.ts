// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import { z } from "zod";

/**
 * A window whose stored ranks an act or a void invalidated — the row in `pithy_leaderboard_stale_windows`
 * (#817).
 *
 * The refresh pass renumbers the window open now and nothing else, because nothing else moves on its own.
 * A moderator moves a closed one: cheating is usually found after the week it happened in, and hiding last
 * week's #1 leaves every stored rank below it one place out. So the act writes this row in the same
 * `d1.batch()` as its change, and the next pass renumbers every window it names, then deletes the rows it
 * read. A row marked again while the pass ran is newer than the one it read, so it survives for the next.
 *
 * One row per window, whatever touched it, so the table is as large as the set of windows waiting for a
 * pass, and empty between passes.
 */
export const LeaderboardStaleWindow = z
  .object({
    boardId: z.string().describe("The board whose window needs renumbering."),
    windowKey: z.string().describe("The window whose stored ranks are out of date."),
    markedAt: SQLiteDate.describe("When the last act or void touched it. A pass clears only what it read."),
  })
  .describe("One window waiting for the rank refresh to renumber it.");
export type LeaderboardStaleWindow = z.output<typeof LeaderboardStaleWindow>;
export type LeaderboardStaleWindowRow = z.input<typeof LeaderboardStaleWindow>;
