// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Logger } from "@pithy-sh/core/src/logger/logger";
import { type SqlBool, sql } from "kysely";
import { SupportAttachment } from "../data/attachment";
import type { SupportChannel, SupportPriority, SupportSentiment } from "../data/enums";
import { SupportMessage } from "../data/message";
import {
  SUPPORT_ATTACHMENTS_TABLE,
  SUPPORT_FLAGS_TABLE,
  SUPPORT_MESSAGES_TABLE,
  SUPPORT_SEARCH_TABLE,
  SUPPORT_THREADS_TABLE,
  type SupportDatabase,
} from "../data/tables";
import { SupportThread } from "../data/thread";
import { SupportNotFoundError } from "../error/errors";
import { isSearchable, searchPredicate } from "./search";

/**
 * The inbox query — the one read this whole data model was shaped around.
 *
 * ## Cursor pagination, never offset
 *
 * `OFFSET` is wrong here for a reason specific to an inbox: rows are inserted at the *front* of the
 * order the list is sorted by, so every message that arrives while somebody is reading shifts every
 * subsequent page down by one. The reader sees a thread twice and misses another, and the misses are
 * silent. A cursor on `(lastMessageAt, id)` describes a position in the data rather than a count of
 * rows skipped, so new mail arriving above it changes nothing about what comes next.
 *
 * `id` is in the cursor because `lastMessageAt` is not unique — two messages landing in the same
 * millisecond is unlikely and a page boundary landing between them is exactly where it would show up
 * as a dropped row.
 */

/** How many threads a page holds by default. */
export const DEFAULT_PAGE_SIZE = 25;
/** The most a caller may ask for in one page. */
export const MAX_PAGE_SIZE = 100;

/** An opaque position in the inbox ordering. */
export interface ThreadCursor {
  /** The `lastMessageAt` of the last thread on the previous page, as ms-epoch. */
  lastMessageAt: number;
  /** That thread's id — the tiebreak that makes the position exact. */
  id: string;
}

/**
 * Encode a cursor for the wire.
 *
 * Base64url over JSON, and **opaque by intent rather than by obscurity**: the point is that a client
 * cannot construct one by hand and therefore cannot come to depend on its shape, so the ordering can
 * change later without breaking every caller. It is not a secret — it holds a timestamp and an id
 * the caller was just given.
 */
export function encodeCursor(cursor: ThreadCursor): string {
  return btoa(JSON.stringify(cursor)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Decode a cursor. Returns undefined for anything malformed — a bad cursor is a first page, not a 500. */
export function decodeCursor(value: string | undefined): ThreadCursor | undefined {
  if (!value) return undefined;
  try {
    const json = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const { lastMessageAt, id } = parsed as Partial<ThreadCursor>;
    if (typeof lastMessageAt !== "number" || typeof id !== "string") return undefined;
    return { lastMessageAt, id };
  } catch {
    return undefined;
  }
}

/** What a caller may filter the inbox by. */
export interface ListThreadsQuery {
  /** Open threads, done threads, or both. Defaults to open. */
  archived?: boolean;
  /** One category key from the effective taxonomy. */
  category?: string;
  /** One priority. */
  priority?: SupportPriority;
  /** One sentiment. */
  sentiment?: SupportSentiment;
  /** One channel — mail, or what signed-in users filed from inside the app. */
  channel?: SupportChannel;
  /** Which inbox address, for a Worker serving more than one. */
  inbox?: string;
  /** Free text over subjects and bodies. */
  q?: string;
  /** Where to resume from. */
  cursor?: string;
  /** How many to return. */
  limit?: number;
}

/** A thread as the inbox lists it — the row, plus this viewer's own private state. */
export interface ListedThread extends SupportThread {
  /** Whether this viewer has read it. False when they have no flag row, which is the common case. */
  read: boolean;
  /** When this viewer's snooze expires, or null. */
  snoozedUntil: Date | null;
}

/** One page of the inbox. */
export interface ThreadPage {
  /** The threads, newest first. */
  threads: ListedThread[];
  /** The cursor for the next page, or null when this was the last one. */
  nextCursor: string | null;
}

/**
 * List threads, as one viewer sees them.
 *
 * The viewer is a parameter rather than an afterthought because the per-viewer flags are **read
 * here**: a snooze that was stored and never consulted is a button that does nothing, and `read` that
 * is never projected is a column a dashboard cannot render. Both are left-joined, so a thread with no
 * flag row for this viewer — the overwhelming majority — still appears, unread and unsnoozed.
 */
export async function listThreads(
  db: SupportDatabase,
  query: ListThreadsQuery,
  options: { fts: boolean; viewer: string; now: Date; log?: Logger },
): Promise<ThreadPage> {
  try {
    return await runListThreads(db, query, options);
  } catch (error) {
    // **The index being configured on is not the same as the index existing.**
    //
    // `search.fts` is a config flag while the virtual table is a provisioned resource, and the two can disagree
    // in both directions: a project that turned the flag on but has not migrated yet, a database
    // restored from a snapshot taken before it, a Worker deployed ahead of `pithy migrate`. In every
    // one of those the flag says FTS and the schema says no such table.
    //
    // Falling back to the `LIKE` scan makes that a slower search rather than a 500 on the inbox
    // route. Narrow on purpose: only a missing-table error is caught, so a genuine query bug still
    // surfaces instead of silently degrading forever.
    if (options.fts && isMissingSearchTable(error)) {
      options.log?.warn("support FTS index is configured but absent — falling back to a LIKE scan", {
        action: "Run `pithy support provision` to create and backfill it, or set `search.fts: false`.",
      });
      return runListThreads(db, query, { ...options, fts: false });
    }
    throw error;
  }
}

/** Whether an error is SQLite saying the full-text index does not exist. */
function isMissingSearchTable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("no such table") && message.includes(SUPPORT_SEARCH_TABLE);
}

/** The listing itself, for one chosen search backend. */
async function runListThreads(
  db: SupportDatabase,
  query: ListThreadsQuery,
  options: { fts: boolean; viewer: string; now: Date },
): Promise<ThreadPage> {
  const limit = Math.min(Math.max(query.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const cursor = decodeCursor(query.cursor);

  let builder = db
    .selectFrom(SUPPORT_THREADS_TABLE)
    // Joined on the viewer as well as the thread, so one operator's snooze never hides a thread from
    // anybody else — the whole reason these flags are per viewer rather than on the thread.
    .leftJoin(SUPPORT_FLAGS_TABLE, (join) =>
      join
        .onRef(`${SUPPORT_FLAGS_TABLE}.threadId`, "=", `${SUPPORT_THREADS_TABLE}.id`)
        .on(`${SUPPORT_FLAGS_TABLE}.viewer`, "=", options.viewer),
    )
    .selectAll(SUPPORT_THREADS_TABLE)
    .select([`${SUPPORT_FLAGS_TABLE}.read as viewerRead`, `${SUPPORT_FLAGS_TABLE}.snoozedUntil as viewerSnoozedUntil`])
    // A snooze that has not expired hides the thread from this viewer. Expiry is evaluated on read
    // rather than swept, so nothing has to run for a snooze to end.
    .where((eb) =>
      eb.or([
        eb(`${SUPPORT_FLAGS_TABLE}.snoozedUntil`, "is", null),
        eb(`${SUPPORT_FLAGS_TABLE}.snoozedUntil`, "<=", options.now.getTime()),
      ]),
    )
    // Archived is a filter with a default rather than an optional one: an inbox that showed resolved
    // threads by default would be an inbox nobody trusts to be a work queue.
    .where(`${SUPPORT_THREADS_TABLE}.archived`, "=", query.archived === true ? 1 : 0);

  if (query.category !== undefined) builder = builder.where(`${SUPPORT_THREADS_TABLE}.category`, "=", query.category);
  if (query.priority !== undefined) builder = builder.where(`${SUPPORT_THREADS_TABLE}.priority`, "=", query.priority);
  if (query.sentiment !== undefined)
    builder = builder.where(`${SUPPORT_THREADS_TABLE}.sentiment`, "=", query.sentiment);
  if (query.channel !== undefined) builder = builder.where(`${SUPPORT_THREADS_TABLE}.channel`, "=", query.channel);
  if (query.inbox !== undefined) builder = builder.where(`${SUPPORT_THREADS_TABLE}.inboxAddress`, "=", query.inbox);
  if (query.q !== undefined) {
    if (isSearchable(query.q, options.fts)) {
      builder = builder.where(searchPredicate(query.q, options));
    } else {
      // A term that tokenizes to nothing — `???`, `@@@` — asked a question with no answer, and the
      // honest answer is none. Dropping the predicate instead would hand back the *entire* unfiltered
      // inbox rendered as search results, which is the one direction a filter must never fail in:
      // silently widening reads as "this is what matched" rather than as an error.
      builder = builder.where(sql<SqlBool>`1 = 0`);
    }
  }

  if (cursor) {
    // Strictly after the cursor position in the descending order: an older timestamp, or the same
    // timestamp with a smaller id. Written as the row-value comparison SQLite can satisfy from the
    // `(archived, last_message_at, id)` index rather than as an OR it would have to scan.
    builder = builder.where((eb) =>
      eb.or([
        eb(`${SUPPORT_THREADS_TABLE}.lastMessageAt`, "<", cursor.lastMessageAt),
        eb.and([
          eb(`${SUPPORT_THREADS_TABLE}.lastMessageAt`, "=", cursor.lastMessageAt),
          eb(`${SUPPORT_THREADS_TABLE}.id`, "<", cursor.id),
        ]),
      ]),
    );
  }

  // One more than asked for, so "is there a next page" is a fact rather than a second count query
  // that could disagree with the page it describes.
  const rows = await builder
    .orderBy(`${SUPPORT_THREADS_TABLE}.lastMessageAt`, "desc")
    .orderBy(`${SUPPORT_THREADS_TABLE}.id`, "desc")
    .limit(limit + 1)
    .execute();

  const page: ListedThread[] = rows.slice(0, limit).map((row) => ({
    ...SupportThread.parse(row),
    // A viewer with no flag row has read nothing and snoozed nothing, which is the common case and
    // the right default — not an absence a caller has to interpret.
    read: row.viewerRead === 1,
    snoozedUntil: row.viewerSnoozedUntil == null ? null : new Date(Number(row.viewerSnoozedUntil)),
  }));
  const last = page[page.length - 1];
  return {
    threads: page,
    nextCursor:
      rows.length > limit && last ? encodeCursor({ lastMessageAt: last.lastMessageAt.getTime(), id: last.id }) : null,
  };
}

/** A thread with everything a reading pane shows. */
export interface ThreadDetail {
  /** The thread row. */
  thread: SupportThread;
  /** Its messages, oldest first — a conversation reads downward. */
  messages: SupportMessage[];
  /** Its attachments, across every message. */
  attachments: SupportAttachment[];
}

/** Read one thread in full. Throws `support/not_found` when it does not exist. */
export async function readThread(db: SupportDatabase, threadId: string): Promise<ThreadDetail> {
  const row = await db.selectFrom(SUPPORT_THREADS_TABLE).selectAll().where("id", "=", threadId).executeTakeFirst();
  if (!row) throw new SupportNotFoundError({ detail: `no support thread ${threadId}` });

  const [messages, attachments] = await Promise.all([
    db
      .selectFrom(SUPPORT_MESSAGES_TABLE)
      .selectAll()
      .where("threadId", "=", threadId)
      .orderBy("receivedAt", "asc")
      .orderBy("id", "asc")
      .execute(),
    db.selectFrom(SUPPORT_ATTACHMENTS_TABLE).selectAll().where("threadId", "=", threadId).execute(),
  ]);

  return {
    thread: SupportThread.parse(row),
    messages: messages.map((message) => SupportMessage.parse(message)),
    attachments: attachments.map((attachment) => SupportAttachment.parse(attachment)),
  };
}

/**
 * List one account's own in-app conversations.
 *
 * **Two conditions on the `where`, and the second is not redundant.** `userId` alone would also return
 * every *email* thread this capability linked to the account — and that link was matched against an
 * address in a header nobody proved, so it names an account the sender merely claimed to be. Serving
 * those to whoever currently holds the address would turn the mail path's known weakness into a read
 * primitive, which is precisely the trade this channel exists to avoid making.
 *
 * Archived threads are included, unlike the operator inbox. An inbox hides done threads because it is a
 * work queue; a person looking at their own requests is looking for the one that was answered.
 */
export async function listOwnThreads(
  db: SupportDatabase,
  userId: string,
  query: { cursor?: string; limit?: number },
): Promise<{ threads: SupportThread[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(query.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const cursor = decodeCursor(query.cursor);

  let builder = db
    .selectFrom(SUPPORT_THREADS_TABLE)
    .selectAll()
    .where("userId", "=", userId)
    .where("channel", "=", "app");

  if (cursor) {
    builder = builder.where((eb) =>
      eb.or([
        eb("lastMessageAt", "<", cursor.lastMessageAt),
        eb.and([eb("lastMessageAt", "=", cursor.lastMessageAt), eb("id", "<", cursor.id)]),
      ]),
    );
  }

  const rows = await builder
    .orderBy("lastMessageAt", "desc")
    .orderBy("id", "desc")
    .limit(limit + 1)
    .execute();
  const page = rows.slice(0, limit).map((row) => SupportThread.parse(row));
  const last = page[page.length - 1];
  return {
    threads: page,
    nextCursor:
      rows.length > limit && last ? encodeCursor({ lastMessageAt: last.lastMessageAt.getTime(), id: last.id }) : null,
  };
}

/**
 * Read one of an account's own in-app conversations.
 *
 * **A 404 for somebody else's thread, never a 403.** The two are the same answer on purpose: a 403
 * confirms the id names a real conversation, and on an inbox of other people's correspondence that
 * confirmation is itself the disclosure. The scoping is in the `where`, not in a check after the read,
 * so there is no version of this that fetches the row first and forgets to compare.
 */
export async function readOwnThread(db: SupportDatabase, threadId: string, userId: string): Promise<ThreadDetail> {
  const row = await db
    .selectFrom(SUPPORT_THREADS_TABLE)
    .selectAll()
    .where("id", "=", threadId)
    .where("userId", "=", userId)
    .where("channel", "=", "app")
    .executeTakeFirst();
  if (!row) throw new SupportNotFoundError({ detail: `no app thread ${threadId} owned by ${userId}` });

  const [messages, attachments] = await Promise.all([
    db
      .selectFrom(SUPPORT_MESSAGES_TABLE)
      .selectAll()
      .where("threadId", "=", threadId)
      .orderBy("receivedAt", "asc")
      .orderBy("id", "asc")
      .execute(),
    db.selectFrom(SUPPORT_ATTACHMENTS_TABLE).selectAll().where("threadId", "=", threadId).execute(),
  ]);

  return {
    thread: SupportThread.parse(row),
    messages: messages.map((message) => SupportMessage.parse(message)),
    attachments: attachments.map((attachment) => SupportAttachment.parse(attachment)),
  };
}

/**
 * Mark a thread done, or reopen it.
 *
 * The one shared piece of state in the model, and the write is unconditional rather than a
 * compare-and-set: archiving something already archived is not a conflict, it is the same outcome,
 * and a support console that threw on a double-click would be worse than one that did nothing.
 */
export async function setArchived(
  db: SupportDatabase,
  threadId: string,
  archived: boolean,
  viewer: string,
  now: Date,
): Promise<SupportThread> {
  const existing = await db.selectFrom(SUPPORT_THREADS_TABLE).selectAll().where("id", "=", threadId).executeTakeFirst();
  if (!existing) throw new SupportNotFoundError({ detail: `no support thread ${threadId}` });

  await db
    .updateTable(SUPPORT_THREADS_TABLE)
    .set({
      archived: archived ? 1 : 0,
      archivedAt: archived ? now.getTime() : null,
      archivedBy: archived ? viewer : null,
      updatedAt: now.getTime(),
    })
    .where("id", "=", threadId)
    .execute();

  return SupportThread.parse({
    ...existing,
    archived: archived ? 1 : 0,
    archivedAt: archived ? now.getTime() : null,
    archivedBy: archived ? viewer : null,
    updatedAt: now.getTime(),
  });
}

/** Set one viewer's private flags on a thread. Upserts on `(threadId, viewer)`. */
export async function setFlags(
  db: SupportDatabase,
  options: {
    threadId: string;
    viewer: string;
    read?: boolean;
    snoozedUntil?: Date | null;
    newId: () => string;
    now: Date;
  },
): Promise<void> {
  // **No read.** Preserving an absent field inside the `doUpdateSet` rather than from a prior
  // `SELECT` is what makes a partial write safe: a dashboard that sends `{read}` and `{snoozedUntil}`
  // concurrently for one thread would otherwise have both calls read the same pre-state and both
  // write *both* columns from it, so whichever landed second would overwrite the other's column with
  // a stale value. Referring to the column itself means each call touches only what it was given.
  const thread = await db
    .selectFrom(SUPPORT_THREADS_TABLE)
    .select(["id"])
    .where("id", "=", options.threadId)
    .executeTakeFirst();
  if (!thread) throw new SupportNotFoundError({ detail: `no support thread ${options.threadId}` });

  const read = options.read === undefined ? undefined : options.read ? 1 : 0;
  const snoozed = options.snoozedUntil === undefined ? undefined : (options.snoozedUntil?.getTime() ?? null);

  await db
    .insertInto(SUPPORT_FLAGS_TABLE)
    .values({
      id: options.newId(),
      threadId: options.threadId,
      viewer: options.viewer,
      // The insert path has no existing row to preserve, so an absent field takes its default.
      read: read ?? 0,
      snoozedUntil: snoozed ?? null,
      createdAt: options.now.getTime(),
      updatedAt: options.now.getTime(),
    })
    .onConflict((oc) =>
      oc.columns(["threadId", "viewer"]).doUpdateSet((eb) => ({
        // `eb.ref` names the *stored* column, so an absent field is left exactly as it was rather
        // than rewritten from a value this call read moments ago.
        read: read === undefined ? eb.ref(`${SUPPORT_FLAGS_TABLE}.read`) : read,
        snoozedUntil: snoozed === undefined ? eb.ref(`${SUPPORT_FLAGS_TABLE}.snoozedUntil`) : snoozed,
        updatedAt: options.now.getTime(),
      })),
    )
    .execute();
}
