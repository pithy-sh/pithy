// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import { z } from "zod";

/**
 * A single-row advisory lock in `pithy_leaderboard_locks` — the row in the table, one per lock name.
 *
 * It serializes the rank-refresh Workflow: at most one instance holds the `rank-refresh` lock at a time,
 * so two overlapping cron fires can never interleave their chunked rank writes into an incoherent set.
 *
 * `z.output` is the app shape (a Date); `z.input` is the SQLite row (ms-epoch). Conversion runs through
 * the core codec, per the round-trip rule.
 */
export const LeaderboardLock = z
  .object({
    name: z.string().describe("The lock's identity — `rank-refresh` for the refresh pass. One row per name."),
    holder: z.string().describe("A token unique to the instance currently holding the lock."),
    acquiredAt: SQLiteDate.describe(
      "When the current holder took the lock. A lock older than the stale horizon is treated as abandoned by a crashed instance and may be reclaimed.",
    ),
  })
  .describe("One advisory lock in `pithy_leaderboard_locks`.");
export type LeaderboardLock = z.output<typeof LeaderboardLock>;
export type LeaderboardLockRow = z.input<typeof LeaderboardLock>;
