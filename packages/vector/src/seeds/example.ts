// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { EXAMPLE_ADA, EXAMPLE_ALAN, EXAMPLE_GRACE } from "@pithy-sh/core/src/seed/exampleIdentities";
import { d1SeedGroup, defineSeed, type SeedSet } from "@pithy-sh/core/src/seed/seed";
import { VectorDocument } from "../data/document";
import { VECTOR_DOCUMENTS_TABLE } from "../data/tables";

/**
 * Where the example set sorts in the project's seed registry. It runs after `auth` (100), whose example
 * seeds the users these documents belong to, so the owning identities exist before anything references them.
 *
 * It need not line up with `VECTOR_MIGRATION_ORDER` — a different registry, composed separately by
 * `pithy seed`.
 */
const VECTOR_EXAMPLE_SEED_ORDER = 240;

/** The index these demo documents belong to — the name `pithy add vector` scaffolds into pithy.config.ts. */
const EXAMPLE_INDEX = "docs";

const now = () => new Date();

/**
 * A small demo corpus owned by the canonical example cast ({@link EXAMPLE_ADA} et al.). The owner rides in
 * `metadata.ownerId` rather than in a column, because that is how a real corpus scopes: a document's owner
 * is exactly the kind of field an index marks `filterable`, and putting it in metadata means the demo shows
 * the filter path rather than a shape only the seed uses.
 *
 * **`model` is null on purpose.** A seed writes rows into D1; it cannot call Workers AI, so it cannot
 * produce vectors. These documents are a durable corpus that is not yet searchable — which is precisely the
 * state `pithy vector reprocess` exists to resolve, and running it against a freshly seeded dev environment
 * is the shortest honest demonstration of the whole capability.
 *
 * Composed in only when the project turns on `seed.includeExamples`, and only for `dev` and `staging` — an
 * example fixture never targets `prod`.
 */
export const vectorExampleSeed: SeedSet = defineSeed({
  name: "example",
  order: VECTOR_EXAMPLE_SEED_ORDER,
  environments: ["dev", "staging"],
  example: true,
  d1: [
    d1SeedGroup("app", VECTOR_DOCUMENTS_TABLE, VectorDocument, [
      {
        id: "example-doc-ada",
        indexName: EXAMPLE_INDEX,
        namespace: null,
        content:
          "An analytical engine can weave algebraic patterns the way a loom weaves flowers and leaves. Its power is in the general rule, not the particular sum.",
        metadata: { ownerId: EXAMPLE_ADA.id, title: "On the analytical engine" },
        model: null,
        createdAt: now(),
        updatedAt: now(),
      },
      {
        id: "example-doc-grace",
        indexName: EXAMPLE_INDEX,
        namespace: null,
        content:
          "A program should be written in words people can read. Compilers exist so that the machine, not the person, does the translating.",
        metadata: { ownerId: EXAMPLE_GRACE.id, title: "On compilers" },
        model: null,
        createdAt: now(),
        updatedAt: now(),
      },
      {
        id: "example-doc-alan",
        indexName: EXAMPLE_INDEX,
        namespace: null,
        content:
          "A machine may be said to think if a person conversing with it cannot tell it from another person. The question is behavior, not substance.",
        metadata: { ownerId: EXAMPLE_ALAN.id, title: "On machine intelligence" },
        model: null,
        createdAt: now(),
        updatedAt: now(),
      },
    ]),
  ],
});
