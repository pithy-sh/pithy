import { z } from "zod";
import { MAX_NAME_BYTES, MAX_TOPK_WITHOUT_PAYLOAD, MAX_UPSERT_BATCH, MAX_VECTOR_ID_BYTES } from "../index/limits";

/**
 * The request schemas for the vector routes. Each is declared on the route line with
 * `zValidator(target, Schema, validationHook)`, so a malformed request is a `validation/invalid_input` 400
 * before any handler runs (CLAUDE.md §Zod). They carry only the shape rules — the Vectorize ceilings
 * (dimensions, id bytes, metadata size, filter size) are enforced once, in `index/index.ts`, so the numbers
 * cannot disagree between two files.
 *
 * The param schemas are **shape** checks, not existence checks. Resolving `:index` against the configured
 * indexes stays where it was, in the route's dep resolver, and an index the config does not declare is still
 * a `vector/index_not_found` 404 — never a 400 that would turn the set of configured index names into
 * something a caller can probe for.
 *
 * Every write and every query accepts **either** `text` — embedded here with the index's pinned model — or a
 * precomputed `values` array. Both, or neither, is refused: a caller who sends both has two sources of truth
 * for one vector, and nothing downstream could say which one the index holds.
 */

/** An index name is a path segment and a Cloudflare resource name, so it is lowercase, digits, and dashes. */
const INDEX_NAME = /^[a-z0-9][a-z0-9-]*$/;

/**
 * The `:index` segment. Bounded to exactly what `VectorConfig` accepts as a key — a name outside this shape
 * cannot be configured, so it could never have resolved, and rejecting it here narrows nothing.
 */
const IndexSegment = z
  .string()
  .max(MAX_NAME_BYTES)
  .regex(INDEX_NAME, "An index name is lowercase, digits, and dashes — it is a path segment.")
  .describe(
    "The index this request addresses, as `pithy.config.ts` names it. Resolved against the configured indexes in the route, where an unknown name is a `vector/index_not_found` 404.",
  );

/** The path params of a route that names an index and nothing else. */
export const VectorIndexParams = z
  .object({ index: IndexSegment })
  .describe("The path params of an index-scoped vector route.");
export type VectorIndexParams = z.output<typeof VectorIndexParams>;

/** The path params of a route that addresses one document inside an index. */
export const VectorDocumentParams = z
  .object({
    index: IndexSegment,
    id: z
      .string()
      .min(1)
      .max(MAX_VECTOR_ID_BYTES)
      .describe(
        `The document's id, which is also its vector id. Opaque to this capability — bounded, not parsed. Vectorize refuses an id over ${MAX_VECTOR_ID_BYTES} bytes at write time, so a longer one could never name a document.`,
      ),
  })
  .describe("The path params of a route addressing one document in one index.");
export type VectorDocumentParams = z.output<typeof VectorDocumentParams>;

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
