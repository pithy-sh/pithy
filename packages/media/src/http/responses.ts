// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { RecordVisibility } from "@pithy-sh/core/src/access/visibility";
import { z } from "zod";
import { MediaStatus, MediaType, StorageBackend } from "../data/enums";

/**
 * What the media routes return, as Zod objects a client can validate against and the OpenAPI contract
 * can describe.
 *
 * `schemas.ts` bounds what a caller may send; this file states what it gets back. These describe JSON on
 * the wire, so a date is the ISO-8601 string `c.json` writes and a flag is a plain boolean, and nothing
 * here carries a codec or a transform: parsing a response hands back exactly what went in, which is what
 * lets `routes.workers.test.ts` parse a real answer and compare it with the original.
 *
 * **A media record is loose.** An adopter extends it through `media({ extend })`, and those fields come
 * back on every record beside the base ones. This file can only describe the base.
 *
 * **A field added here later is `.optional()` as well as `.nullable()`.** A client generated from the
 * contract reads Workers on older releases too, and a required key they cannot send fails it outright.
 */

/** One media record on the wire: the base fields, plus whatever the adopter's extension adds. */
export const MediaRecordResponse = z
  .object({
    id: z.string().describe("The record's id. What every other route takes as `:id`."),
    type: MediaType,
    status: MediaStatus,
    name: z.string().describe("A human-readable display name for the media."),
    filename: z.string().describe("The original client filename, including extension."),
    contentType: z.string().describe("The MIME type of the stored bytes."),
    size: z.number().int().nullish().describe("The object's size in bytes, or null while it is not known."),
    ownerId: z
      .string()
      .nullable()
      .optional()
      .describe(
        "The user who owns the record. Null for a system-owned record, and for any record read by someone not acting for its organization; absent from a Worker that predates it.",
      ),
    organizationId: z
      .string()
      .nullable()
      .optional()
      .describe(
        "The organization the record was written under. Null when none was in force, and for any record read by someone not acting for it; absent from a Worker that predates it.",
      ),
    visibility: RecordVisibility.optional().describe(
      "Who may read the record. Absent from a Worker that predates visibility, where every signed-in user could.",
    ),
    signedDelivery: z
      .boolean()
      .optional()
      .describe("Whether the bytes are served only through signed URLs, as Cloudflare last confirmed."),
    signingPending: z
      .boolean()
      .optional()
      .describe(
        "Whether Cloudflare's signing setting has not yet caught up with the visibility: a change that failed halfway, or a record made private before signing was enforced. Send the visibility again to finish it.",
      ),
    storageBackend: StorageBackend,
    storageKey: z
      .string()
      .describe("The backend's handle to the bytes: the R2 object key, the CF Images id, or the CF Stream uid."),
    sha256: z
      .string()
      .nullish()
      .describe("Client-computed lowercase-hex SHA-256 of the file, or null if none was sent."),
    phash: z.string().nullish().describe("Client-computed perceptual hash (hex) for near-duplicate images, or null."),
    width: z.number().int().nullish().describe("Original pixel width for images and video, or null."),
    height: z.number().int().nullish().describe("Original pixel height for images and video, or null."),
    altText: z.string().nullish().describe("Alt text written by image-to-text enrichment, or null."),
    caption: z.string().nullish().describe("A longer caption written by image-to-text enrichment, or null."),
    transcription: z
      .string()
      .nullish()
      .describe("The speech-to-text transcription for audio or video, or null until written."),
    hasTranscription: z.boolean().describe("Whether a transcription has been written to this record."),
    extractedText: z.string().nullish().describe("Text extracted from a document, as markdown, or null until written."),
    hasExtractedText: z.boolean().describe("Whether extracted text has been written to this record."),
    createdAt: z.iso.datetime().describe("When the record was created and its upload URL minted, ISO-8601."),
    updatedAt: z.iso.datetime().describe("When the record was last written, ISO-8601."),
  })
  .loose()
  .describe("One media record. Any adopter extension fields arrive beside these.");
export type MediaRecordResponse = z.infer<typeof MediaRecordResponse>;

/** What upload-init returns. */
export const MediaUploadInitResponse = z
  .object({
    id: z.string().describe("The new record's id."),
    uploadUrl: z
      .string()
      .describe("The URL the client uploads the bytes to, directly. They never pass through the Worker."),
    storageBackend: StorageBackend,
    storageKey: z.string().describe("The backend's handle to the bytes once they land."),
  })
  .describe("The record was created pending: where to upload, and its coordinates.");
export type MediaUploadInitResponse = z.infer<typeof MediaUploadInitResponse>;

/** One page of media records. */
export const MediaListResponse = z
  .object({
    items: z.array(MediaRecordResponse).describe("The records on this page, newest first."),
    cursor: z
      .string()
      .optional()
      .describe(
        "Pass this back as `cursor` to read the next page. Absent on the last page. A page may hold fewer records than asked for and still carry one — a permission hook removed some — so the cursor, not the count, says whether there is more.",
      ),
  })
  .describe("One page of media records.");
export type MediaListResponse = z.infer<typeof MediaListResponse>;

/** One duplicate found by a duplicate search. */
export const DuplicateMatchResponse = z
  .object({
    id: z.string().describe("The matching record's id."),
    distance: z
      .number()
      .int()
      .describe("The perceptual-hash distance: `0` for an exact byte match, a small count for a near image match."),
    kind: z
      .enum(["identical", "similar"])
      .describe("`identical` for the same bytes, `similar` for a visually close image."),
    record: MediaRecordResponse,
  })
  .describe("One existing record that duplicates the file searched for.");
export type DuplicateMatchResponse = z.infer<typeof DuplicateMatchResponse>;

/** What a duplicate search returns. */
export const DuplicatesResponse = z
  .object({
    matches: z
      .array(DuplicateMatchResponse)
      .describe("Closest first, so exact matches lead. Capped at the requested limit. Empty when there are none."),
  })
  .describe("The duplicates found.");
export type DuplicatesResponse = z.infer<typeof DuplicatesResponse>;

/** What deleting a record returns. */
export const MediaDeletedResponse = z
  .object({
    id: z.string().describe("The id of the record that was deleted."),
    deleted: z
      .literal(true)
      .describe("Always true: the record and its hashes are gone, and its bytes were deleted best-effort."),
  })
  .describe("The record was deleted.");
export type MediaDeletedResponse = z.infer<typeof MediaDeletedResponse>;

/** What minting a delivery URL returns. */
export const MediaDeliveryUrlResponse = z
  .object({
    url: z.string().describe("The URL to load the bytes from. Signed and short-lived for a record that is not public."),
    expiresAt: z.iso
      .datetime()
      .nullable()
      .describe("When the URL stops working, ISO-8601. Null for a public record's plain URL, which does not expire."),
  })
  .describe("Where to load a record's bytes, and until when.");
export type MediaDeliveryUrlResponse = z.infer<typeof MediaDeliveryUrlResponse>;

/** Why a type's delivery cannot be reported here, as a code a client branches on. */
export const DeliveryUnavailableReason = z
  .enum(["stored-in-r2"])
  .describe(
    "Why a type's delivery is not reported: `stored-in-r2` — this Worker stores that type in R2, where Cloudflare Images and Stream count nothing.",
  );
export type DeliveryUnavailableReason = z.infer<typeof DeliveryUnavailableReason>;

/** A type whose delivery this Worker cannot report, and the sentence that says why. */
export const DeliveryUnavailable = z
  .object({
    state: z.literal("unavailable").describe("This type's delivery is not reported here."),
    reason: DeliveryUnavailableReason,
    message: z.string().describe("Why, in a sentence an operator can act on."),
  })
  .describe("A type whose delivery cannot be read, and why. Never reported as zero.");
export type DeliveryUnavailable = z.infer<typeof DeliveryUnavailable>;

/** One video's minutes delivered in the window. */
export const VideoDeliveryItem = z
  .object({
    id: z.string().describe("The media record's id."),
    name: z.string().describe("The record's display name."),
    storageKey: z.string().describe("The Cloudflare Stream uid the minutes were joined on."),
    minutesViewed: z
      .number()
      .int()
      .nonnegative()
      .describe("Minutes of video Cloudflare delivered for this asset in the window. `0` when nobody watched."),
  })
  .describe("Minutes of one video delivered in the window.");
export type VideoDeliveryItem = z.infer<typeof VideoDeliveryItem>;

/** One image's delivery requests in the window. */
export const ImageDeliveryItem = z
  .object({
    id: z.string().describe("The media record's id."),
    name: z.string().describe("The record's display name."),
    storageKey: z.string().describe("The Cloudflare Images id the requests were joined on."),
    requests: z
      .number()
      .int()
      .nonnegative()
      .describe("Delivery requests Cloudflare Images served for this asset in the window, every variant counted."),
  })
  .describe("Delivery requests for one image in the window.");
export type ImageDeliveryItem = z.infer<typeof ImageDeliveryItem>;

/** Video delivery: per asset, or unavailable and why. */
export const VideoDelivery = z
  .discriminatedUnion("state", [
    z
      .object({
        state: z.literal("reported").describe("Read from Cloudflare Stream's analytics."),
        assets: z
          .array(VideoDeliveryItem)
          .describe("Every stored Stream video in this environment, most watched first."),
      })
      .describe("Minutes delivered, per video."),
    DeliveryUnavailable,
  ])
  .describe("Minutes of video delivered in the window, per asset — or why they cannot be read.");
export type VideoDelivery = z.infer<typeof VideoDelivery>;

/** Image delivery: per asset, or unavailable and why. */
export const ImageDelivery = z
  .discriminatedUnion("state", [
    z
      .object({
        state: z.literal("reported").describe("Read from Cloudflare Images' analytics."),
        assets: z
          .array(ImageDeliveryItem)
          .describe("Every stored Cloudflare Images asset in this environment, most served first."),
      })
      .describe("Delivery requests, per image."),
    DeliveryUnavailable,
  ])
  .describe("Images served in the window, per asset — or why they cannot be read. Never an account total.");
export type ImageDelivery = z.infer<typeof ImageDelivery>;

/** What the delivery read returns. */
export const MediaDeliveryResponse = z
  .object({
    since: z.string().describe("The window's start, inclusive, as ISO-8601."),
    until: z.string().describe("The window's end, exclusive, as ISO-8601."),
    video: VideoDelivery,
    images: ImageDelivery,
  })
  .describe(
    "What this environment's media was served in the window, read from Cloudflare's analytics and joined to its own assets.",
  );
export type MediaDeliveryResponse = z.infer<typeof MediaDeliveryResponse>;
