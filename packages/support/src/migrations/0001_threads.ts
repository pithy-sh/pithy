// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * The support inbox: threads, their messages, attachment metadata, the append-only classification
 * history, and per-viewer flags.
 *
 * **The indexes are the point of this migration, not an afterthought.** The dashboard's entire
 * interaction is "inbox, newest first, filtered by category and priority and archived" — a query
 * workload, and one that is miserable to retrofit once a table has rows in production. So the two
 * composite indexes the issue names are created here, in the first migration, alongside the tables.
 *
 * camelCase identifiers throughout; `CamelCasePlugin` snake-cases them in the DDL. `down` is the
 * tested inverse — indexes first, then tables, children before parents.
 *
 * **No CHECK constraints, deliberately.** CLAUDE.md's rule is that one Zod schema per table is the
 * entire table definition, and a CHECK mirroring a `z.enum` or a `SQLiteBoolean` is a second, partial
 * copy of that definition — one that can drift from the schema and that SQLite cannot alter, so
 * adding a priority level or a sentiment would mean a table rebuild rather than a one-line edit to
 * the enum. Every value here reaches SQLite through `Schema.encode`, so the schema already refuses
 * what a CHECK would have. The three bounds that were doing real work — both `confidence` ranges and
 * the attachment `size` floor — moved into the schemas, which is where they belonged.
 *
 * A CHECK still earns its place for an invariant Zod genuinely cannot express: `@pithy-sh/ledger`
 * constrains `held <= balance` across columns, which no per-field schema can state.
 */
export const support_0001_threads: Migration = {
  up: async (db: Kysely<unknown>): Promise<void> => {
    await db.schema
      .createTable("pithySupportThreads")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("channel", "text", (c) => c.notNull().defaultTo("email"))
      // Nullable, unlike every other address on this table: an `app` thread in a project with no
      // inbound address configured never arrived anywhere, and collecting in-app feedback with no mail
      // set up at all is a deployment this capability supports.
      .addColumn("inboxAddress", "text")
      .addColumn("subject", "text", (c) => c.notNull())
      .addColumn("fromAddress", "text", (c) => c.notNull())
      .addColumn("fromName", "text")
      .addColumn("senderAuthenticated", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("userId", "text")
      .addColumn("accountLinkSource", "text")
      .addColumn("category", "text", (c) => c.notNull().defaultTo("uncategorized"))
      .addColumn("priority", "text", (c) => c.notNull().defaultTo("normal"))
      .addColumn("sentiment", "text", (c) => c.notNull().defaultTo("neutral"))
      .addColumn("confidence", "real")
      .addColumn("model", "text")
      .addColumn("classifiedAt", "integer")
      .addColumn("archived", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("archivedAt", "integer")
      .addColumn("archivedBy", "text")
      .addColumn("messageCount", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("firstMessageAt", "integer", (c) => c.notNull())
      .addColumn("lastMessageAt", "integer", (c) => c.notNull())
      .addColumn("createdAt", "integer", (c) => c.notNull())
      .addColumn("updatedAt", "integer", (c) => c.notNull())
      .execute();

    // The inbox itself: open threads, newest first. `id` rides along as the pagination tiebreak, so
    // the cursor read is covered by the index rather than sorting rows it had to fetch first.
    await db.schema
      .createIndex("pithySupportThreadsArchivedIdx")
      .on("pithySupportThreads")
      .columns(["archived", "lastMessageAt", "id"])
      .execute();
    // The filtered inbox. Category is the filter people actually use, and it is the one the issue
    // names, so it gets its own composite rather than relying on the archived index plus a scan.
    await db.schema
      .createIndex("pithySupportThreadsCategoryIdx")
      .on("pithySupportThreads")
      .columns(["category", "lastMessageAt", "id"])
      .execute();
    // The sender's history — what the volume guard counts and what a thread view shows beside the
    // current conversation.
    await db.schema
      .createIndex("pithySupportThreadsFromIdx")
      .on("pithySupportThreads")
      .columns(["fromAddress", "lastMessageAt"])
      .execute();
    // "Everything from this customer", once the sender has been linked to an account.
    await db.schema.createIndex("pithySupportThreadsUserIdx").on("pithySupportThreads").column("userId").execute();
    // The console's channel filter, and the submitter's own list. Both read one channel newest-first,
    // so this carries the same `(lastMessageAt, id)` tail as the archived and category composites —
    // an index on `channel` alone would filter and then sort rows it had to fetch first.
    await db.schema
      .createIndex("pithySupportThreadsChannelIdx")
      .on("pithySupportThreads")
      .columns(["channel", "lastMessageAt", "id"])
      .execute();
    // The read-back: this account's own app threads, newest first. Keyed on the pair rather than on
    // `userId` alone because the read-back is scoped to both — an email thread linked to an account by
    // an unproven header must never be readable by whoever currently holds that address.
    await db.schema
      .createIndex("pithySupportThreadsUserChannelIdx")
      .on("pithySupportThreads")
      .columns(["userId", "channel", "lastMessageAt", "id"])
      .execute();

    await db.schema
      .createTable("pithySupportMessages")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("threadId", "text", (c) => c.notNull())
      .addColumn("direction", "text", (c) => c.notNull())
      .addColumn("channel", "text", (c) => c.notNull().defaultTo("email"))
      .addColumn("submittedByUserId", "text")
      .addColumn("context", "text")
      .addColumn("mimeMessageId", "text")
      .addColumn("mimeInReplyTo", "text")
      .addColumn("mimeReferences", "text")
      .addColumn("fromAddress", "text", (c) => c.notNull())
      .addColumn("fromName", "text")
      // Nullable for the same reason `pithy_support_threads.inbox_address` is: an app submission has
      // no envelope recipient. It stays in the unique index below — SQLite treats two NULLs as
      // distinct, so app rows never collide there.
      .addColumn("toAddress", "text")
      .addColumn("subject", "text", (c) => c.notNull())
      .addColumn("textBody", "text", (c) => c.notNull())
      .addColumn("htmlBody", "text")
      .addColumn("emailJobId", "text")
      .addColumn("rawKey", "text")
      .addColumn("rawBytes", "integer")
      .addColumn("receivedAt", "integer", (c) => c.notNull())
      .addColumn("createdAt", "integer", (c) => c.notNull())
      .execute();

    // The idempotency anchor. Email Routing can deliver the same message twice, and the second
    // delivery has to be a no-op rather than a duplicate in somebody's inbox. SQLite permits repeated
    // NULLs in a unique index, so a message with no `Message-ID` still stores.
    //
    // Keyed on `(mimeMessageId, toAddress)` rather than the id alone, matching the ingest lookup. A
    // Worker may serve several inboxes, and a customer who addresses one message to both `support@`
    // and `security@` causes two legitimate deliveries of the same `Message-ID` — a global key would
    // reject the second, so the message would land in one inbox and silently never reach the other.
    await db.schema
      .createIndex("pithySupportMessagesMimeIdIdx")
      .on("pithySupportMessages")
      .columns(["mimeMessageId", "toAddress"])
      .unique()
      .execute();
    // The thread view, in order.
    await db.schema
      .createIndex("pithySupportMessagesThreadIdx")
      .on("pithySupportMessages")
      .columns(["threadId", "receivedAt"])
      .execute();
    // Threading's fallback lookup: find the message an `In-Reply-To` or a `References` entry names.
    await db.schema
      .createIndex("pithySupportMessagesInReplyToIdx")
      .on("pithySupportMessages")
      .column("mimeInReplyTo")
      .execute();
    // What the volume guard counts: messages from one address inside a window.
    await db.schema
      .createIndex("pithySupportMessagesFromIdx")
      .on("pithySupportMessages")
      .columns(["fromAddress", "receivedAt"])
      .execute();
    // What the *submission* guard counts: one account's app submissions inside a window. The app
    // channel's bound is per account rather than per address, because the account is what a session
    // proves and what an adopter can revoke — so it needs its own index rather than the address one.
    await db.schema
      .createIndex("pithySupportMessagesSubmitterIdx")
      .on("pithySupportMessages")
      .columns(["submittedByUserId", "receivedAt"])
      .execute();
    // The mail guard counts only mail. Both rate bounds filter on `channel` so that neither surface
    // can starve the other — heavy in-app feedback must never lock a real customer out of the inbox,
    // and a mail flood must never stop the app's own users reporting the outage.
    await db.schema
      .createIndex("pithySupportMessagesChannelIdx")
      .on("pithySupportMessages")
      .columns(["channel", "direction", "receivedAt"])
      .execute();

    await db.schema
      .createTable("pithySupportAttachments")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("messageId", "text", (c) => c.notNull())
      .addColumn("threadId", "text", (c) => c.notNull())
      .addColumn("filename", "text", (c) => c.notNull())
      .addColumn("contentType", "text", (c) => c.notNull())
      .addColumn("size", "integer", (c) => c.notNull())
      .addColumn("sha256", "text", (c) => c.notNull())
      .addColumn("storageKey", "text", (c) => c.notNull())
      .addColumn("contentId", "text")
      .addColumn("inline", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("createdAt", "integer", (c) => c.notNull())
      .execute();

    await db.schema
      .createIndex("pithySupportAttachmentsMessageIdx")
      .on("pithySupportAttachments")
      .column("messageId")
      .execute();
    await db.schema
      .createIndex("pithySupportAttachmentsThreadIdx")
      .on("pithySupportAttachments")
      .column("threadId")
      .execute();

    await db.schema
      .createTable("pithySupportClassifications")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("threadId", "text", (c) => c.notNull())
      .addColumn("messageId", "text", (c) => c.notNull())
      .addColumn("category", "text", (c) => c.notNull())
      .addColumn("priority", "text", (c) => c.notNull())
      .addColumn("sentiment", "text", (c) => c.notNull())
      .addColumn("confidence", "real", (c) => c.notNull())
      .addColumn("model", "text", (c) => c.notNull())
      .addColumn("createdAt", "integer", (c) => c.notNull())
      .execute();

    await db.schema
      .createIndex("pithySupportClassificationsThreadIdx")
      .on("pithySupportClassifications")
      .columns(["threadId", "createdAt"])
      .execute();
    // "Which rows came from which model" — the query a reclassification pass after a model upgrade
    // is planned from, and the reason the column exists at all.
    await db.schema
      .createIndex("pithySupportClassificationsModelIdx")
      .on("pithySupportClassifications")
      .columns(["model", "createdAt"])
      .execute();

    await db.schema
      .createTable("pithySupportThreadFlags")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("threadId", "text", (c) => c.notNull())
      .addColumn("viewer", "text", (c) => c.notNull())
      .addColumn("read", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("snoozedUntil", "integer")
      .addColumn("createdAt", "integer", (c) => c.notNull())
      .addColumn("updatedAt", "integer", (c) => c.notNull())
      .execute();

    // One row per viewer per thread, so marking read twice is an upsert rather than a second row.
    await db.schema
      .createIndex("pithySupportThreadFlagsViewerIdx")
      .on("pithySupportThreadFlags")
      .columns(["threadId", "viewer"])
      .unique()
      .execute();
  },

  down: async (db: Kysely<unknown>): Promise<void> => {
    await db.schema.dropIndex("pithySupportThreadFlagsViewerIdx").execute();
    await db.schema.dropTable("pithySupportThreadFlags").execute();

    await db.schema.dropIndex("pithySupportClassificationsModelIdx").execute();
    await db.schema.dropIndex("pithySupportClassificationsThreadIdx").execute();
    await db.schema.dropTable("pithySupportClassifications").execute();

    await db.schema.dropIndex("pithySupportAttachmentsThreadIdx").execute();
    await db.schema.dropIndex("pithySupportAttachmentsMessageIdx").execute();
    await db.schema.dropTable("pithySupportAttachments").execute();

    await db.schema.dropIndex("pithySupportMessagesChannelIdx").execute();
    await db.schema.dropIndex("pithySupportMessagesSubmitterIdx").execute();
    await db.schema.dropIndex("pithySupportMessagesFromIdx").execute();
    await db.schema.dropIndex("pithySupportMessagesInReplyToIdx").execute();
    await db.schema.dropIndex("pithySupportMessagesThreadIdx").execute();
    await db.schema.dropIndex("pithySupportMessagesMimeIdIdx").execute();
    await db.schema.dropTable("pithySupportMessages").execute();

    await db.schema.dropIndex("pithySupportThreadsUserChannelIdx").execute();
    await db.schema.dropIndex("pithySupportThreadsChannelIdx").execute();
    await db.schema.dropIndex("pithySupportThreadsUserIdx").execute();
    await db.schema.dropIndex("pithySupportThreadsFromIdx").execute();
    await db.schema.dropIndex("pithySupportThreadsCategoryIdx").execute();
    await db.schema.dropIndex("pithySupportThreadsArchivedIdx").execute();
    await db.schema.dropTable("pithySupportThreads").execute();
  },
};
