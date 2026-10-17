// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import { z } from "zod";
import { MediaType } from "./enums";

/**
 * One row in `pithy_media_hashes` — a dedup hash beside its record. Duplicate detection is a query
 * workload: an exact `sha256` lookup, and a bounded near-duplicate `phash` scan over images.
 *
 * **The owner and organization are denormalized here, because this is the query surface.** Every lookup
 * is scoped to the tenant asking — the organization in force, or the owner when none is — so the scope is
 * the leading column of every index the lookups use. A join to the record table would put the scope
 * behind a second read and couple the two tables on the one path that must not leak.
 */
export const MediaHash = z
  .object({
    id: z.number().int().describe("Auto-increment primary key."),
    mediaId: z.string().describe("The id of the media record this hash belongs to (one row per record)."),
    mediaType: MediaType.describe("The media type — scopes the near-duplicate scan to images."),
    ownerId: z
      .string()
      .nullable()
      .describe("The record's owner, copied from it on upsert. Null for a system-owned record."),
    organizationId: z
      .string()
      .nullable()
      .describe("The record's organization, copied from it on upsert. Null when none was in force."),
    sha256: z.string().describe("Lowercase-hex SHA-256 of the original file, for exact-match dedup."),
    phash: z.string().nullish().describe("Perceptual hash (hex) for near-duplicate images; null for other types."),
    createdAt: SQLiteDate.describe("When the hash row was written."),
  })
  .describe("One dedup hash in `pithy_media_hashes`, carrying the tenant it belongs to.");
export type MediaHash = z.output<typeof MediaHash>;
