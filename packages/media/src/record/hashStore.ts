// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import type { AccessCaller } from "@pithy-sh/core/src/access/access";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import type { MediaDedup } from "../config/config";
import type { MediaType } from "../data/enums";
import { MediaHash } from "../data/mediaHash";
import { MEDIA_HASHES_TABLE, mediaHashDatabase } from "../data/tables";

/**
 * The dedup hash store. Written on finalize, read by duplicate search, deleted with the record. Keeping
 * it in its own table, carrying its own copy of the tenant, is what makes `sha256` exact-match and `phash`
 * near-duplicate detection one indexed lookup scoped to whoever is asking.
 *
 * ## Every lookup is scoped, and the scope is never optional
 *
 * *Do you have this file* is not a question one tenant may ask about another, and in a multi-tenant
 * application an account-wide match is that question answered. So {@link HashStore.findBySha256} and
 * {@link HashStore.listImagePhashes} take a {@link DedupScope} with no default: the organization when one
 * is in force, the owner otherwise ({@link dedupScope}), and `"account"` only where the adopter configured
 * `dedup: { scope: "account" }` and so said, out loud, that one tenant may learn what another holds.
 *
 * An owner's scope is their records written **with no organization in force**. Records they wrote acting
 * for an organization are that organization's to match, and reaching them from outside it would be the
 * cross-organization read the scope exists to prevent.
 */

/** The hash to persist for one media record — and the tenant it belongs to, copied off the record. */
export interface HashEntry {
  /** The media record id. */
  mediaId: string;
  /** The media type — scopes the near-duplicate scan to images. */
  mediaType: MediaType;
  /** Lowercase-hex SHA-256 of the file. */
  sha256: string;
  /** Perceptual hash for near-duplicate images; null/undefined for other types. */
  phash?: string | null;
  /** The record's owner. */
  ownerId: string | null;
  /** The record's organization. */
  organizationId: string | null;
}

/** A `{ mediaId, phash }` pair for near-duplicate scanning. */
export interface HashPhashEntry {
  /** The media record id. */
  mediaId: string;
  /** The record's perceptual hash. */
  phash: string;
}

/** A `{ mediaId, mediaType }` pair returned by an exact-match lookup. */
export interface HashMatch {
  /** The media record id. */
  mediaId: string;
  /** The media type. */
  mediaType: MediaType;
}

/**
 * Whose records a lookup may match: one organization's, one owner's (written with no organization), or —
 * only where the adopter configured it — the whole account's.
 */
export type DedupScope =
  | { readonly organizationId: string }
  | { readonly ownerId: string }
  | { readonly account: true };

/**
 * The scope a caller's lookup runs in: the organization in force, otherwise the owner. Account-wide only
 * when `dedup.scope` is `account`, which is the explicit, opt-in widening.
 *
 * A caller with no identity has no tenant and no scope, so asking is refused rather than answered from
 * the account. The routes never get here — duplicate search requires a session — so this is a bug check
 * for a programmatic caller.
 */
export function dedupScope(caller: AccessCaller, dedup: MediaDedup): DedupScope {
  if (dedup.scope === "account") return { account: true };
  if (caller.acting) return { organizationId: caller.acting.organizationId };
  if (caller.userId !== null) return { ownerId: caller.userId };
  throw new InternalError({
    message: "Duplicate detection needs a tenant to search within.",
    detail: "dedupScope called for a caller with no user and no organization",
  });
}

/** The dedup hash store seam. */
export interface HashStore {
  /** Insert or replace the hash for a media record (idempotent per `mediaId`). */
  upsert(entry: HashEntry): Promise<void>;
  /** Delete the hash row for a media record. A miss is a no-op. */
  deleteByMedia(mediaId: string): Promise<void>;
  /** Every record in scope whose `sha256` exactly matches — the exact-duplicate lookup. */
  findBySha256(sha256: string, scope: DedupScope): Promise<HashMatch[]>;
  /** Every image record in scope carrying a perceptual hash — the bounded set the near scan compares. */
  listImagePhashes(scope: DedupScope): Promise<HashPhashEntry[]>;
}

/** Build the D1-backed hash store from the `DB` binding. */
export function d1HashStore(d1: D1Database, now: () => Date = () => new Date()): HashStore {
  const db = mediaHashDatabase(d1);

  /** A select over the hash table, narrowed to one scope. The scope leads every index this reads. */
  function scoped(scope: DedupScope) {
    const query = db.selectFrom(MEDIA_HASHES_TABLE);
    if ("organizationId" in scope) return query.where("organizationId", "=", scope.organizationId);
    if ("ownerId" in scope) return query.where("ownerId", "=", scope.ownerId).where("organizationId", "is", null);
    return query;
  }

  return {
    async upsert(entry) {
      const { id: _id, ...row } = MediaHash.encode({
        id: 0,
        mediaId: entry.mediaId,
        mediaType: entry.mediaType,
        ownerId: entry.ownerId,
        organizationId: entry.organizationId,
        sha256: entry.sha256,
        phash: entry.phash ?? null,
        createdAt: now(),
      });
      // The id is dropped before the insert so D1 assigns it. Writing the encoded placeholder stored a
      // literal 0, and the second record ever finalized collided with the first on the primary key.
      // `mediaId` is unique — replace any existing row so a re-finalize doesn't duplicate. The tenant is
      // rewritten too, so a row always carries its record's owner and organization.
      await db
        .insertInto(MEDIA_HASHES_TABLE)
        .values(row as never)
        .onConflict((oc) =>
          oc.column("mediaId").doUpdateSet({
            sha256: row.sha256,
            phash: row.phash,
            ownerId: row.ownerId,
            organizationId: row.organizationId,
          }),
        )
        .execute();
    },

    async deleteByMedia(mediaId) {
      await db.deleteFrom(MEDIA_HASHES_TABLE).where("mediaId", "=", mediaId).execute();
    },

    async findBySha256(sha256, scope) {
      const rows = await scoped(scope).select(["mediaId", "mediaType"]).where("sha256", "=", sha256).execute();
      return rows.map((row) => ({ mediaId: row.mediaId, mediaType: row.mediaType as MediaType }));
    },

    async listImagePhashes(scope) {
      const rows = await scoped(scope)
        .select(["mediaId", "phash"])
        .where("mediaType", "=", "image")
        .where("phash", "is not", null)
        .execute();
      const entries: HashPhashEntry[] = [];
      for (const row of rows) {
        if (typeof row.phash === "string" && row.phash.length > 0)
          entries.push({ mediaId: row.mediaId, phash: row.phash });
      }
      return entries;
    },
  };
}
