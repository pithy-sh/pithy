import { chunkByBoundParameters } from "@pithy-sh/core/src/data/boundParameters";
import { SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import { VectorDocument } from "./document";
import { VECTOR_DOCUMENTS_TABLE, type VectorDatabase } from "./tables";

/**
 * The document corpus's reads and writes, in one place.
 *
 * Everything crossing the JS/SQLite line goes through the table's Zod codecs — `VectorDocument.encode` on
 * the way in, `VectorDocument.parse` on the way out (CLAUDE.md §Data layer). No `JSON.stringify`, no epoch
 * arithmetic, no `0/1` anywhere in this file.
 *
 * The store is a **structural seam** ({@link DocumentStore}) rather than a class over Kysely, because the
 * reprocess Workflow and the HTTP handlers both take it and both are unit-tested with a fake. The Kysely
 * implementation is {@link vectorDocuments}, exercised against real D1 in a Workers-runtime test.
 *
 * `model` is written **after** the vector reaches Vectorize, never with the row. A row whose model is null
 * is a document that is durable but not yet searchable, which is precisely the set `pithy vector reprocess`
 * should pick up — so the ordering makes a half-failed write self-healing instead of invisible.
 */

/** A page of the corpus, read in keyset order. */
export interface DocumentPageRequest {
  /** The index whose documents to read, as named in `pithy.config.ts`. */
  indexName: string;
  /** Read ids strictly greater than this one. Null starts at the beginning. */
  after: string | null;
  /** How many rows to read. The caller caps this at Vectorize's upsert batch. */
  limit: number;
  /**
   * When set, read only rows whose `model` differs from this one (including rows with no model at all).
   * That is the default `pithy vector reprocess` scan: re-embed exactly what drifted.
   */
  staleModel?: string;
}

/** The corpus operations the routes and the reprocess Workflow use. Structural, so a test injects a fake. */
export interface DocumentStore {
  /**
   * Insert or replace documents, keyed by `(indexName, id)`. Idempotent — the same call twice leaves the
   * same rows. The same id in two indexes is two documents, and neither displaces the other.
   */
  put(documents: readonly VectorDocument[]): Promise<void>;
  /** One document, or null. */
  get(indexName: string, id: string): Promise<VectorDocument | null>;
  /** Documents by id, for hydrating a query's matches. Order is not guaranteed; the caller re-orders by score. */
  byIds(indexName: string, ids: readonly string[]): Promise<VectorDocument[]>;
  /** Delete one document. Returns whether a row was there to delete. */
  remove(indexName: string, id: string): Promise<boolean>;
  /** One keyset page, ordered by id ascending. */
  page(request: DocumentPageRequest): Promise<VectorDocument[]>;
  /**
   * Record that these ids, in this index, are now embedded with `model`, as of `at`. The write that makes a
   * row searchable. Scoped by index, so stamping `docs` never touches an identically-named `faqs` row.
   */
  markEmbedded(indexName: string, ids: readonly string[], model: string, at: Date): Promise<void>;
}

/**
 * `byIds` binds the index name before its id list — one slot the chunk never gets.
 *
 * A query for `topK: 100` hydrates 100 ids, so a chunk sized at D1's cap itself would bind 101 and be
 * rejected. The count is stated here, next to the query it describes; add a `where` below and this
 * number moves with it.
 */
const BY_IDS_FIXED_PARAMETERS = 1;

/** `markEmbedded` binds `model`, `updatedAt`, and the index name before a single id is counted. */
const MARK_EMBEDDED_FIXED_PARAMETERS = 3;

/** The Kysely-backed {@link DocumentStore} over the app database's `DB` binding. */
export function vectorDocuments(db: VectorDatabase): DocumentStore {
  return {
    async put(documents) {
      if (documents.length === 0) return;
      for (const document of documents) {
        // Encode through the table's codecs, then upsert on the primary key: a re-ingest of the same id is
        // a replace, so an interrupted batch can simply be re-run.
        const row = VectorDocument.encode(document);
        await db
          .insertInto(VECTOR_DOCUMENTS_TABLE)
          .values(row)
          .onConflict((conflict) =>
            // The conflict target is the whole primary key. On `id` alone, writing `intro` to `faqs` would
            // overwrite `docs`'s `intro` — same id, different index, different document.
            conflict.columns(["indexName", "id"]).doUpdateSet({
              namespace: row.namespace,
              content: row.content,
              metadata: row.metadata,
              model: row.model,
              updatedAt: row.updatedAt,
            }),
          )
          .execute();
      }
    },

    async get(indexName, id) {
      const row = await db
        .selectFrom(VECTOR_DOCUMENTS_TABLE)
        .selectAll()
        .where("id", "=", id)
        .where("indexName", "=", indexName)
        .executeTakeFirst();
      return row ? VectorDocument.parse(row) : null;
    },

    async byIds(indexName, ids) {
      if (ids.length === 0) return [];
      const documents: VectorDocument[] = [];
      for (const group of chunkByBoundParameters(ids, BY_IDS_FIXED_PARAMETERS)) {
        const rows = await db
          .selectFrom(VECTOR_DOCUMENTS_TABLE)
          .selectAll()
          .where("indexName", "=", indexName)
          .where("id", "in", group)
          .execute();
        for (const row of rows) documents.push(VectorDocument.parse(row));
      }
      return documents;
    },

    async remove(indexName, id) {
      const result = await db
        .deleteFrom(VECTOR_DOCUMENTS_TABLE)
        .where("id", "=", id)
        .where("indexName", "=", indexName)
        .executeTakeFirst();
      return (result.numDeletedRows ?? 0n) > 0n;
    },

    async page(request) {
      let query = db
        .selectFrom(VECTOR_DOCUMENTS_TABLE)
        .selectAll()
        .where("indexName", "=", request.indexName)
        .orderBy("id", "asc")
        .limit(request.limit);
      if (request.after !== null) query = query.where("id", ">", request.after);
      if (request.staleModel !== undefined) {
        // `model IS NULL` counts as stale: a row written but never embedded is exactly what needs a pass.
        query = query.where((builder) =>
          builder.or([builder.eb("model", "is", null), builder.eb("model", "!=", request.staleModel as string)]),
        );
      }
      const rows = await query.execute();
      return rows.map((row) => VectorDocument.parse(row));
    },

    async markEmbedded(indexName, ids, model, at) {
      if (ids.length === 0) return;
      // The timestamp goes through the same codec the column is declared with — never a hand-rolled epoch.
      const updatedAt = SQLiteDate.encode(at);
      for (const group of chunkByBoundParameters(ids, MARK_EMBEDDED_FIXED_PARAMETERS)) {
        // Scoped by index, like every other statement here: an id names a row only together with its index.
        await db
          .updateTable(VECTOR_DOCUMENTS_TABLE)
          .set({ model, updatedAt })
          .where("indexName", "=", indexName)
          .where("id", "in", group)
          .execute();
      }
    },
  };
}
