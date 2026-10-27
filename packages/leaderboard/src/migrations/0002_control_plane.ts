// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { type Kysely, sql } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * The management surface's tables (#817): which result wrote an entry, what each result contributed, and
 * the moderation history.
 *
 * **Appended, never folded into `0001`.** The leaderboard has shipped, so its first migration is history.
 *
 * - `entries.resultId` is nullable with no default and no backfill: every entry before this one came from a
 *   plain submission or from a publish that never said which session it was, and null says exactly that.
 *   Its index is **partial**, over the rows that carry one, so a plain submission still writes the rows it
 *   wrote before — `entry/writeAmplification.workers.test.ts` holds the cost model to that.
 * - `contributions` is written only by a result-sourced submission, so a board nobody publishes results to
 *   never grows it.
 * - `moderations` is one row per management act, and its unique key is the idempotency record.
 * - `staleWindows` names each window an act or a void left with out-of-date stored ranks, until the next
 *   refresh pass renumbers it. Keyed on the window, so it is never larger than the set of windows waiting.
 *
 * camelCase identifiers; `CamelCasePlugin` snake-cases them in the DDL. `down` is the tested inverse.
 */
export const leaderboard_0002_control_plane: Migration = {
  up: async (db: Kysely<unknown>): Promise<void> => {
    await db.schema.alterTable("pithyLeaderboardEntries").addColumn("resultId", "text").execute();
    await db.schema
      .createIndex("pithyLeaderboardEntriesResultIdx")
      .on("pithyLeaderboardEntries")
      .column("resultId")
      .where(sql.ref("resultId"), "is not", null)
      .execute();

    await db.schema
      .createTable("pithyLeaderboardContributions")
      // Plain INTEGER PRIMARY KEY, not autoincrement — the same reasoning as the entries table.
      .addColumn("id", "integer", (c) => c.primaryKey())
      .addColumn("resultId", "text", (c) => c.notNull())
      .addColumn("boardId", "text", (c) => c.notNull())
      .addColumn("windowKey", "text", (c) => c.notNull())
      .addColumn("userId", "text", (c) => c.notNull())
      .addColumn("score", "real", (c) => c.notNull())
      .addColumn("aggregation", "text", (c) => c.notNull())
      .addColumn("createdAt", "integer", (c) => c.notNull())
      .execute();
    // Leads with the result, which is how a void reads it, and is unique over the entry it touched, which
    // is what makes a retried publish fold nothing.
    await db.schema
      .createIndex("pithyLeaderboardContributionsResultIdx")
      .on("pithyLeaderboardContributions")
      .columns(["resultId", "boardId", "windowKey", "userId"])
      .unique()
      .execute();
    // The other direction: what is left in one entry once a result is taken out of it.
    await db.schema
      .createIndex("pithyLeaderboardContributionsEntryIdx")
      .on("pithyLeaderboardContributions")
      .columns(["boardId", "windowKey", "userId"])
      .execute();

    await db.schema
      .createTable("pithyLeaderboardModerations")
      .addColumn("id", "integer", (c) => c.primaryKey())
      .addColumn("idempotencyKey", "text", (c) => c.notNull().unique())
      .addColumn("act", "text", (c) => c.notNull())
      .addColumn("boardId", "text")
      .addColumn("windowKey", "text")
      .addColumn("userId", "text")
      .addColumn("lockName", "text")
      .addColumn("reason", "text", (c) => c.notNull())
      .addColumn("before", "text", (c) => c.notNull())
      .addColumn("after", "text")
      .addColumn("changed", "integer", (c) => c.notNull())
      .addColumn("connectionId", "text", (c) => c.notNull())
      .addColumn("actorId", "text", (c) => c.notNull())
      .addColumn("createdAt", "integer", (c) => c.notNull())
      .execute();
    // An entry's history, newest first.
    await db.schema
      .createIndex("pithyLeaderboardModerationsEntryIdx")
      .on("pithyLeaderboardModerations")
      .columns(["boardId", "windowKey", "userId", "createdAt"])
      .execute();

    await db.schema
      .createTable("pithyLeaderboardStaleWindows")
      .addColumn("boardId", "text", (c) => c.notNull())
      .addColumn("windowKey", "text", (c) => c.notNull())
      .addColumn("markedAt", "integer", (c) => c.notNull())
      .addPrimaryKeyConstraint("pithyLeaderboardStaleWindowsPk", ["boardId", "windowKey"])
      .execute();
  },

  down: async (db: Kysely<unknown>): Promise<void> => {
    await db.schema.dropTable("pithyLeaderboardStaleWindows").execute();
    await db.schema.dropIndex("pithyLeaderboardModerationsEntryIdx").execute();
    await db.schema.dropTable("pithyLeaderboardModerations").execute();
    await db.schema.dropIndex("pithyLeaderboardContributionsEntryIdx").execute();
    await db.schema.dropIndex("pithyLeaderboardContributionsResultIdx").execute();
    await db.schema.dropTable("pithyLeaderboardContributions").execute();
    await db.schema.dropIndex("pithyLeaderboardEntriesResultIdx").execute();
    // In place, as audit's `0002` drops its column: D1's engine supports it, and a rebuild would rewrite
    // every entry to remove one column.
    await db.schema.alterTable("pithyLeaderboardEntries").dropColumn("resultId").execute();
  },
};
