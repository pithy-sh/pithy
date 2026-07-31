// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { type Expression, type SqlBool, sql } from "kysely";
import { SUPPORT_MESSAGES_TABLE, type SupportDatabase } from "../data/tables";

/**
 * Text search over the inbox — two backends behind one predicate.
 *
 * **`LIKE` is the default and FTS5 is the opt-in**, which is the opposite of what it looks like it
 * should be. The reason is in `store/searchIndex.ts`: an FTS5 virtual table anywhere in a D1
 * database makes `wrangler d1 export` refuse to dump *the whole database*, so turning it on by
 * default would quietly cost every adopter their backup story for tables that have nothing to do
 * with support. `LIKE` is an unindexed scan and is completely adequate for an inbox measured in
 * thousands of messages, which is what this capability is for.
 *
 * Both paths return a **predicate over `pithy_support_threads`**, not a list of ids, so search
 * composes with the category/archived filters and — crucially — with cursor pagination. Returning
 * ids would mean either capping the match set (silent truncation, which reads as "that is all there
 * is") or paginating twice over.
 *
 * Either way this is keyword search, deliberately. People search a support inbox for a word they
 * remember — an order number, an error string, a surname — not for a concept. `@pithy-sh/vector` is
 * there for anyone who wants meaning-matching, and it is the nicer demo and the wrong default: it
 * cannot find `ORD-40912`.
 */

/** The longest search term accepted. Bounded because it becomes a scan predicate. */
const MAX_TERM = 200;

/** Escape the `LIKE` wildcards so a term containing `%` matches a literal `%`. */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * Turn a user's words into an FTS5 MATCH expression.
 *
 * Every token is quoted and the whole thing is ANDed. Quoting is what stops FTS5's own query syntax
 * from leaking through: a bare `NOT`, `OR`, `*` or `(` is an operator to FTS5, so a customer whose
 * surname is a keyword — or anyone deliberately probing — would otherwise change the shape of the
 * query rather than search for a word. This is the same "input is data, never syntax" rule the rest
 * of the package applies to model output and to HTML.
 */
export function ftsQuery(term: string): string {
  const tokens = term
    .slice(0, MAX_TERM)
    // FTS5 tokenizes on non-alphanumerics anyway, so anything else is punctuation we would only be
    // handing to its parser.
    .split(/[^\p{L}\p{N}_-]+/u)
    .filter((token) => token.length > 0)
    .slice(0, 16);
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(" AND ");
}

/** Whether a term has anything searchable left after tokenizing. */
export function isSearchable(term: string, fts: boolean): boolean {
  return fts ? ftsQuery(term).length > 0 : term.trim().length > 0;
}

/**
 * A predicate matching threads whose messages contain `term`.
 *
 * Correlated on the thread id so it drops into a `where` beside every other filter. The subquery is
 * `exists`, so it stops at the first matching message rather than counting them.
 */
export function searchPredicate(term: string, options: { fts: boolean }): Expression<SqlBool> {
  if (options.fts) {
    // `<table> MATCH ?` naming the table in full is the documented FTS5 form, and the only one that
    // works: the hidden match column keeps the table's own name, so aliasing the table to `s` and
    // writing `s match ?` is `no such column: s`. `thread_id` is UNINDEXED, so the correlation is a
    // filter over the match set rather than part of the match.
    return sql<SqlBool>`exists (
      select 1 from pithy_support_search
      where pithy_support_search.thread_id = pithy_support_threads.id
        and pithy_support_search match ${ftsQuery(term)}
    )`;
  }
  const pattern = `%${escapeLike(term.slice(0, MAX_TERM))}%`;
  return sql<SqlBool>`exists (
    select 1 from pithy_support_messages m
    where m.thread_id = pithy_support_threads.id
      and (m.subject like ${pattern} escape '\\' or m.text_body like ${pattern} escape '\\')
  )`;
}

/**
 * Add a message to the full-text index, replacing any row already there for it.
 *
 * **Remove-then-insert, not a bare insert** — the same shape the CMS `syncFts` uses, and for the
 * reason application-managed indexes always need it: an FTS5 table has no primary key and no unique
 * constraint to lean on, so a second call for the same message would silently add a second copy and
 * the thread would start appearing twice in its own search results. Making the write idempotent means
 * a retry, a reindex, and a first index are all the same operation, which is the property every other
 * write path in this repo is built on.
 *
 * Best-effort by contract: a failed index write must never lose a customer's message, so the caller
 * logs and carries on — the row is still there, still readable, still repairable by
 * {@link reindexThread}, and only missing from one search box.
 */
export async function indexMessage(
  db: SupportDatabase,
  entry: { threadId: string; messageId: string; subject: string; body: string },
): Promise<void> {
  await sql`delete from pithy_support_search where message_id = ${entry.messageId}`.execute(db);
  await sql`
    insert into pithy_support_search(thread_id, message_id, subject, body)
    values (${entry.threadId}, ${entry.messageId}, ${entry.subject}, ${entry.body})
  `.execute(db);
}

/**
 * Rebuild the index for one thread — delete its rows, then re-add every message.
 *
 * The repair path for the failure mode application-side indexing has and triggers would not: a
 * message stored while the index write failed. Also what a reindex after a tokenizer change runs.
 */
export async function reindexThread(db: SupportDatabase, threadId: string): Promise<number> {
  // Clears by thread rather than relying on `indexMessage`'s per-message delete, so a row whose
  // message has since been removed goes too — that one is unreachable by any per-message call.
  await sql`delete from pithy_support_search where thread_id = ${threadId}`.execute(db);
  const messages = await db
    .selectFrom(SUPPORT_MESSAGES_TABLE)
    .select(["id", "threadId", "subject", "textBody"])
    .where("threadId", "=", threadId)
    .execute();
  for (const message of messages) {
    await indexMessage(db, {
      threadId: message.threadId,
      messageId: message.id,
      subject: message.subject,
      body: message.textBody,
    });
  }
  return messages.length;
}

/**
 * Rebuild the whole index from the messages table, in pages.
 *
 * **Creating the index is not the same as populating it**, and that gap is the one failure a search
 * box must not have: an adopter who turns `search.fts` on after mail already exists gets an empty
 * virtual table, and because the table now *exists* the `LIKE` fallback never fires — so the inbox
 * answers "no matches" for a term that is demonstrably in the body. Silently returning nothing is
 * worse than returning slowly, so provisioning backfills immediately after it creates.
 *
 * Paged on `(receivedAt, id)` rather than an offset, for the same reason the inbox is: rows arriving
 * during a long backfill would shift an offset underneath it and skip messages.
 */
export async function reindexAll(
  db: SupportDatabase,
  options: { pageSize?: number; onProgress?: (indexed: number) => void } = {},
): Promise<number> {
  const pageSize = options.pageSize ?? 200;
  // Cheaper and more obviously correct than deleting per message as we go: the index is derived, so
  // emptying it costs nothing that is not about to be rewritten.
  await sql`delete from pithy_support_search`.execute(db);

  let cursor: { receivedAt: number; id: string } | undefined;
  let indexed = 0;

  for (;;) {
    let page = db
      .selectFrom(SUPPORT_MESSAGES_TABLE)
      .select(["id", "threadId", "subject", "textBody", "receivedAt"])
      .orderBy("receivedAt", "asc")
      .orderBy("id", "asc")
      .limit(pageSize);
    if (cursor) {
      const at = cursor.receivedAt;
      const id = cursor.id;
      page = page.where((eb) =>
        eb.or([eb("receivedAt", ">", at), eb.and([eb("receivedAt", "=", at), eb("id", ">", id)])]),
      );
    }

    const rows = await page.execute();
    if (rows.length === 0) break;

    for (const row of rows) {
      await indexMessage(db, {
        threadId: row.threadId,
        messageId: row.id,
        subject: row.subject,
        body: row.textBody,
      });
      indexed += 1;
    }
    options.onProgress?.(indexed);

    const last = rows[rows.length - 1];
    if (!last || rows.length < pageSize) break;
    cursor = { receivedAt: Number(last.receivedAt), id: last.id };
  }

  return indexed;
}
