// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * Who has a thread (#816): the current assignee on `pithy_support_threads`, and every change of it in a
 * new append-only `pithy_support_assignments`.
 *
 * **A `0002`, appended, never folded into `0001`.** `@pithy-sh/support` has shipped, so its chain is
 * history.
 *
 * **Four nullable columns and no backfill.** Every thread that exists when this runs has no assignee, and
 * null is exactly that.
 *
 * **One index for the filter.** The inbox lists `archived`, newest first, and `assignee=<ref>` narrows it;
 * `(assigneeRef, archived, lastMessageAt, id)` serves that page and its cursor the way
 * `pithySupportThreadsArchivedIdx` serves the unfiltered one. `assignee=none` reads the unfiltered index
 * and is a residual predicate on it.
 */
export const support_0002_assignment: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema.alterTable("pithySupportThreads").addColumn("assigneeRef", "text").execute();
    await db.schema.alterTable("pithySupportThreads").addColumn("assigneeName", "text").execute();
    await db.schema.alterTable("pithySupportThreads").addColumn("assignedAt", "integer").execute();
    await db.schema.alterTable("pithySupportThreads").addColumn("assignedBy", "text").execute();
    await db.schema
      .createIndex("pithySupportThreadsAssigneeIdx")
      .on("pithySupportThreads")
      .columns(["assigneeRef", "archived", "lastMessageAt", "id"])
      .execute();

    await db.schema
      .createTable("pithySupportAssignments")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("threadId", "text", (c) => c.notNull())
      .addColumn("assigneeRef", "text")
      .addColumn("assigneeName", "text")
      .addColumn("previousRef", "text")
      .addColumn("previousName", "text")
      .addColumn("actorType", "text", (c) => c.notNull())
      .addColumn("assignedBy", "text", (c) => c.notNull())
      .addColumn("note", "text")
      .addColumn("createdAt", "integer", (c) => c.notNull())
      .execute();
    // A thread's history, oldest first — the only way this table is read.
    await db.schema
      .createIndex("pithySupportAssignmentsThreadIdx")
      .on("pithySupportAssignments")
      .columns(["threadId", "createdAt"])
      .execute();
  },
  async down(db: Kysely<unknown>): Promise<void> {
    // The exact inverse, in reverse. The index goes before its columns, because SQLite refuses to drop a
    // column an index still names.
    await db.schema.dropIndex("pithySupportAssignmentsThreadIdx").execute();
    await db.schema.dropTable("pithySupportAssignments").execute();
    await db.schema.dropIndex("pithySupportThreadsAssigneeIdx").execute();
    await db.schema.alterTable("pithySupportThreads").dropColumn("assignedBy").execute();
    await db.schema.alterTable("pithySupportThreads").dropColumn("assignedAt").execute();
    await db.schema.alterTable("pithySupportThreads").dropColumn("assigneeName").execute();
    await db.schema.alterTable("pithySupportThreads").dropColumn("assigneeRef").execute();
  },
};
