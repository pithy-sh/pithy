// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import { z } from "zod";

/**
 * One revocable share link — the row in `pithy_storage_shares`.
 *
 * **Why this is a table and not a presigned URL.** A presigned URL cannot be revoked, only expired.
 * Once minted it is valid until its signature lapses, and nothing the owner does can call it back —
 * so "share this file, and let me take it back" is impossible to build on presigning alone. A share
 * is therefore a row: the token is looked up on every fetch, and revoking is a write, effective on
 * the next request.
 *
 * That is also why `revokedAt` is a timestamp rather than a deleted row. A revoked share stays
 * readable as history, and a fetch against it answers `storage/share_revoked` (410 Gone) instead of
 * the `storage/not_found` a deleted row would produce — which tells the holder the link existed and
 * was withdrawn, rather than leaving them guessing.
 */
export const StorageShare = z
  .object({
    token: z
      .string()
      .min(1)
      .describe("The share token — the primary key, and the whole credential. High-entropy and server-generated."),
    objectId: z.uuid().describe("The object this share grants read access to. References `pithy_storage_objects.id`."),
    expiresAt: SQLiteDate.nullable().describe(
      "When the link stops working. Null never expires — only revocation ends it.",
    ),
    revokedAt: SQLiteDate.nullable().describe("When the owner withdrew the link. Null while it is live."),
    createdAt: SQLiteDate.describe("When the link was minted."),
  })
  .describe("One revocable share link — the row in `pithy_storage_shares`.");
export type StorageShare = z.output<typeof StorageShare>;
export type StorageShareRow = z.input<typeof StorageShare>;
