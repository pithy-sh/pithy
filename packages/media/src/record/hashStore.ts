// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import type { MediaType } from "../data/enums";
import { MediaHash } from "../data/mediaHash";
import { MEDIA_HASHES_TABLE, mediaHashDatabase } from "../data/tables";

/**
 * The dedup hash store — always D1, independent of where records live. Written on finalize, read by
 * duplicate search, deleted with the record. Keeping it in its own table (not on the record, not in KV)
 * is what makes `sha256` exact-match and `phash` near-duplicate detection work in every configuration.
 */

/** The hash to persist for one media record. */
export interface HashEntry {
  /** The media record id. */
  mediaId: string;
  /** The media type — scopes the near-duplicate scan to images. */
  mediaType: MediaType;
  /** Lowercase-hex SHA-256 of the file. */
  sha256: string;
  /** Perceptual hash for near-duplicate images; null/undefined for other types. */
  phash?: string | null;
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

/** The dedup hash store seam. */
export interface HashStore {
  /** Insert or replace the hash for a media record (idempotent per `mediaId`). */
  upsert(entry: HashEntry): Promise<void>;
  /** Delete the hash row for a media record. A miss is a no-op. */
  deleteByMedia(mediaId: string): Promise<void>;
  /** Every record whose `sha256` exactly matches — the exact-duplicate lookup. */
  findBySha256(sha256: string): Promise<HashMatch[]>;
  /** Every image record carrying a perceptual hash — the bounded set the near-duplicate scan compares. */
  listImagePhashes(): Promise<HashPhashEntry[]>;
}

/** Build the D1-backed hash store from the `DB` binding. */
export function d1HashStore(d1: D1Database, now: () => Date = () => new Date()): HashStore {
  const db = mediaHashDatabase(d1);
  return {
    async upsert(entry) {
      const row = MediaHash.encode({
        id: 0, // ignored — auto-increment PK
        mediaId: entry.mediaId,
        mediaType: entry.mediaType,
        sha256: entry.sha256,
        phash: entry.phash ?? null,
        createdAt: now(),
      });
      // `mediaId` is unique — replace any existing row so a re-finalize doesn't duplicate.
      await db
        .insertInto(MEDIA_HASHES_TABLE)
        .values(row as never)
        .onConflict((oc) => oc.column("mediaId").doUpdateSet({ sha256: row.sha256, phash: row.phash }))
        .execute();
    },

    async deleteByMedia(mediaId) {
      await db.deleteFrom(MEDIA_HASHES_TABLE).where("mediaId", "=", mediaId).execute();
    },

    async findBySha256(sha256) {
      const rows = await db
        .selectFrom(MEDIA_HASHES_TABLE)
        .select(["mediaId", "mediaType"])
        .where("sha256", "=", sha256)
        .execute();
      return rows.map((row) => ({ mediaId: row.mediaId, mediaType: row.mediaType as MediaType }));
    },

    async listImagePhashes() {
      const rows = await db
        .selectFrom(MEDIA_HASHES_TABLE)
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
