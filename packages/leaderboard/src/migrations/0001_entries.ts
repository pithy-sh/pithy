// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * The leaderboard tables: player entries, and the board drift guard.
 *
 * camelCase identifiers; `CamelCasePlugin` snake-cases them in the DDL. `down` is the tested inverse.
 */
export const leaderboard_0001_entries: Migration = {
  up: async (db: Kysely<unknown>): Promise<void> => {
    await db.schema
      .createTable("pithyLeaderboardEntries")
      // Plain INTEGER PRIMARY KEY (a rowid alias), deliberately NOT autoincrement. It still auto-assigns
      // ascending ids; autoincrement would only add a never-reuse-a-deleted-id guarantee we do not need
      // (the id is internal, never exposed) and would cost an extra `sqlite_sequence` row write on every
      // insert — and even on a guarded no-op upsert, since SQLite reserves the sequence value before it
      // detects the conflict. Dropping it makes a non-improving submission truly free.
      .addColumn("id", "integer", (c) => c.primaryKey())
      .addColumn("boardId", "text", (c) => c.notNull())
      .addColumn("windowKey", "text", (c) => c.notNull())
      .addColumn("userId", "text", (c) => c.notNull())
      .addColumn("score", "real", (c) => c.notNull())
      .addColumn("achievedAt", "integer", (c) => c.notNull())
      .addColumn("submittedAt", "integer", (c) => c.notNull())
      .addColumn("visible", "integer", (c) => c.notNull().defaultTo(1))
      .addColumn("hidden", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("rank", "integer")
      .execute();

    // One entry per player per window: the key the upsert-on-improve conflict target needs, and the
    // reason a window carries aggregation state rather than being a filter over an append log.
    await db.schema
      .createIndex("pithyLeaderboardEntriesPlayerIdx")
      .on("pithyLeaderboardEntries")
      .columns(["boardId", "windowKey", "userId"])
      .unique()
      .execute();

    // The ranking index. The ranking keys come LAST, after the equality-matched board and window:
    // SQLite uses a multi-column index only on a left-prefix subset, so a score-first index would sit
    // unused behind `board_id = ? AND window_key = ?`. The sort directions are deliberately mixed
    // (score DESC, achievedAt ASC on a `desc` board) because the tiebreak is earliest-achieved-wins;
    // that defeats SQLite's row-value comparison shortcut, so the rank predicate is spelled out as
    // `score > ? OR (score = ? AND achieved_at < ?) OR (...)` instead. `rank/plan.workers.test.ts`
    // reads EXPLAIN QUERY PLAN to prove this index is actually chosen rather than assuming it.
    await db.schema
      .createIndex("pithyLeaderboardEntriesRankIdx")
      .on("pithyLeaderboardEntries")
      .columns(["boardId", "windowKey", "score", "achievedAt"])
      .execute();

    await db.schema
      .createTable("pithyLeaderboardBoards")
      // Plain INTEGER PRIMARY KEY, not autoincrement — same reasoning as the entries table.
      .addColumn("id", "integer", (c) => c.primaryKey())
      .addColumn("boardKey", "text", (c) => c.notNull().unique())
      .addColumn("store", "text", (c) => c.notNull().defaultTo("d1"))
      .addColumn("direction", "text", (c) => c.notNull())
      .addColumn("aggregation", "text", (c) => c.notNull())
      .addColumn("window", "text")
      .addColumn("createdAt", "integer", (c) => c.notNull())
      .execute();

    // A single-row advisory lock so at most one rank-refresh Workflow instance runs at a time. Without
    // it, a cron that fires again before a refresh finishes would run two passes concurrently, and their
    // chunked writes would interleave into an incoherent rank set (duplicate/gapped numbers) until the
    // next fire. `name` is the lock's identity ("rank-refresh"); `holder` is the acquiring instance's
    // token; `acquiredAt` lets a stale lock from a crashed instance be reclaimed.
    await db.schema
      .createTable("pithyLeaderboardLocks")
      .addColumn("name", "text", (c) => c.primaryKey())
      .addColumn("holder", "text", (c) => c.notNull())
      .addColumn("acquiredAt", "integer", (c) => c.notNull())
      .execute();
  },
  down: async (db: Kysely<unknown>): Promise<void> => {
    await db.schema.dropTable("pithyLeaderboardLocks").execute();
    await db.schema.dropTable("pithyLeaderboardBoards").execute();
    await db.schema.dropIndex("pithyLeaderboardEntriesRankIdx").execute();
    await db.schema.dropIndex("pithyLeaderboardEntriesPlayerIdx").execute();
    await db.schema.dropTable("pithyLeaderboardEntries").execute();
  },
};
