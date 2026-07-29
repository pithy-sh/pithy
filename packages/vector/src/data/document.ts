import { SQLiteDate, sqliteJson } from "@pithy-sh/core/src/data/codecs";
import { z } from "zod";

/**
 * One embedded document — the row in `pithy_vector_documents`, keyed by `(indexName, id)`.
 *
 * The key is composite because a Vectorize id is unique within an index, not across them: `docs` and `faqs`
 * may each hold a document called `intro`, and they are different documents.
 *
 * This table earns its place three times over, and each reason is independently sufficient:
 *
 * 1. **Vectorize returns ids and scores, not content.** A match is `{ id, score }` — the text a user reads
 *    has to come from somewhere, and hydrating results from this table is that somewhere.
 * 2. **Long source text cannot live in Vectorize at all.** Metadata is capped at 10 KiB per vector, so a
 *    document of any real length exceeds the ceiling and must be stored outside the index.
 * 3. **Re-embedding needs a durable corpus.** Changing the model, or adding a metadata index late, invalidates
 *    what is already in the index — and Cloudflare does not give the text back. Without this table, a
 *    re-embed is a re-ingest, which for most adopters means it never happens.
 *
 * `metadata` is stored through `sqliteJson`, so it is validated on both sides and never hand-serialized.
 * `model` records which model produced the vector, which is what makes `pithy vector reprocess` able to
 * re-embed exactly the rows that drifted rather than the whole corpus.
 */

/** The metadata a document carries. Vectorize can only *filter* strings, numbers, and booleans; it stores more. */
export const VectorDocumentMetadata = z
  .record(z.string(), z.unknown())
  .describe(
    "The metadata this document's vector carries, as stored. Vectorize indexes only the fields marked filterable in the index's metadata schema; the rest ride along for hydration.",
  );
export type VectorDocumentMetadata = z.infer<typeof VectorDocumentMetadata>;

export const VectorDocument = z
  .object({
    id: z
      .string()
      .describe(
        "The document's id, which is also its Vectorize vector id — at most 64 bytes, because a longer id cannot be addressed in the index. Unique within an index, not across them: it is half of the primary key.",
      ),
    indexName: z
      .string()
      .describe(
        "The index this document was embedded into, as named in pithy.config.ts. The other half of the primary key, so the same id in two indexes is two documents.",
      ),
    namespace: z.string().nullable().describe("The namespace this document belongs to, or null for the default."),
    content: z
      .string()
      .nullable()
      .describe("The source text that was embedded. Null when the adopter keeps the text elsewhere."),
    metadata: sqliteJson(VectorDocumentMetadata).describe(
      "The document's metadata, stored as JSON and validated on read and write.",
    ),
    model: z
      .string()
      .nullable()
      .describe(
        "The embedding model that produced this document's vector. `pithy vector reprocess` re-embeds exactly the rows whose model differs from config.",
      ),
    createdAt: SQLiteDate.describe("When the document was first embedded."),
    updatedAt: SQLiteDate.describe("When the document was last re-embedded or its metadata changed."),
  })
  .describe("One embedded document — the row in `pithy_vector_documents`, keyed by `(indexName, id)`.");
export type VectorDocument = z.output<typeof VectorDocument>;
export type VectorDocumentRow = z.input<typeof VectorDocument>;

/**
 * The document schema with an index's own metadata shape, so a read validates the adopter's fields instead of
 * accepting any JSON. The table is the same; only the metadata codec narrows.
 */
export function vectorDocumentFor<M extends z.ZodObject>(metadata: M) {
  return VectorDocument.extend({
    metadata: sqliteJson(metadata).describe("The document's metadata, validated against this index's schema."),
  });
}
