// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * Create the per-environment email tables in the app database: `pithy_email_jobs` and
 * `pithy_email_events`. Both carry the `pithy_email_` prefix so they never clash with an adopter's own
 * tables. (Suppression lives in its own durable database — see `0001_suppressions.ts`.)
 *
 * Identifiers are declared in **camelCase**: the runner installs `CamelCasePlugin`, which snake-cases
 * every identifier in the emitted DDL (CLAUDE.md §Data layer). `down` is the tested inverse — indexes
 * then tables, in reverse creation order (D1 has no transactional DDL).
 */
export const email_0001_init: Migration = {
  up: async (db: Kysely<unknown>): Promise<void> => {
    await db.schema
      .createTable("pithyEmailJobs")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("toAddress", "text", (c) => c.notNull())
      .addColumn("fromAddress", "text", (c) => c.notNull())
      .addColumn("fromName", "text", (c) => c.notNull())
      .addColumn("subject", "text", (c) => c.notNull())
      .addColumn("template", "text", (c) => c.notNull())
      .addColumn("category", "text", (c) => c.notNull())
      .addColumn("payload", "text", (c) => c.notNull())
      .addColumn("status", "text", (c) => c.notNull())
      .addColumn("mode", "text", (c) => c.notNull())
      .addColumn("attempts", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("sendAt", "integer", (c) => c.notNull())
      .addColumn("timezone", "text")
      .addColumn("localTime", "text")
      .addColumn("campaignId", "text")
      .addColumn("openTracking", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("clickTracking", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("messageId", "text")
      .addColumn("error", "text")
      .addColumn("bounceCode", "text")
      .addColumn("bounceType", "text")
      .addColumn("createdAt", "integer", (c) => c.notNull())
      .addColumn("updatedAt", "integer", (c) => c.notNull())
      .addColumn("sentAt", "integer")
      .execute();

    // The scheduler scans for due rows by (status, sendAt); the bounce handler looks a job up by its
    // Email Service messageId.
    await db.schema.createIndex("pithyEmailJobsDueIdx").on("pithyEmailJobs").columns(["status", "sendAt"]).execute();
    await db.schema.createIndex("pithyEmailJobsMessageIdIdx").on("pithyEmailJobs").column("messageId").execute();

    await db.schema
      .createTable("pithyEmailEvents")
      .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
      .addColumn("jobId", "text", (c) => c.notNull())
      .addColumn("recipient", "text", (c) => c.notNull())
      .addColumn("type", "text", (c) => c.notNull())
      .addColumn("linkLabel", "text")
      .addColumn("linkUrl", "text")
      .addColumn("campaignId", "text")
      .addColumn("detail", "text")
      .addColumn("createdAt", "integer", (c) => c.notNull())
      .execute();

    await db.schema.createIndex("pithyEmailEventsJobIdIdx").on("pithyEmailEvents").column("jobId").execute();
  },
  down: async (db: Kysely<unknown>): Promise<void> => {
    await db.schema.dropIndex("pithyEmailEventsJobIdIdx").execute();
    await db.schema.dropTable("pithyEmailEvents").execute();
    await db.schema.dropIndex("pithyEmailJobsMessageIdIdx").execute();
    await db.schema.dropIndex("pithyEmailJobsDueIdx").execute();
    await db.schema.dropTable("pithyEmailJobs").execute();
  },
};
