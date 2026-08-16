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
 *
 * **This is the capability's whole schema for this database, in one migration, and that is the rule
 * while nothing is published.** CONTRIBUTING.md §Migrations states it and
 * `packages/cli/src/migrations/oneMigration.test.ts` enforces it: a chain buys exactly one thing —
 * walking a database that already holds rows from an old shape to a new one — and there is no such
 * database, so a `0002` would be a step from a shape that never ran to a shape that never shipped.
 *
 * **Amended in place on 2026-08-16** for `correlation` (pithy-sh/pithy#382), and the condition was
 * checked rather than assumed, because CONTRIBUTING.md asks a later reader to check it:
 *
 * - `@pithy-sh/email` is at `0.0.0` and `npm view @pithy-sh/email version` is a 404. Nothing has been
 *   released, so no `0200_email_0001_init` has run anywhere a chain would be replayed against.
 * - The only adopter is `pithy-sh/dashboard`, and `GET /accounts/602df2e6ce74e98b4c7ac5e90a3af5c8/d1/database`
 *   — the account `apps/board/pithy.config.ts` pins, not whatever wrangler is logged in to — returns an
 *   **empty list**. There is no deployed D1 at all, so none holds a `pithy_email_jobs` row.
 *
 * **The moment either stops being true this file is history, and the chain is append-only.** A version
 * cut, or one database on that account, and the next column is a `0002`. Nothing about a tidy `0001`
 * tells a reader which side of that line they are on — re-run the two checks, do not infer them.
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
      // What the message was *about*, as the caller names it — the discriminator for a template that
      // carries more than one kind of message (pithy-sh/pithy#382). Six of the dashboard's account
      // notices ride one `operationalNotice` to the same addresses, so `(recipient_key, template)`
      // cannot separate them and `sentSince` could not answer the question it was built for. And the
      // failure was not a duplicate: that caller uses the answer *positively* — the correction letter
      // goes out only when the letter it corrects already did — so an under-report withholds the
      // correction from somebody holding a letter that has stopped being true.
      //
      // Nullable with no default, the shape `pithy_audit_events.tenant` takes for an action that was
      // not tenant-scoped: most templates say what they are by their id alone, and null is the true
      // statement about those. Deliberately **not** `campaign_id`, which is marketing attribution and
      // leaves this row — onto every event, into `campaignStats`, and signed into the tracking token
      // that travels in a delivered email's URLs. This column goes nowhere but here.
      .addColumn("correlation", "text")
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

    // The other axis of the same read, and the same argument. `sentSince` also asks *what has been said
    // about this thing since an instant* — the question a template carrying six different messages needs
    // — and without an index that is the same full scan on the same decision path. It leads with
    // `correlation` because a correlation names one subject and is selective by construction, where a
    // template id is one of a handful a project has.
    await db.schema
      .createIndex("pithyEmailJobsCorrelationIdx")
      .on("pithyEmailJobs")
      .columns(["correlation", "createdAt"])
      .execute();
  },
  down: async (db: Kysely<unknown>): Promise<void> => {
    await db.schema.dropIndex("pithyEmailJobsCorrelationIdx").execute();
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
