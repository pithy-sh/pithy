// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { type SqlBool, sql } from "kysely";
import { SUPPORT_MESSAGES_TABLE, type SupportDatabase } from "../data/tables";

/**
 * Keyword retrieval over the inbox — two backends behind one call.
 *
 * **FTS5 is the default and `LIKE` is the fallback.** The index lives in a virtual table that
 * `pithy support provision` creates beside its triggers, so a project that has not provisioned it — or
 * that set `search.fts: false` — searches with an unindexed `LIKE` scan, which is adequate for an inbox
 * measured in thousands of messages. `pithy backup` leaves the index out and `pithy restore` rebuilds it.
 *
 * **Both return messages, ranked, not threads.** A thread is scored by its best-matching message, and the
 * keyword half is fused with the semantic half by rank position in `store/hybrid.ts`. FTS5 ranks by `bm25`,
 * which is reported raw. `LIKE` has no score, so its matches rank by recency, newest first.
 *
 * Keyword search is first-class beside semantic search: people search a support inbox for a word they
 * remember — an order number, an error string, a surname — and semantic search cannot find `ORD-40912`.
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

/** One message a backend matched, in rank order. */
export interface MessageHit {
  /** The message. */
  messageId: string;
  /** Its thread. */
  threadId: string;
  /** The backend's own score for it, raw — `bm25` for FTS5, similarity for Vectorize, none for `LIKE`. */
  score?: number;
}

/** Which keyword backend answered. */
export type KeywordBackend = "fts" | "like";

/**
 * The messages matching `term`, best first, at most `limit` of them.
 *
 * A term that tokenizes to nothing — `???`, `@@@` — asked a question with no answer, and the honest answer
 * is none: never the whole inbox rendered as search results.
 */
export async function keywordHits(
  db: SupportDatabase,
  term: string,
  options: { backend: KeywordBackend; limit: number },
): Promise<MessageHit[]> {
  if (options.backend === "fts") {
    const match = ftsQuery(term);
    if (match.length === 0) return [];
    // `<table> MATCH ?` naming the table in full is the documented FTS5 form, and the only one that
    // works: the hidden match column keeps the table's own name. `bm25()` is lower-is-better, so the
    // ascending order is best first.
    const { rows } = await sql<{ messageId: string; threadId: string; score: number }>`
      select message_id as "messageId", thread_id as "threadId", bm25(pithy_support_search) as "score"
      from pithy_support_search
      where pithy_support_search match ${match}
      order by "score" asc
      limit ${options.limit}
    `.execute(db);
    return rows.map((row) => ({ messageId: row.messageId, threadId: row.threadId, score: Number(row.score) }));
  }
  if (term.trim().length === 0) return [];
  const pattern = `%${escapeLike(term.slice(0, MAX_TERM))}%`;
  const rows = await db
    .selectFrom(SUPPORT_MESSAGES_TABLE)
    .select(["id", "threadId"])
    .where((eb) =>
      eb.or([
        sql<SqlBool>`${eb.ref("subject")} like ${pattern} escape '\\'`,
        sql<SqlBool>`${eb.ref("textBody")} like ${pattern} escape '\\'`,
      ]),
    )
    .orderBy("receivedAt", "desc")
    .orderBy("id", "desc")
    .limit(options.limit)
    .execute();
  return rows.map((row) => ({ messageId: row.id, threadId: row.threadId }));
}

/**
 * Add a message to the full-text index, replacing any row already there for it.
 *
 * **No write path calls this any more.** The index is maintained by the triggers `createSearchIndex`
 * provisions (`store/searchIndex.ts`), so a message is indexed because it was written rather than
 * because the code that wrote it remembered. This is the **repair** primitive now: {@link reindexThread}
 * and {@link reindexAll} are its only callers in the kit, and it stays exported because
 * `package.json` exports `./src/*`, so an adopter may be reaching it.
 *
 * **Remove-then-insert, not a bare insert** — the same shape the trigger bodies use, and for the
 * reason an FTS5 table always needs it: it has no primary key and no unique constraint to lean on, so
 * a second call for the same message would silently add a second copy and the thread would start
 * appearing twice in its own search results. Making the write idempotent means a retry, a reindex, and
 * a first index are all the same operation.
 *
 * **It no longer carries a swallow contract, because it is no longer on a message write.** A failure
 * here is a failed repair, and the caller is a command or a route that can say so. The durability
 * question moved with the index itself: a trigger runs inside the message's own statement, so a
 * failure in its body takes the message write down with it — which is what `searchIndex.ts` documents
 * and what the triggers' own tests hold.
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
