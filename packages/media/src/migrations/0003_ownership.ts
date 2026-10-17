// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { type Kysely, sql } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * Whose a media record is, who may read it, and whether its bytes are signed.
 *
 * **On the record:** `ownerId` and `organizationId`, nullable, in storage's exact terms; `visibility`,
 * `CHECK`ed against the three levels because it is an authorization input and a hand-run `UPDATE` must not
 * leave a row the code has no branch for; and `signedDelivery`, whether Cloudflare enforces signed URLs on
 * the bytes, written only once Cloudflare confirms.
 *
 * **Existing records become private and system-owned.** They have no owner, and before this any signed-in
 * user read them. Adding `visibility` with a `private` default and leaving both ids null makes them
 * nobody's: the routes return them to nobody until an adopter assigns owners, or the permission hook
 * admits them. `signedDelivery` starts false, because nothing told Cloudflare otherwise — so each such
 * record reads as *private, signing not yet enforced*, which a visibility change finishes.
 *
 * **Indexed the way the reads ask.** A rollup is *this owner's media over a window* or *this
 * organization's*, so `(ownerId, createdAt)` and `(organizationId, createdAt)` on the record table — one
 * index range per question, never a scan.
 *
 * **On the hashes, the same two ids, denormalized**, because the hash table is the dedup query surface and
 * every lookup is scoped to the tenant asking. The scope leads each index: `(organizationId, sha256)` and
 * `(ownerId, sha256)` for the exact lookup, `(organizationId, mediaType, phash)` and `(ownerId, mediaType,
 * phash)` for the near-duplicate scan. Existing hash rows keep null ids, matching their records.
 *
 * `0003` rather than `0002`: that local key is the generated extension migration (`extend.ts`), so a new
 * authored migration takes the next number. `down` is the tested inverse — indexes first, then the
 * columns, in reverse.
 */
export const media_0003_ownership: Migration = {
  up: async (db: Kysely<unknown>): Promise<void> => {
    await db.schema.alterTable("pithyMediaAssets").addColumn("ownerId", "text").execute();
    await db.schema.alterTable("pithyMediaAssets").addColumn("organizationId", "text").execute();
    await db.schema
      .alterTable("pithyMediaAssets")
      .addColumn("visibility", "text", (c) =>
        c.notNull().defaultTo("private").check(sql`visibility IN ('private', 'organization', 'public')`),
      )
      .execute();
    await db.schema
      .alterTable("pithyMediaAssets")
      .addColumn("signedDelivery", "integer", (c) => c.notNull().defaultTo(0))
      .execute();

    await db.schema
      .createIndex("pithyMediaAssetsOwnerCreatedIdx")
      .on("pithyMediaAssets")
      .columns(["ownerId", "createdAt"])
      .execute();
    await db.schema
      .createIndex("pithyMediaAssetsOrganizationCreatedIdx")
      .on("pithyMediaAssets")
      .columns(["organizationId", "createdAt"])
      .execute();

    await db.schema.alterTable("pithyMediaHashes").addColumn("ownerId", "text").execute();
    await db.schema.alterTable("pithyMediaHashes").addColumn("organizationId", "text").execute();
    await db.schema
      .createIndex("pithyMediaHashesOrganizationSha256Idx")
      .on("pithyMediaHashes")
      .columns(["organizationId", "sha256"])
      .execute();
    await db.schema
      .createIndex("pithyMediaHashesOwnerSha256Idx")
      .on("pithyMediaHashes")
      .columns(["ownerId", "sha256"])
      .execute();
    await db.schema
      .createIndex("pithyMediaHashesOrganizationPhashIdx")
      .on("pithyMediaHashes")
      .columns(["organizationId", "mediaType", "phash"])
      .execute();
    await db.schema
      .createIndex("pithyMediaHashesOwnerPhashIdx")
      .on("pithyMediaHashes")
      .columns(["ownerId", "mediaType", "phash"])
      .execute();
  },
  down: async (db: Kysely<unknown>): Promise<void> => {
    await db.schema.dropIndex("pithyMediaHashesOwnerPhashIdx").execute();
    await db.schema.dropIndex("pithyMediaHashesOrganizationPhashIdx").execute();
    await db.schema.dropIndex("pithyMediaHashesOwnerSha256Idx").execute();
    await db.schema.dropIndex("pithyMediaHashesOrganizationSha256Idx").execute();
    await db.schema.alterTable("pithyMediaHashes").dropColumn("organizationId").execute();
    await db.schema.alterTable("pithyMediaHashes").dropColumn("ownerId").execute();

    await db.schema.dropIndex("pithyMediaAssetsOrganizationCreatedIdx").execute();
    await db.schema.dropIndex("pithyMediaAssetsOwnerCreatedIdx").execute();
    await db.schema.alterTable("pithyMediaAssets").dropColumn("signedDelivery").execute();
    await db.schema.alterTable("pithyMediaAssets").dropColumn("visibility").execute();
    await db.schema.alterTable("pithyMediaAssets").dropColumn("organizationId").execute();
    await db.schema.alterTable("pithyMediaAssets").dropColumn("ownerId").execute();
  },
};
