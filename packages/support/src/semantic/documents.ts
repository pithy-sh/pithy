// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { chunkByBoundParameters } from "@pithy-sh/core/src/data/boundParameters";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import type { VectorDocument } from "@pithy-sh/vector/src/data/document";
import type { DocumentStore } from "@pithy-sh/vector/src/data/documents";
import { deleteVectors, type VectorStore } from "@pithy-sh/vector/src/index/index";
import { SupportEmbedding } from "../data/embedding";
import { SUPPORT_EMBEDDINGS_TABLE, SUPPORT_MESSAGES_TABLE, type SupportDatabase } from "../data/tables";
import { embeddingText, SUPPORT_MESSAGES_INDEX } from "./messageIndex";

/**
 * `@pithy-sh/vector`'s `DocumentStore` seam over `pithy_support_messages` — so the semantic index is
 * re-embedded by `vector`'s own reprocess orchestration rather than a second one.
 *
 * **The text stays in support's table.** A document is a message read through the join: its content is the text
 * {@link embeddingText} embeds, and its `model` is the stamp in `pithy_support_embeddings`, null for a message
 * never embedded. `markEmbedded` writes stamps. Nothing here copies a message into `pithy_vector_documents`.
 *
 * **Inbound messages only**, because only they are embedded on arrival: an operator's own reply says nothing
 * about what the customer asked, and embedding it would put the adopter's words beside the customer's.
 *
 * **Metadata is empty, always.** Reprocess upserts a document's metadata onto its vector, so `{}` here is what
 * keeps a re-embed to ids only, the same as the write in `embed.ts`.
 *
 * One index: every call names `support-messages` or reads nothing.
 */

/** A stamp insert binds the model and the time before the id list. */
const STAMP_FIXED_PARAMETERS = 2;

/** Message reads bind `direction` before the id list. */
const READ_FIXED_PARAMETERS = 1;

interface MessageRow {
  id: string;
  subject: string;
  textBody: string;
  receivedAt: number;
  model: string | null;
  embeddedAt: number | null;
}

/**
 * Stamp `ids` with `model`, for the messages that still exist, and delete the vector of every one that does not.
 *
 * The stamp is an `INSERT … SELECT` from `pithy_support_messages`, so a message deleted after its vector was read
 * gets no stamp. Its vector was upserted after the purge deleted it, so it is deleted here, by id: nothing else
 * names it once the message row is gone. Returns the ids that were stamped.
 */
export async function writeStamps(
  db: SupportDatabase,
  store: VectorStore | undefined,
  ids: readonly string[],
  model: string,
  at: Date,
): Promise<Set<string>> {
  const stamped = new Set<string>();
  if (ids.length === 0) return stamped;
  const embeddedAt = SupportEmbedding.shape.embeddedAt.encode(at);
  for (const group of chunkByBoundParameters(ids, STAMP_FIXED_PARAMETERS)) {
    // One statement per chunk, upserting: a re-embed replaces the stamp a model change left behind.
    await db
      .insertInto(SUPPORT_EMBEDDINGS_TABLE)
      .columns(["messageId", "model", "embeddedAt"])
      .expression((eb) =>
        eb
          .selectFrom(SUPPORT_MESSAGES_TABLE)
          .select((inner) => ["id", inner.val(model).as("model"), inner.val(embeddedAt).as("embeddedAt")])
          .where("id", "in", group),
      )
      .onConflict((conflict) =>
        conflict.column("messageId").doUpdateSet((eb) => ({
          model: eb.ref("excluded.model"),
          embeddedAt: eb.ref("excluded.embeddedAt"),
        })),
      )
      .execute();
    const present = await db.selectFrom(SUPPORT_MESSAGES_TABLE).select("id").where("id", "in", group).execute();
    for (const row of present) stamped.add(row.id);
  }
  const gone = ids.filter((id) => !stamped.has(id));
  if (gone.length > 0 && store) await deleteVectors(store, gone);
  return stamped;
}

function documentOf(row: MessageRow): VectorDocument {
  const receivedAt = new Date(Number(row.receivedAt));
  return {
    id: row.id,
    indexName: SUPPORT_MESSAGES_INDEX,
    namespace: null,
    content: embeddingText(row.subject, row.textBody),
    metadata: {},
    model: row.model,
    createdAt: receivedAt,
    updatedAt: row.embeddedAt === null ? receivedAt : new Date(Number(row.embeddedAt)),
  };
}

/**
 * The message corpus as a `DocumentStore`. `store` is the index a re-embed writes to, so a stamp that finds its
 * message gone deletes the vector the re-embed just wrote for it.
 */
export function supportMessageDocuments(db: SupportDatabase, options: { store?: VectorStore } = {}): DocumentStore {
  const base = () =>
    db
      .selectFrom(SUPPORT_MESSAGES_TABLE)
      .leftJoin(SUPPORT_EMBEDDINGS_TABLE, `${SUPPORT_EMBEDDINGS_TABLE}.messageId`, `${SUPPORT_MESSAGES_TABLE}.id`)
      .select([
        `${SUPPORT_MESSAGES_TABLE}.id as id`,
        `${SUPPORT_MESSAGES_TABLE}.subject as subject`,
        `${SUPPORT_MESSAGES_TABLE}.textBody as textBody`,
        `${SUPPORT_MESSAGES_TABLE}.receivedAt as receivedAt`,
        `${SUPPORT_EMBEDDINGS_TABLE}.model as model`,
        `${SUPPORT_EMBEDDINGS_TABLE}.embeddedAt as embeddedAt`,
      ])
      .where(`${SUPPORT_MESSAGES_TABLE}.direction`, "=", "inbound");

  const ours = (indexName: string) => indexName === SUPPORT_MESSAGES_INDEX;

  return {
    async put() {
      // Messages are written by the mail path and the submission route, never by a re-embed.
      throw new InternalError({
        message: "Support messages cannot be written through the vector document store.",
        detail: "supportMessageDocuments.put: the corpus is pithy_support_messages, written by support alone",
      });
    },

    async get(indexName, id) {
      if (!ours(indexName)) return null;
      const row = await base().where(`${SUPPORT_MESSAGES_TABLE}.id`, "=", id).executeTakeFirst();
      return row ? documentOf(row as MessageRow) : null;
    },

    async byIds(indexName, ids) {
      if (!ours(indexName) || ids.length === 0) return [];
      const documents: VectorDocument[] = [];
      for (const group of chunkByBoundParameters(ids, READ_FIXED_PARAMETERS)) {
        const rows = await base().where(`${SUPPORT_MESSAGES_TABLE}.id`, "in", group).execute();
        for (const row of rows) documents.push(documentOf(row as MessageRow));
      }
      return documents;
    },

    async remove(indexName, id) {
      // The message is support's to delete. What a re-embed may forget is its stamp.
      if (!ours(indexName)) return false;
      const result = await db.deleteFrom(SUPPORT_EMBEDDINGS_TABLE).where("messageId", "=", id).executeTakeFirst();
      return (result.numDeletedRows ?? 0n) > 0n;
    },

    async page(request) {
      if (!ours(request.indexName)) return [];
      let query = base().orderBy(`${SUPPORT_MESSAGES_TABLE}.id`, "asc").limit(request.limit);
      if (request.after !== null) query = query.where(`${SUPPORT_MESSAGES_TABLE}.id`, ">", request.after);
      const stale = request.staleModel;
      if (stale !== undefined) {
        // Never stamped counts as stale: a message that missed its embedding is exactly what a pass is for.
        query = query.where((eb) =>
          eb.or([
            eb(`${SUPPORT_EMBEDDINGS_TABLE}.model`, "is", null),
            eb(`${SUPPORT_EMBEDDINGS_TABLE}.model`, "!=", stale),
          ]),
        );
      }
      const rows = await query.execute();
      return rows.map((row) => documentOf(row as MessageRow));
    },

    async markEmbedded(indexName, ids, model, at) {
      if (!ours(indexName)) return;
      await writeStamps(db, options.store, ids, model, at);
    },
  };
}
