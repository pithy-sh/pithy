// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { RecordVisibility } from "@pithy-sh/core/src/access/visibility";
import { SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import { z } from "zod";

/**
 * One stored file — the row in `pithy_storage_objects`.
 *
 * Two identifiers, deliberately. `key` is the R2 object key: server-derived, opaque, unique, and
 * never shown to a client. `path` is the adopter's logical name (`invoices/2026/q3.pdf`): indexed and
 * listed from SQL, and never interpolated into a key. Separating them is what removes traversal,
 * collision, and injection surfaces at once, and it keeps the key format an internal detail we can
 * change without breaking an adopter's paths.
 *
 * `id` is a UUID, not an autoincrement integer, because it is externally exposed in every route path
 * (CLAUDE.md §ID strategy) — a sequential id would let anyone enumerate how many files exist and
 * probe for neighbors.
 *
 * `size` is declared by the client at init and *confirmed* against R2 at completion. It is nullable
 * because a caller may not know it up front; a null size reserves no quota, which is why the handler
 * requires it whenever a quota is configured.
 *
 * **Whose it is.** `ownerId` is the authenticated user and `organizationId` the organization they were
 * acting for when the file was written — the same two columns, in the same terms, as a media record, so
 * one name answers *what is this account holding* across both. The organization is the fact at the time
 * of the write, never a join through current membership.
 */

/**
 * Who may read an object without a share link — core's three levels, the same ones media uses. Visibility
 * is authorization, not a bucket setting: the bucket itself stays private.
 */
export const StorageVisibility = RecordVisibility.describe(
  "Who may read an object without a share link: `private` is its owner, acting for its organization; `organization` is any member acting for it; `public` is anyone with the id. Visibility is authorization, not a bucket setting — the bucket itself stays private.",
);
export type StorageVisibility = z.infer<typeof StorageVisibility>;

export const StorageObjectStatus = z
  .enum(["pending", "stored", "failed"])
  .describe(
    "Where an upload is: `pending` reserved the row and its quota but has no bytes yet, `stored` has bytes R2 confirmed, `failed` was abandoned. A `pending` row past its TTL is what the orphan sweep reclaims.",
  );
export type StorageObjectStatus = z.infer<typeof StorageObjectStatus>;

export const StorageObject = z
  .object({
    id: z.uuid().describe("The object's public id — a UUID, because it appears in every route path."),
    key: z
      .string()
      .min(1)
      .describe("The opaque R2 object key, server-derived (`obj/<uuid>`). Unique, and never sent to a client."),
    path: z
      .string()
      .min(1)
      .describe("The adopter's logical path (`invoices/2026/q3.pdf`). Indexed and listable; never part of the key."),
    ownerId: z
      .string()
      .nullable()
      .describe("The authenticated user who owns the file, from AuthContext. Null for system-owned objects."),
    organizationId: z
      .string()
      .nullable()
      .describe(
        "The organization the owner was acting for when the file was written, from the acting-organization seam. Null when none was in force, and for system-owned objects.",
      ),
    contentType: z
      .string()
      .min(1)
      .describe(
        "The MIME type. Declared at init and overwritten at completion with what R2 stored — a presigned PUT cannot sign a content type, so only the completed row is authoritative. An active type is still neutralised on serve.",
      ),
    size: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .describe("Byte count. Declared at init so the pending row reserves quota; confirmed against R2 at completion."),
    visibility: StorageVisibility.describe(
      "Who may read this object: its owner, its organization's members, or anyone with the id.",
    ),
    checksum: z
      .string()
      .nullable()
      .describe("Lowercase hex SHA-256 of the bytes, when one is known. Null until a completion supplies it."),
    status: StorageObjectStatus.describe("The upload's lifecycle state."),
    uploadId: z
      .string()
      .nullable()
      .describe("The multipart upload id while one is in flight. Null for a single-PUT upload and after completion."),
    createdAt: SQLiteDate.describe("When the upload was initiated — the age the orphan sweep measures."),
    updatedAt: SQLiteDate.describe("When the row last changed state."),
  })
  .describe("One stored file — the row in `pithy_storage_objects`.");
export type StorageObject = z.output<typeof StorageObject>;
export type StorageObjectRow = z.input<typeof StorageObject>;
