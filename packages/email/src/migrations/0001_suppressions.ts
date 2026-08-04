// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * Create the global suppression table in the dedicated, durable `EMAIL_SUPPRESSIONS` database —
 * distinct from the per-environment app `DB`, because an address that hard-bounced, complained, or
 * unsubscribed must never be emailed from *any* environment. Mirrors the shared-DB pattern of
 * `@pithy-sh/secrets`. The single inbound bounce worker and the unsubscribe callbacks write it; every
 * environment's send path reads it.
 */
export const email_0001_suppressions: Migration = {
  up: async (db: Kysely<unknown>): Promise<void> => {
    await db.schema
      .createTable("pithyEmailSuppressions")
      .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
      .addColumn("email", "text", (c) => c.notNull().unique())
      .addColumn("reason", "text", (c) => c.notNull())
      .addColumn("jobId", "text")
      .addColumn("environment", "text")
      .addColumn("detail", "text")
      .addColumn("createdAt", "integer", (c) => c.notNull())
      .addColumn("expiresAt", "integer")
      .execute();

    // The control-plane suppression listing pages newest-first. The unique index on `email` already
    // serves the single-address lookup; this serves the walk.
    await db.schema
      .createIndex("pithyEmailSuppressionsCreatedIdx")
      .on("pithyEmailSuppressions")
      .column("createdAt")
      .execute();
  },
  down: async (db: Kysely<unknown>): Promise<void> => {
    await db.schema.dropIndex("pithyEmailSuppressionsCreatedIdx").execute();
    await db.schema.dropTable("pithyEmailSuppressions").execute();
  },
};
