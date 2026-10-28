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
import { deleteVectors, type VectorStore } from "@pithy-sh/vector/src/index/index";
import { type Expression, type ExpressionBuilder, type Kysely, type SqlBool, sql } from "kysely";
import { SupportAssignment } from "../data/assignment";
import { SupportAttachment } from "../data/attachment";
import { SupportMessage } from "../data/message";
import {
  SUPPORT_ASSIGNMENTS_TABLE,
  SUPPORT_ATTACHMENTS_TABLE,
  SUPPORT_CLASSIFICATIONS_TABLE,
  SUPPORT_EMBEDDINGS_TABLE,
  SUPPORT_FLAGS_TABLE,
  SUPPORT_MESSAGES_TABLE,
  SUPPORT_THREADS_TABLE,
  type SupportDatabase,
  supportDatabase,
} from "../data/tables";
import { SupportThread } from "../data/thread";
import { SUPPORT_BUCKET_BINDING } from "../secret/registry";
import { SUPPORT_VECTORIZE_BINDING } from "../semantic/messageIndex";

/**
 * What erasing one person means for `@pithy-sh/support` (#814): every thread they opened — linked to their account,
 * or sent from their address and linked to no account — with every message in it, its attachments and raw mail in
 * R2, its classifications, every operator's read and snooze state on it, and the history of who had it (#816). And
 * what exporting them hands back.
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
 * a message drops it from the full-text index through the index's own triggers. Its vector in the semantic index
 * is deleted by the message's id, stamped or not, before the message row that names it.
 *
 * **Who had a thread goes with the thread; who handed it over is the operator's.** The assignment history is a
 * thread's own record — each change names the thread, who had it before and after, and the assigner's note about
 * the person's request — so it is erased with the thread and exported with it, oldest first. Who made each change,
 * `assignedBy`, is the operator's subject or a staff member's id, not the person's: the export leaves it out of the
 * history and of the thread, as leaderboard leaves out a moderator, and the audit trail keeps every handover with its
 * actor.
 *
 * **A staff member's own handovers, on threads that are not theirs, lose their id.** On the staff session door,
 * `assignedBy` is the signed-in user's id, written onto a customer's thread and its history. Their purge sets it to
 * `ERASED_ASSIGNER` wherever they acted as a user — every history row with `actorType = 'user'` and their id, and the
 * thread's own `assignedBy` when that row made its current assignment — so the handover stays in the customer's
 * record and stops naming them. A control-plane subject that happens to share the id is a client, not the person, and
 * is left alone. Their export hands those handovers back as which thread, when, and how they were verified, never the
 * assignee or the note, which are about the customer's request. Who **held** a thread is kept: an assignee is an
 * opaque reference and a name the assigner chose, support cannot tell which reference is the person, and both go
 * when the customer's thread does.
 */

/** What a purged staff member's id becomes on the handovers they made (#816). */
export const ERASED_ASSIGNER = "erased-user";

/** The one sentence the purge records with this step. */
export const SUPPORT_PURGE_SUMMARY =
  "Deletes every support thread the user opened, linked to their account or sent from their address and linked to no other account, with its messages, attachments, raw mail, classifications, read state and assignment history. On other people's threads, the handovers they made as a signed-in user lose their id; an assignee is an opaque reference the assigner named, so who held a thread stays until that thread goes.";

/** How many threads one read takes, so a person with a long history is erased in bounded statements. */
const PAGE = 50;

/** R2's ceiling on the keys one `delete` takes. */
const R2_DELETE_KEYS = 1000;

/** Vector ids one `deleteByIds` call takes — Vectorize's own write batch, the same ceiling an upsert has. */
const VECTOR_DELETE_IDS = 1000;

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

/** One handover a staff member made, as their export carries it: which thread, when, and how they were verified. */
const SupportHandover = SupportAssignment.pick({
  id: true,
  threadId: true,
  actorType: true,
  assignedBy: true,
  createdAt: true,
});

/** A row without who made its assignment: the operator's, never the person's (#816). */
function withoutAssigner<T extends { assignedBy?: unknown }>(row: T): Omit<T, "assignedBy"> {
  const { assignedBy: _assigner, ...rest } = row;
  return rest;
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

/** How the purge is composed. `semantic` is whether `search.semantic` is on, so the index must be reachable. */
export interface SupportPurgeOptions {
  semantic?: boolean;
}

/** The user contribution `support()` declares. */
export function supportUserPurge(database = "DB", options: SupportPurgeOptions = {}): ErasingPurgeContribution {
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
      // Their own acts as a signed-in user, on anybody's thread: the thread first, while its history still names them.
      const userId = context.subject.id;
      const anonymize = [
        db
          .updateTable(SUPPORT_THREADS_TABLE)
          .set({ assignedBy: ERASED_ASSIGNER })
          .where("assignedBy", "=", userId)
          .where((eb) =>
            eb.exists(
              eb
                .selectFrom(SUPPORT_ASSIGNMENTS_TABLE)
                .select(sql.lit(1).as("one"))
                .whereRef(`${SUPPORT_ASSIGNMENTS_TABLE}.threadId`, "=", `${SUPPORT_THREADS_TABLE}.id`)
                .whereRef(`${SUPPORT_ASSIGNMENTS_TABLE}.createdAt`, "=", `${SUPPORT_THREADS_TABLE}.assignedAt`)
                .where(`${SUPPORT_ASSIGNMENTS_TABLE}.actorType`, "=", "user")
                .where(`${SUPPORT_ASSIGNMENTS_TABLE}.assignedBy`, "=", userId),
            ),
          )
          .compile(),
        db
          .updateTable(SUPPORT_ASSIGNMENTS_TABLE)
          .set({ assignedBy: ERASED_ASSIGNER })
          .where("actorType", "=", "user")
          .where("assignedBy", "=", userId)
          .compile(),
      ];
      await d1.batch(anonymize.map((compiled) => d1.prepare(compiled.sql).bind(...(compiled.parameters as unknown[]))));
      let bucket: R2Bucket | undefined;
      let vectors: VectorStore | undefined;
      for (;;) {
        const ids = await threadIds(db, predicate, PAGE);
        if (ids.length === 0) return;
        const [attachments, messages] = await Promise.all([
          db.selectFrom(SUPPORT_ATTACHMENTS_TABLE).select("storageKey").where("threadId", "in", ids).execute(),
          db.selectFrom(SUPPORT_MESSAGES_TABLE).select(["id", "rawKey"]).where("threadId", "in", ids).execute(),
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
        // Their messages' vectors, before the rows that name them: a vector is derived from their words. Deleted by
        // every message id in the page, not only the stamped ones, because a vector can outlive a failed stamp
        // write, and deleting an id the index does not hold is harmless. The index is required when semantic
        // search is on or a stamp says a vector exists; otherwise it is used when bound, so a project with
        // semantic search off needs none.
        if (vectors === undefined && context.env[SUPPORT_VECTORIZE_BINDING] === undefined) {
          const required =
            options.semantic === true ||
            (await db
              .selectFrom(SUPPORT_EMBEDDINGS_TABLE)
              .select("messageId")
              .where("messageId", "in", (eb) =>
                eb.selectFrom(SUPPORT_MESSAGES_TABLE).select("id").where("threadId", "in", ids),
              )
              .executeTakeFirst()) !== undefined;
          if (required) {
            vectors = purgeBinding<VectorStore>(context.env, SUPPORT_VECTORIZE_BINDING, "support", "Vectorize index");
          }
        } else {
          vectors ??= purgeBinding<VectorStore>(context.env, SUPPORT_VECTORIZE_BINDING, "support", "Vectorize index");
        }
        if (vectors) {
          const vectorIds = messages.map((row) => row.id);
          for (let start = 0; start < vectorIds.length; start += VECTOR_DELETE_IDS) {
            await deleteVectors(vectors, vectorIds.slice(start, start + VECTOR_DELETE_IDS));
          }
        }
        // One batch, children first, so a failure leaves the page whole and the retry erases it again.
        const statements = [
          db
            .deleteFrom(SUPPORT_EMBEDDINGS_TABLE)
            .where("messageId", "in", (eb) =>
              eb.selectFrom(SUPPORT_MESSAGES_TABLE).select("id").where("threadId", "in", ids),
            )
            .compile(),
          db.deleteFrom(SUPPORT_ATTACHMENTS_TABLE).where("threadId", "in", ids).compile(),
          db.deleteFrom(SUPPORT_ASSIGNMENTS_TABLE).where("threadId", "in", ids).compile(),
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
      const [threads, messages, attachments, assignments, handovers] = await Promise.all([
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
        db
          .selectFrom(SUPPORT_ASSIGNMENTS_TABLE)
          .selectAll()
          .where("threadId", "in", threadIdsOf)
          .orderBy("createdAt")
          .orderBy("id")
          .execute(),
        // The handovers they made as a signed-in user, on any thread: which, when and how — never the assignee or the
        // note, which are about somebody else's request.
        db
          .selectFrom(SUPPORT_ASSIGNMENTS_TABLE)
          .select(["id", "threadId", "actorType", "assignedBy", "createdAt"])
          .where("actorType", "=", "user")
          .where("assignedBy", "=", context.subject.id)
          .orderBy("threadId")
          .orderBy("createdAt")
          .orderBy("id")
          .execute(),
      ]);
      return {
        threads: exportRows(threads.map((row) => withoutAssigner(SupportThread.parse(row)))),
        messages: exportRows(messages.map((row) => SupportMessage.parse(row))),
        attachments: exportRows(attachments.map((row) => SupportAttachment.parse(row))),
        assignments: exportRows(assignments.map((row) => withoutAssigner(SupportAssignment.parse(row)))),
        handovers: exportRows(handovers.map((row) => SupportHandover.parse(row))),
      };
    },
  };
}
