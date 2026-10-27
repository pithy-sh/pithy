// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import { z } from "zod";
import { ScoreAggregation } from "../config/config";

/**
 * What one result put on one entry — the row in `pithy_leaderboard_contributions` (#817).
 *
 * An entry is the fold of every submission a player made in a window, so on a `sum` board — the shape a
 * multiplayer points board takes by default — the entry alone cannot say what any one session added.
 * This row can. It is written in the same `d1.batch()` as the entry upsert, only for a submission that came
 * from a result, and it is what lets a void take back one session's points without taking the player's
 * whole running total with it.
 *
 * Unique on `(resultId, boardId, windowKey, userId)`, which is also what makes a retried publish a no-op:
 * the second write finds the row and folds nothing.
 */
export const LeaderboardContribution = z
  .object({
    id: z.number().int().describe("Autoincrement primary key. Internal only."),
    resultId: z
      .string()
      .describe("The result that submitted this score — a `@pithy-sh/multiplayer` session id, or your own."),
    boardId: z.string().describe("The board the result submitted to."),
    windowKey: z.string().describe("The window the result submitted into."),
    userId: z.string().describe("The player the result scored."),
    score: z.number().describe("The score this result submitted, before the board folded it in."),
    aggregation: ScoreAggregation.describe(
      "How the board folded it, recorded with it, so a void undoes it the same way without reading config.",
    ),
    createdAt: SQLiteDate.describe("When the result submitted it."),
  })
  .describe("One result's submission to one entry — what a void takes back.");
export type LeaderboardContribution = z.output<typeof LeaderboardContribution>;
export type LeaderboardContributionRow = z.input<typeof LeaderboardContribution>;
