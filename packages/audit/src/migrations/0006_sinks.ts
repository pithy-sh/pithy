// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import { type Kysely, sql } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * Shipping's delivery state — `#824`.
 *
 * One table, `pithy_audit_sinks`, one row per declared sink: what the manifest's health keys report. Nothing in it
 * is the trail, and nothing in the trail changes. **Appended, never folded into `0001`**: audit has shipped.
 */
export const audit_0006_sinks: Migration = {
  up: async (db: Kysely<unknown>): Promise<void> => {
    await db.schema
      .createTable("pithyAuditSinks")
      .addColumn("sink", "text", (col) => col.primaryKey())
      .addColumn("lastDeliveredAt", "integer")
      .addColumn("lastFailedAt", "integer")
      .addColumn("retrying", "integer", (col) => col.notNull().defaultTo(sql`0`))
      .addColumn("deadLettered", "integer", (col) => col.notNull().defaultTo(sql`0`))
      .execute();
  },

  down: async (db: Kysely<unknown>): Promise<void> => {
    await db.schema.dropTable("pithyAuditSinks").execute();
  },
};
