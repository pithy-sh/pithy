import { z } from "zod";
import { MAX_TOPK_WITHOUT_PAYLOAD, MAX_UPSERT_BATCH } from "../index/limits";

/**
 * The request schemas for the vector routes. Validation happens at the HTTP boundary (CLAUDE.md §Zod), and
 * these schemas carry only the shape rules — the Vectorize ceilings (dimensions, id bytes, metadata size,
 * filter size) are enforced once, in `index/index.ts`, so the numbers cannot disagree between two files.
 *
 * Every write and every query accepts **either** `text` — embedded here with the index's pinned model — or a
 * precomputed `values` array. Both, or neither, is refused: a caller who sends both has two sources of truth
 * for one vector, and nothing downstream could say which one the index holds.
 */

/** Why a payload's vector source is unusable, or null. Both bodies take text **or** values, never both. */
function sourceProblem(value: { text?: unknown; values?: unknown }): string | null {
  const hasText = value.text !== undefined;
  const hasValues = value.values !== undefined;
  if (hasText && hasValues) return "Send `text` or `values`, not both — two sources for one vector.";
  if (!hasText && !hasValues) return "Send `text` to embed, or `values` for a precomputed embedding.";
  return null;
}

/** One document on its way into an index. */
export const VectorDocumentInput = z
  .object({
    id: z
      .string()
      .min(1)
      .optional()
      .describe(
        "The document's id, which is also its vector id. Supply your own to make a write idempotent — the same id replaces rather than duplicates, within this index. The same id in another index is a different document. Omitted means one is generated.",
      ),
    text: z
      .string()
      .min(1)
      .optional()
      .describe("The text to embed with this index's pinned model. Stored as the document's content."),
    values: z
      .array(z.number())
      .optional()
      .describe("A precomputed embedding, inserted as-is. Must be exactly the index's dimensions long."),
    content: z
      .string()
      .optional()
      .describe("The text to store as this document's content, when it differs from what was embedded."),
    metadata: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("The metadata this vector carries. Fields marked filterable in the index's schema are queryable."),
    namespace: z
      .string()
      .min(1)
      .optional()
      .describe("The namespace this vector belongs to. Falls back to the index's configured namespace."),
  })
  .check((ctx) => {
    const problem = sourceProblem(ctx.value);
    if (problem) ctx.issues.push({ code: "custom", input: ctx.value, path: ["text"], message: problem });
  })
  .describe("One document to write into an index: what to embed (or an embedding), plus its metadata.");
export type VectorDocumentInput = z.output<typeof VectorDocumentInput>;

/** A batch write. The array form; a bare document is accepted too and normalized into this shape. */
export const VectorDocumentBatch = z
  .object({
    documents: z
      .array(VectorDocumentInput)
      .min(1)
      .max(MAX_UPSERT_BATCH)
      .describe(
        `The documents to write, at most ${MAX_UPSERT_BATCH} — the ceiling the Vectorize binding accepts in one call.`,
      ),
  })
  .describe("A batch of documents to write into an index in one call.");
export type VectorDocumentBatch = z.output<typeof VectorDocumentBatch>;

/** The write body: one document, or a batch. Both land in the same handler path. */
export const UpsertDocumentsInput = z
  .union([VectorDocumentBatch, VectorDocumentInput])
  .describe("The body of a document write: either a `documents` array or a single document object.");
export type UpsertDocumentsInput = z.output<typeof UpsertDocumentsInput>;

/** A search. */
export const QueryInput = z
  .object({
    text: z.string().min(1).optional().describe("The query text, embedded with this index's pinned model."),
    values: z.array(z.number()).optional().describe("A precomputed query vector, used as-is."),
    topK: z
      .number()
      .int()
      .min(1)
      .max(MAX_TOPK_WITHOUT_PAYLOAD)
      .optional()
      .describe("How many matches to return. Defaults to the capability's configured `defaultTopK`."),
    namespace: z
      .string()
      .min(1)
      .optional()
      .describe("Restrict the search to one namespace. Falls back to the index's configured namespace."),
    filter: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        "A metadata filter over the index's filterable fields. A field with no metadata index is refused rather than silently ignored — filtering on one returns partial results with no error.",
      ),
  })
  .check((ctx) => {
    const problem = sourceProblem(ctx.value);
    if (problem) ctx.issues.push({ code: "custom", input: ctx.value, path: ["text"], message: problem });
  })
  .describe("A similarity search over one index, optionally narrowed by a metadata filter.");
export type QueryInput = z.output<typeof QueryInput>;
