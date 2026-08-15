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
      // The recipient under `normalizeAddress`, stored rather than derived. `toAddress` keeps the
      // string the caller typed; this is what anything matching a recipient compares against, and
      // `lower(to_address)` is not a substitute — SQLite's `lower()` folds ASCII only.
      .addColumn("recipientKey", "text", (c) => c.notNull())
      .addColumn("fromAddress", "text", (c) => c.notNull())
      .addColumn("fromName", "text", (c) => c.notNull())
      .addColumn("subject", "text", (c) => c.notNull())
      .addColumn("template", "text", (c) => c.notNull())
      .addColumn("category", "text", (c) => c.notNull())
      .addColumn("payload", "text", (c) => c.notNull())
      // Null while the job still holds its inputs; stamped when they are dropped. A separate column
      // rather than an inference off `payload = '{}'`, because a job enqueued with no variables and a
      // job whose variables were spent are different facts and an operator reading a blank render needs
      // to tell them apart.
      .addColumn("payloadRedactedAt", "integer")
      .addColumn("status", "text", (c) => c.notNull())
      .addColumn("mode", "text", (c) => c.notNull())
      .addColumn("attempts", "integer", (c) => c.notNull().defaultTo(0))
      // The send batch holding this job, which is the id of the send Workflow instance dispatched for
      // it. Null until something claims the job. Unindexed on purpose: nothing queries by it — the
      // scheduler reads it off rows it has already selected and asks the Workflow runtime about them.
      .addColumn("batchId", "text")
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
      // Threading, for a reply that answers an existing conversation — `@pithy-sh/support` is what
      // needs them. A column per field rather than a generic headers bag (CLAUDE.md §Email): a bag
      // would let any caller set `Bcc` or `From` on a message the adopter's domain signs, which turns
      // an enqueue into a header-injection surface. Three named columns can only mean three things.
      .addColumn("replyTo", "text")
      .addColumn("inReplyTo", "text")
      .addColumn("references", "text")
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

    // The control-plane job listing pages newest-first, optionally filtered by status. `(status,
    // createdAt)` serves the filtered page and `createdAt` alone the unfiltered one — without them an
    // operator opening the pane scans every job the project has ever queued.
    await db.schema
      .createIndex("pithyEmailJobsStatusCreatedIdx")
      .on("pithyEmailJobs")
      .columns(["status", "createdAt"])
      .execute();
    await db.schema.createIndex("pithyEmailJobsCreatedIdx").on("pithyEmailJobs").column("createdAt").execute();

    // `sentSince` asks one question — has this template already gone to this person since a given
    // instant — and asks it of a table holding every email the project ever queued. Without this the
    // question is a full scan, and it is asked on the path that decides whether to send another one.
    // Leading with the recipient rather than the template is what makes it selective: a project has a
    // handful of templates and an unbounded number of recipients.
    await db.schema
      .createIndex("pithyEmailJobsRecipientTemplateIdx")
      .on("pithyEmailJobs")
      .columns(["recipientKey", "template", "createdAt"])
      .execute();
  },
  down: async (db: Kysely<unknown>): Promise<void> => {
    await db.schema.dropIndex("pithyEmailJobsRecipientTemplateIdx").execute();
    await db.schema.dropIndex("pithyEmailJobsCreatedIdx").execute();
    await db.schema.dropIndex("pithyEmailJobsStatusCreatedIdx").execute();
    await db.schema.dropIndex("pithyEmailEventsJobIdIdx").execute();
    await db.schema.dropTable("pithyEmailEvents").execute();
    await db.schema.dropIndex("pithyEmailJobsMessageIdIdx").execute();
    await db.schema.dropIndex("pithyEmailJobsDueIdx").execute();
    await db.schema.dropTable("pithyEmailJobs").execute();
  },
};
