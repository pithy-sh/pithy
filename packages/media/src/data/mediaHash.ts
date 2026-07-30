// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import { z } from "zod";
import { MediaType } from "./enums";

/**
 * One row in `pithy_media_hashes` — a dedup hash decoupled from the record store. Duplicate detection is
 * a query workload (exact `sha256` lookup, and a bounded near-duplicate `phash` scan over images), which
 * KV cannot do; so hashes always live in D1, regardless of whether records live in D1 or KV. This is why
 * the media capability requires the `DB` binding even in `recordStore: 'kv'` mode.
 */
export const MediaHash = z
  .object({
    id: z.number().int().describe("Auto-increment primary key."),
    mediaId: z.string().describe("The id of the media record this hash belongs to (one row per record)."),
    mediaType: MediaType.describe("The media type — scopes the near-duplicate scan to images."),
    sha256: z.string().describe("Lowercase-hex SHA-256 of the original file, for exact-match dedup."),
    phash: z.string().nullish().describe("Perceptual hash (hex) for near-duplicate images; null for other types."),
    createdAt: SQLiteDate.describe("When the hash row was written."),
  })
  .describe("One dedup hash in `pithy_media_hashes` — always D1, so dedup works whatever the record store.");
export type MediaHash = z.output<typeof MediaHash>;
