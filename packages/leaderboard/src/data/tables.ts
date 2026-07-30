// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { createDatabase, type DatabaseSchema } from "@pithy-sh/core/src/data/db";
import type { Kysely } from "kysely";
import type { z } from "zod";
import { LeaderboardBoardRecord } from "./boardRecord";
import { LeaderboardEntry } from "./entry";
import { LeaderboardLock } from "./lock";

/** The entry table. `CamelCasePlugin` snake-cases it to `pithy_leaderboard_entries` in the DDL. */
export const LEADERBOARD_ENTRIES_TABLE = "pithyLeaderboardEntries";
/** The board drift-guard table. `CamelCasePlugin` snake-cases it to `pithy_leaderboard_boards`. */
export const LEADERBOARD_BOARDS_TABLE = "pithyLeaderboardBoards";
/** The advisory-lock table. `CamelCasePlugin` snake-cases it to `pithy_leaderboard_locks`. */
export const LEADERBOARD_LOCKS_TABLE = "pithyLeaderboardLocks";

/** The leaderboard tables map. All are always present — none is behind a config flag. */
export function leaderboardTables(): Record<string, z.ZodObject> {
  return {
    [LEADERBOARD_ENTRIES_TABLE]: LeaderboardEntry,
    [LEADERBOARD_BOARDS_TABLE]: LeaderboardBoardRecord,
    [LEADERBOARD_LOCKS_TABLE]: LeaderboardLock,
  };
}

/** The typed Kysely database over the leaderboard tables. */
export type LeaderboardTables = {
  [LEADERBOARD_ENTRIES_TABLE]: typeof LeaderboardEntry;
  [LEADERBOARD_BOARDS_TABLE]: typeof LeaderboardBoardRecord;
  [LEADERBOARD_LOCKS_TABLE]: typeof LeaderboardLock;
};
export type LeaderboardDatabase = Kysely<DatabaseSchema<LeaderboardTables>>;

/** Build the leaderboard database from the `DB` binding (CamelCasePlugin installed). */
export function leaderboardDatabase(d1: D1Database): LeaderboardDatabase {
  return createDatabase(d1, {
    [LEADERBOARD_ENTRIES_TABLE]: LeaderboardEntry,
    [LEADERBOARD_BOARDS_TABLE]: LeaderboardBoardRecord,
    [LEADERBOARD_LOCKS_TABLE]: LeaderboardLock,
  }) as unknown as LeaderboardDatabase;
}
