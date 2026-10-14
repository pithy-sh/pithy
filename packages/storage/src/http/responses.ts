// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { StorageObjectStatus, StorageVisibility } from "../data/storageObject";
import { UploadedPart } from "../object/uploadedPart";

/**
 * What the storage routes return as JSON, as Zod objects a client can validate against and the OpenAPI
 * contract can describe. The byte-serving routes (`GET` and `HEAD /storage/:id`, `GET /s/:token`) answer
 * with the object itself rather than JSON, and `routes.ts` describes those inline.
 *
 * `schemas.ts` bounds what a caller may send; this file states what it gets back. These describe JSON on
 * the wire, so a date is the ISO-8601 string `c.json` writes, and nothing here carries a codec or a
 * transform: parsing a response hands back exactly what went in, which is what lets
 * `routes.workers.test.ts` parse a real answer and compare it with the original.
 *
 * **A field added here later is `.optional()` as well as `.nullable()`.** A client generated from the
 * contract reads Workers on older releases too, and a required key they cannot send fails it outright.
 */

/** A stored file as a client sees it. The object key and the R2 upload id never appear. */
export const StorageObjectResponse = z
  .object({
    id: z.string().describe("The file's id. What every other route takes as `:id`."),
    path: z.string().describe("The file's logical path, as the owner named it. Never an R2 key."),
    ownerId: z.string().nullable().describe("The id of the user who owns the file, or null for a system-owned file."),
    contentType: z
      .string()
      .describe("The file's MIME type: as declared at upload, replaced at completion by the type R2 stored."),
    size: z
      .number()
      .int()
      .nullable()
      .describe("The file's size in bytes: as declared at upload, replaced at completion by what R2 stored."),
    visibility: StorageVisibility,
    checksum: z
      .string()
      .nullable()
      .describe(
        "Lowercase hex SHA-256 the client reported at completion, or R2's own when it reported none. Null until stored.",
      ),
    status: StorageObjectStatus,
    createdAt: z.iso.datetime().describe("When the upload was started, ISO-8601."),
    updatedAt: z.iso.datetime().describe("When the record last changed, ISO-8601."),
  })
  .describe("One stored file, without its object key or upload id.");
export type StorageObjectResponse = z.infer<typeof StorageObjectResponse>;

/** One part of a multipart upload, with the URL its bytes go to. */
export const UploadPartTargetResponse = z
  .object({
    partNumber: z.number().int().describe("The part's 1-based index within the upload."),
    offset: z.number().int().describe("Where the part starts in the file, in bytes from 0."),
    length: z.number().int().describe("How many bytes the part carries."),
    url: z.string().describe("The presigned URL to PUT exactly these bytes to. Valid for an hour."),
  })
  .describe("One part of a multipart upload and where to send it.");
export type UploadPartTargetResponse = z.infer<typeof UploadPartTargetResponse>;

/** Where the bytes go: one URL, or one per part. */
export const UploadTargetResponse = z
  .discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("single").describe("One PUT carries the whole file."),
        url: z.string().describe("The presigned URL to PUT the whole file to. It signs the declared size."),
      })
      .describe("A single-PUT upload."),
    z
      .object({
        kind: z.literal("multipart").describe("The file goes up in parts, each to its own URL."),
        uploadId: z.string().describe("R2's id for the multipart upload."),
        partSize: z.number().int().describe("The size of every part but the last, in bytes."),
        parts: z.array(UploadPartTargetResponse).describe("Every part, in order, each with its own URL."),
      })
      .describe("A multipart upload, used once the file is past the configured threshold."),
  ])
  .describe("Where to send the file's bytes.");
export type UploadTargetResponse = z.infer<typeof UploadTargetResponse>;

/** What starting an upload returns. */
export const UploadInitResponse = z
  .object({
    object: StorageObjectResponse,
    upload: UploadTargetResponse,
  })
  .describe("The upload was started: the pending file's record, and where its bytes go.");
export type UploadInitResponse = z.infer<typeof UploadInitResponse>;

/** One page of the caller's files. */
export const ObjectListResponse = z
  .object({
    objects: z.array(StorageObjectResponse).describe("The caller's files on this page, ordered by logical path."),
    cursor: z
      .string()
      .optional()
      .describe("Pass this back as `cursor` to read the next page. Absent on the last page."),
  })
  .describe("One page of the caller's files.");
export type ObjectListResponse = z.infer<typeof ObjectListResponse>;

/** Where a resuming client stands. */
export const UploadPartsResponse = z
  .object({
    uploadId: z.string().describe("R2's id for the multipart upload."),
    partSize: z.number().int().describe("The size of every part but the last, in bytes."),
    partCount: z.number().int().describe("How many parts the upload has in all."),
    uploaded: z.array(UploadedPart).describe("The parts R2 already holds. Do not send these again."),
    missing: z.array(UploadPartTargetResponse).describe("The parts still to send, each with a freshly presigned URL."),
  })
  .describe("A multipart upload's progress: what R2 holds, and a live URL for every part it does not.");
export type UploadPartsResponse = z.infer<typeof UploadPartsResponse>;

/** A presigned direct-download URL. */
export const PresignedUrlResponse = z
  .object({
    url: z.string().describe("A presigned GET for the file's bytes. Anyone holding it can read them until it lapses."),
    expiresInSeconds: z.number().int().describe("How long the URL works, in seconds from now."),
  })
  .describe("A short-lived direct-download URL that bypasses the Worker.");
export type PresignedUrlResponse = z.infer<typeof PresignedUrlResponse>;

/** What deleting a file returns. */
export const ObjectDeletedResponse = z
  .object({
    id: z.string().describe("The id of the file that was deleted."),
    deleted: z.literal(true).describe("Always true: the file, its record and its share links are gone."),
  })
  .describe("The file was deleted.");
export type ObjectDeletedResponse = z.infer<typeof ObjectDeletedResponse>;

/** A minted share link. */
export const ShareResponse = z
  .object({
    token: z
      .string()
      .describe("The share token. The link is the share path followed by this, and it is the credential."),
    objectId: z.string().describe("The id of the file the link reads."),
    expiresAt: z.iso
      .datetime()
      .nullable()
      .describe("When the link stops working, ISO-8601, or null when it never expires."),
    createdAt: z.iso.datetime().describe("When the link was minted, ISO-8601."),
  })
  .describe("A revocable share link for one file.");
export type ShareResponse = z.infer<typeof ShareResponse>;

/** What revoking a share link returns. */
export const ShareRevokedResponse = z
  .object({
    token: z.string().describe("The share token that was revoked."),
    revokedAt: z.iso.datetime().describe("When the link was first revoked, ISO-8601. Revoking again keeps this time."),
  })
  .describe("The share link was revoked.");
export type ShareRevokedResponse = z.infer<typeof ShareRevokedResponse>;
