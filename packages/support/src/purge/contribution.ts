// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { normalizeAddress } from "@pithy-sh/core/src/address/address";
import {
  type ErasingPurgeContribution,
  exportRows,
  type PurgeContext,
  purgeBinding,
} from "@pithy-sh/core/src/capability/purge";
import type { Expression, ExpressionBuilder, Kysely, SqlBool } from "kysely";
import { SupportAttachment } from "../data/attachment";
import { SupportMessage } from "../data/message";
import {
  SUPPORT_ATTACHMENTS_TABLE,
  SUPPORT_CLASSIFICATIONS_TABLE,
  SUPPORT_FLAGS_TABLE,
  SUPPORT_MESSAGES_TABLE,
  SUPPORT_THREADS_TABLE,
  type SupportDatabase,
  supportDatabase,
} from "../data/tables";
import { SupportThread } from "../data/thread";
import { SUPPORT_BUCKET_BINDING } from "../secret/registry";

/**
 * What erasing one person means for `@pithy-sh/support` (#814): every thread they opened — linked to their account,
 * or sent from their address and linked to no account — with every message in it, its attachments and raw mail in
 * R2, its classifications, and every operator's read and snooze state on it. And what exporting them hands back.
 *
 * **A thread is the person's when it is linked to their account or came from their address.** An email thread from
 * someone who never signed in carries no `userId`, only the address it came from; the address is read from the
 * account that owns it (`PurgeContext.address`), so a thread sent before the person had an account is theirs too.
 * The address side takes only a thread linked to no account: an address can move, and a thread linked to whoever
 * held it before is that account's, never handed to the person who holds it now, nor erased with them.
 *
 * **The bytes go first, then the rows.** An attachment's row and a message's `rawKey` are the only things that name
 * their objects, so a row deleted ahead of its object would leave bytes nothing can find. An R2 delete of a key
 * already gone succeeds, so a retried step is **idempotent**, and a person with no threads finds nothing. Deleting
 * a message drops it from the full-text index through the index's own triggers.
 */

/** The one sentence the purge records with this step. */
export const SUPPORT_PURGE_SUMMARY =
  "Deletes every support thread the user opened, linked to their account or sent from their address and linked to no other account, with its messages, attachments, raw mail, classifications and read state.";

/** How many threads one read takes, so a person with a long history is erased in bounded statements. */
const PAGE = 50;

/** R2's ceiling on the keys one `delete` takes. */
const R2_DELETE_KEYS = 1000;

/** The person's threads, as a predicate: linked to the account, or sent from its address and linked to none. */
type Theirs = (
  eb: ExpressionBuilder<SupportDatabase extends Kysely<infer Tables> ? Tables : never, typeof SUPPORT_THREADS_TABLE>,
) => Expression<SqlBool>;

/**
 * Which threads are the person's: linked to the account, or sent from its address and linked to no account. Both
 * sides are `normalizeAddress`'s form — a thread's `fromAddress` is normalized on the way in — so the index answers.
 * It binds at most two parameters, however many threads it matches, so a statement built on it stays under D1's cap.
 */
async function theirs(context: PurgeContext): Promise<Theirs> {
  const read = (await context.address?.()) ?? null;
  const address = read === null ? null : normalizeAddress(read);
  const userId = context.subject.id;
  return (eb) =>
    address === null
      ? eb("userId", "=", userId)
      : eb.or([eb("userId", "=", userId), eb.and([eb("fromAddress", "=", address), eb("userId", "is", null)])]);
}

/** The person's thread ids, oldest first, at most `limit`. */
async function threadIds(db: SupportDatabase, predicate: Theirs, limit: number): Promise<string[]> {
  const rows = await db
    .selectFrom(SUPPORT_THREADS_TABLE)
    .select("id")
    .where(predicate)
    .orderBy("createdAt")
    .orderBy("id")
    .limit(limit)
    .execute();
  return rows.map((row) => row.id);
}

/** The user contribution `support()` declares. */
export function supportUserPurge(database = "DB"): ErasingPurgeContribution {
  const open = (env: Record<string, unknown>) => {
    const d1 = purgeBinding<D1Database>(env, database, "support");
    return { d1, db: supportDatabase(d1) };
  };
  return {
    subject: "user",
    summary: SUPPORT_PURGE_SUMMARY,
    erase: async (context) => {
      const { d1, db } = open(context.env);
      const predicate = await theirs(context);
      let bucket: R2Bucket | undefined;
      for (;;) {
        const ids = await threadIds(db, predicate, PAGE);
        if (ids.length === 0) return;
        const [attachments, messages] = await Promise.all([
          db.selectFrom(SUPPORT_ATTACHMENTS_TABLE).select("storageKey").where("threadId", "in", ids).execute(),
          db.selectFrom(SUPPORT_MESSAGES_TABLE).select("rawKey").where("threadId", "in", ids).execute(),
        ]);
        const keys = [
          ...attachments.map((row) => row.storageKey),
          ...messages.map((row) => row.rawKey).filter((key): key is string => typeof key === "string" && key !== ""),
        ];
        if (keys.length > 0) {
          // Bound only once there are bytes to delete, so a person whose threads hold none needs no bucket.
          bucket ??= purgeBinding<R2Bucket>(context.env, SUPPORT_BUCKET_BINDING, "support", "R2 bucket");
          // One page's threads can hold any number of messages and attachments; R2 takes a thousand keys a call.
          for (let start = 0; start < keys.length; start += R2_DELETE_KEYS) {
            await bucket.delete(keys.slice(start, start + R2_DELETE_KEYS));
          }
        }
        // One batch, children first, so a failure leaves the page whole and the retry erases it again.
        const statements = [
          db.deleteFrom(SUPPORT_ATTACHMENTS_TABLE).where("threadId", "in", ids).compile(),
          db.deleteFrom(SUPPORT_CLASSIFICATIONS_TABLE).where("threadId", "in", ids).compile(),
          db.deleteFrom(SUPPORT_FLAGS_TABLE).where("threadId", "in", ids).compile(),
          db.deleteFrom(SUPPORT_MESSAGES_TABLE).where("threadId", "in", ids).compile(),
          db.deleteFrom(SUPPORT_THREADS_TABLE).where("id", "in", ids).compile(),
        ];
        await d1.batch(
          statements.map((compiled) => d1.prepare(compiled.sql).bind(...(compiled.parameters as unknown[]))),
        );
      }
    },
    export: async (context) => {
      const { db } = open(context.env);
      const predicate = await theirs(context);
      // The thread set as a subquery, never a bound id list: a person with more threads than D1 binds in one
      // statement is answered in full.
      const threadIdsOf = db.selectFrom(SUPPORT_THREADS_TABLE).select("id").where(predicate);
      const [threads, messages, attachments] = await Promise.all([
        db.selectFrom(SUPPORT_THREADS_TABLE).selectAll().where(predicate).orderBy("createdAt").orderBy("id").execute(),
        db
          .selectFrom(SUPPORT_MESSAGES_TABLE)
          .selectAll()
          .where("threadId", "in", threadIdsOf)
          .orderBy("receivedAt")
          .orderBy("id")
          .execute(),
        db
          .selectFrom(SUPPORT_ATTACHMENTS_TABLE)
          .selectAll()
          .where("threadId", "in", threadIdsOf)
          .orderBy("createdAt")
          .orderBy("id")
          .execute(),
      ]);
      return {
        threads: exportRows(threads.map((row) => SupportThread.parse(row))),
        messages: exportRows(messages.map((row) => SupportMessage.parse(row))),
        attachments: exportRows(attachments.map((row) => SupportAttachment.parse(row))),
      };
    },
  };
}
