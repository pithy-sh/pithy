// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";

/**
 * What the vector routes return, as Zod objects a client can validate against and the OpenAPI contract
 * can describe.
 *
 * `schemas.ts` bounds what a caller may send; this file states what it gets back. These describe JSON on
 * the wire, so a date is the ISO-8601 string `c.json` writes, and nothing here carries a codec or a
 * transform: parsing a response hands back exactly what went in, which is what lets `routes.test.ts`
 * parse a real answer and compare it with the original.
 *
 * **A field added here later is `.optional()` as well as `.nullable()`.** A client generated from the
 * contract reads Workers on older releases too, and a required key they cannot send fails it outright.
 */

/** One document from the corpus, as a client sees it. */
export const VectorDocumentResponse = z
  .object({
    id: z.string().describe("The document's id, which is also its vector id in the index."),
    indexName: z.string().describe("The index the document belongs to, as named in `pithy.config.ts`."),
    namespace: z.string().nullable().describe("The namespace the document belongs to, or null for the default."),
    content: z
      .string()
      .nullable()
      .describe("The source text that was embedded, or null when the adopter keeps the text elsewhere."),
    metadata: z
      .record(z.string(), z.unknown())
      .describe("The document's metadata, as stored. Its shape is the index's metadata schema."),
    model: z
      .string()
      .nullable()
      .describe("The embedding model that produced the vector, or null while the vector has not reached the index."),
    createdAt: z.iso.datetime().describe("When the document was first embedded, ISO-8601."),
    updatedAt: z.iso.datetime().describe("When the document was last re-embedded or its metadata changed, ISO-8601."),
  })
  .describe("One embedded document.");
export type VectorDocumentResponse = z.infer<typeof VectorDocumentResponse>;

/** What a write returns. */
export const UpsertResponse = z
  .object({
    ids: z.array(z.string()).describe("The document ids written, in request order."),
    mutationId: z.string().describe("Vectorize's mutation id. The write is enqueued, and a query may not see it yet."),
  })
  .describe("The documents were written and their vectors enqueued.");
export type UpsertResponse = z.infer<typeof UpsertResponse>;

/** One search match, hydrated from the corpus. */
export const QueryMatchResponse = z
  .object({
    id: z.string().describe("The matched vector's id."),
    score: z.number().describe("The similarity score, as the index's metric scores it."),
    document: VectorDocumentResponse.nullable().describe(
      "The document behind the match, or null when the index holds a vector the corpus no longer has.",
    ),
  })
  .describe("One search match.");
export type QueryMatchResponse = z.infer<typeof QueryMatchResponse>;

/** What a search returns. */
export const QueryResponse = z
  .object({
    count: z.number().int().describe("How many matches came back."),
    matches: z.array(QueryMatchResponse).describe("The matches, nearest first."),
  })
  .describe("The result of a similarity search.");
export type QueryResponse = z.infer<typeof QueryResponse>;

/** What a delete returns. */
export const DeleteResponse = z
  .object({
    id: z.string().describe("The id of the document that was removed."),
    mutationId: z.string().describe("Vectorize's mutation id for the enqueued delete."),
  })
  .describe("The document was removed from the corpus and its vector delete enqueued.");
export type DeleteResponse = z.infer<typeof DeleteResponse>;
