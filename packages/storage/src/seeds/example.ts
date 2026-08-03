// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { EXAMPLE_ADA, EXAMPLE_GRACE } from "@pithy-sh/core/src/seed/exampleIdentities";
import { d1SeedGroup, defineSeed, type R2SeedItem, type SeedSet } from "@pithy-sh/core/src/seed/seed";
import { StorageObject } from "../data/storageObject";
import { STORAGE_OBJECTS_TABLE } from "../data/tables";
import { OBJECT_KEY_PREFIX } from "../object/key";

/**
 * Where the example set sorts among the whole project's seed registry. It runs after `auth` (100),
 * whose example seeds the users these files belong to, so the owning identities exist first — the
 * order encodes that dependency, exactly like the migration registry. It need not line up with
 * {@link STORAGE_MIGRATION_ORDER}: a different registry, composed separately by `pithy seed`.
 */
const STORAGE_EXAMPLE_SEED_ORDER = 230;

/**
 * A handful of demo files for the canonical example cast ({@link EXAMPLE_ADA} et al.).
 *
 * **Both halves are seeded — the rows and the bytes.** A storage row with no object in the bucket is
 * precisely the divergence the orphan sweep exists to reconcile, so a fixture that seeded only D1
 * would ship a demo where every download 404s and the sweep has work to do on a fresh install. The
 * `r2` items below write the same keys the rows name, so `GET /storage/:id` returns real content on
 * a freshly seeded environment.
 *
 * The ids and keys are **fixed**, not generated, which is what makes the set idempotent: re-seeding
 * writes the same rows over the same keys rather than accumulating a new copy of Ada's notes on every
 * run. One file is `public` on purpose, so the unauthenticated read path is exercised by the demo
 * data rather than only by the tests.
 *
 * Composed in only when the project turns on `seed.includeExamples` (`pithy.config.ts`), and only for
 * `dev` and `staging` — an example fixture never targets `prod`, regardless of that setting.
 */

/** Fixed ids, so the fixture is idempotent and the D1 rows and R2 objects cannot drift apart. */
const NOTES_ID = "6f1c8f36-30a5-4d5f-9f4d-6a5a52b9f0a1";
const PLAN_ID = "8c2d9a47-41b6-4e60-a05e-7b6b63c0e1b2";
const README_ID = "9d3ea058-52c7-4f71-b16f-8c7c74d1f2c3";

const CREATED_AT = new Date("2026-01-01T00:00:00.000Z");

/** The demo bodies. Declared once so a row's `size` is the byte count actually written to R2. */
const BODIES = {
  [NOTES_ID]: "Lovelace, notes on the Analytical Engine.\n",
  [PLAN_ID]: "Hopper, plan for the next compiler.\n",
  [README_ID]: "A public file. Anyone with the id may read this one.\n",
} as const;

/** Bytes of a demo body — `size` must be the encoded length, not the character count. */
function byteLength(id: keyof typeof BODIES): number {
  return new TextEncoder().encode(BODIES[id]).length;
}

/** The R2 object key a demo file lives under — the same opaque `obj/<uuid>` shape the handlers derive. */
function demoKey(id: string): string {
  return `${OBJECT_KEY_PREFIX}${id}`;
}

/** The bucket objects the rows point at, so a seeded environment can actually serve the bytes. */
const objects: R2SeedItem[] = (Object.keys(BODIES) as Array<keyof typeof BODIES>).map((id) => ({
  binding: "STORAGE_BUCKET",
  key: demoKey(id),
  body: BODIES[id],
  contentType: "text/plain",
}));

export const storageExampleSeed: SeedSet = defineSeed({
  name: "example",
  order: STORAGE_EXAMPLE_SEED_ORDER,
  environments: ["dev", "staging"],
  example: true,
  d1: [
    d1SeedGroup("app", STORAGE_OBJECTS_TABLE, StorageObject, [
      {
        id: NOTES_ID,
        key: demoKey(NOTES_ID),
        path: "notes/analytical-engine.txt",
        ownerId: EXAMPLE_ADA.id,
        contentType: "text/plain",
        size: byteLength(NOTES_ID),
        visibility: "private",
        checksum: null,
        status: "stored",
        uploadId: null,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
      },
      {
        id: PLAN_ID,
        key: demoKey(PLAN_ID),
        path: "plans/compiler.txt",
        ownerId: EXAMPLE_GRACE.id,
        contentType: "text/plain",
        size: byteLength(PLAN_ID),
        visibility: "private",
        checksum: null,
        status: "stored",
        uploadId: null,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
      },
      {
        id: README_ID,
        key: demoKey(README_ID),
        path: "public/readme.txt",
        ownerId: EXAMPLE_ADA.id,
        contentType: "text/plain",
        size: byteLength(README_ID),
        visibility: "public",
        checksum: null,
        status: "stored",
        uploadId: null,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
      },
    ]),
  ],
  r2: objects,
});
