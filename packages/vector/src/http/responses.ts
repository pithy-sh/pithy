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

/*
  The index read (#730). Everything below is what `GET {basePath}/indexes` answers, behind
  `vector:indexes:read`. Each part is a discriminated state rather than a value with a flag beside it, so a
  client cannot read an index it could not describe as one holding zero vectors, or an index provision never
  saw as one that agrees.
*/

/**
 * How an index scores nearest neighbors, restated here rather than imported from `config/config.ts`, because
 * this module is compiled into a browser program and that one reaches the metadata introspector.
 * `responses.test.ts` holds the two lists equal.
 */
export const VectorIndexMetric = z
  .enum(["cosine", "euclidean", "dot-product"])
  .describe("How the index scores nearest neighbors, as config declares it. Fixed at index creation.");
export type VectorIndexMetric = z.infer<typeof VectorIndexMetric>;

/** What config declares for one index. */
export const VectorIndexDeclaration = z
  .object({
    model: z.string().describe("The Workers AI embedding model config pins for writes and queries alike."),
    dimensions: z.number().int().describe("How many components config says each vector carries."),
    metric: VectorIndexMetric,
  })
  .describe("What `pithy.config.ts` declares for this index.");
export type VectorIndexDeclaration = z.infer<typeof VectorIndexDeclaration>;

/** A declared dimension count Vectorize disagrees with. Unfixable in place, so it names a decision. */
export const VectorDimensionMismatch = z
  .object({
    declared: z.number().int().describe("The dimensions config declares."),
    actual: z.number().int().describe("The dimensions Vectorize reports the index was created with."),
    message: z
      .string()
      .describe(
        "That dimensions are fixed at creation, and the reset that rebuilds the index, said as a person's decision because it deletes every vector in it.",
      ),
  })
  .describe(
    "Config and the live index disagree on dimensions. Writes and queries against it fail until a person decides.",
  );
export type VectorDimensionMismatch = z.infer<typeof VectorDimensionMismatch>;

/** What Vectorize reports about one index, over its binding, or why it could not say. */
export const VectorIndexVectorize = z
  .discriminatedUnion("state", [
    z
      .object({
        state: z.literal("read").describe("Vectorize described the index."),
        vectorCount: z.number().int().describe("How many vectors the index holds."),
        dimensions: z.number().int().describe("How many components the index was created for."),
        processedUpToDatetime: z
          .string()
          .nullable()
          .describe(
            "ISO-8601. Every mutation made before it is reflected in the index, which answers whether recent writes have landed. Null while the index has processed none.",
          ),
        processedUpToMutation: z
          .string()
          .nullable()
          .describe("The id of the last mutation the index has applied, or null while it has applied none."),
        dimensionMismatch: VectorDimensionMismatch.nullable().describe(
          "Null when config and the index agree on dimensions, or what disagrees and the decision it needs.",
        ),
      })
      .describe("The index as Vectorize describes it, on the binding the Worker already holds. No account token."),
    z
      .object({
        state: z.literal("unreadable").describe("The index could not be described on this read. Never zero."),
        reason: z
          .enum(["unbound", "unsupported", "failed"])
          .describe(
            "`unbound`: the index's binding is not on the Worker. `unsupported`: the binding has no `describe`. `failed`: `describe` threw or answered an unknown shape. Nothing of the error itself is reported.",
          ),
      })
      .describe("Vectorize could not be asked, or did not answer. A different fact from an empty index."),
  ])
  .describe("What Vectorize reports about this index.");
export type VectorIndexVectorize = z.infer<typeof VectorIndexVectorize>;

/** How the corpus splits by the model each row was embedded under. */
export const VectorIndexDocuments = z
  .object({
    declaredModel: z.number().int().describe("Documents embedded under the model config declares."),
    otherModel: z
      .number()
      .int()
      .describe(
        "Documents embedded under any other model. Queries compare them across two embedding spaces and nothing errors. `pithy vector reprocess` re-embeds them.",
      ),
    unembedded: z.number().int().describe("Documents written and never embedded: durable, and not searchable."),
  })
  .describe("This index's documents, by the model they were embedded under.");
export type VectorIndexDocuments = z.infer<typeof VectorIndexDocuments>;

/** A filterable field provision never created a metadata index for. */
export const VectorMissingMetadataIndex = z
  .object({
    propertyName: z.string().describe("The metadata field config marks filterable."),
    indexType: z.string().describe("The type config declares it as."),
  })
  .describe("A field declared filterable with no metadata index behind it.");
export type VectorMissingMetadataIndex = z.infer<typeof VectorMissingMetadataIndex>;

/** A filterable field provision indexed as another type. */
export const VectorMismatchedMetadataIndex = z
  .object({
    propertyName: z.string().describe("The metadata field config marks filterable."),
    declared: z.string().describe("The type config declares it as."),
    indexed: z.string().describe("The type provision recorded the metadata index as."),
  })
  .describe("A field declared filterable whose metadata index is another type.");
export type VectorMismatchedMetadataIndex = z.infer<typeof VectorMismatchedMetadataIndex>;

/** Where one declared index stands against what `pithy vector provision` last recorded. */
export const VectorIndexProvision = z
  .discriminatedUnion("state", [
    z
      .object({
        state: z.literal("unprovisioned").describe("Config declares the index and the provision record has none."),
        message: z.string().describe("The provision that creates it, for this Worker's environment."),
      })
      .describe("Declared and never provisioned."),
    z
      .object({
        state: z.literal("provisioned").describe("The record's metadata indexes match what config declares."),
      })
      .describe("Provisioned, and agreeing with config."),
    z
      .object({
        state: z
          .literal("drifted")
          .describe(
            "A filterable field provision never saw, or saw as another type. Filters on it return short, plausible results and nothing errors.",
          ),
        missing: z.array(VectorMissingMetadataIndex).describe("Fields declared filterable with no metadata index."),
        mismatched: z.array(VectorMismatchedMetadataIndex).describe("Fields indexed as a different type."),
        message: z
          .string()
          .describe("The provision that creates what is missing, and the reset a mis-typed one needs."),
      })
      .describe("Provisioned, and since drifted from config. Every route but the admin surface refuses until fixed."),
  ])
  .describe(
    "This index against the provision record, which the Worker reads from a var with no network. A record, so it says what provision last saw, not what Cloudflare holds now.",
  );
export type VectorIndexProvision = z.infer<typeof VectorIndexProvision>;

/** One index config declares, read three ways. */
export const VectorIndexState = z
  .object({
    name: z.string().describe("The index's name in `pithy.config.ts`, not its Cloudflare resource name."),
    declared: VectorIndexDeclaration,
    vectorize: VectorIndexVectorize,
    documents: VectorIndexDocuments,
    namespaces: z
      .number()
      .int()
      .describe(
        "How many distinct namespaces the corpus uses in this index, the default not counted. A count and never the names: a namespace is often a tenant or organization id.",
      ),
    provision: VectorIndexProvision,
  })
  .describe(
    "One index: what config declares, what Vectorize holds, what the corpus holds, and whether it was provisioned.",
  );
export type VectorIndexState = z.infer<typeof VectorIndexState>;

/** What the index read returns. */
export const VectorIndexesResponse = z
  .object({
    environment: z
      .string()
      .nullable()
      .describe("The environment this Worker serves, from its `ENVIRONMENT` var. Null for a Worker that names none."),
    indexes: z.array(VectorIndexState).describe("Every index config declares, in config order. None is omitted."),
  })
  .describe("Which vector indexes exist, how much is in them, and whether each is current.");
export type VectorIndexesResponse = z.infer<typeof VectorIndexesResponse>;
