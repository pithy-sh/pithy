import { SQLiteBoolean, SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import { z } from "zod";
import { MediaStatus, MediaType, StorageBackend } from "./enums";

/**
 * One row in `pithy_media_assets` — the spine of the capability. Every uploaded file is one record: a
 * single table with a `type` discriminator and nullable per-type derived columns, rather than a table
 * per media type. `z.output` is the app shape (Dates, booleans); `z.input` is the SQLite row (ms-epoch,
 * 0|1). All JS↔SQLite conversion runs through the core codecs — no raw `0/1`, epoch, or `new Date()` in
 * query code.
 *
 * The base fields are guaranteed for every configured backend and type. An adopter adds their own fields
 * (an owning `userId`, a tenant id, tags) by passing an extension schema to `media({ extend })`; the
 * mapping layer persists those to either store from that one schema — see `data/extend.ts`.
 *
 * `id` is a text UUID, not an autoincrement integer: a media id is handed to clients and embedded in
 * URLs, so it must not be enumerable (CLAUDE.md §Data layer — externally-exposed entities use a text id).
 */
export const MediaAsset = z
  .object({
    id: z
      .string()
      .describe("UUID primary key. Text, not autoincrement, so an externally-exposed media id cannot be enumerated."),
    type: MediaType.describe("The kind of media this record holds; drives which derived fields apply."),
    status: MediaStatus.describe("The record's lifecycle state — `pending`, `stored`, or `failed`."),
    name: z.string().describe("A human-readable display name for the media, supplied by the adopter's app."),
    filename: z.string().describe("The original client filename, retained for display and content-type inference."),
    contentType: z.string().describe("The MIME type of the stored bytes (e.g. `image/png`, `audio/mpeg`)."),
    size: z
      .number()
      .int()
      .nullish()
      .describe("The object's size in bytes; null until the upload is finalized with a known length."),
    storageBackend: StorageBackend.describe("The Cloudflare product the bytes live in — resolved from config."),
    storageKey: z
      .string()
      .describe("The backend-specific handle to the bytes: the R2 object key, the CF Images id, or the CF Stream uid."),
    sha256: z
      .string()
      .nullish()
      .describe("Client-computed lowercase-hex SHA-256 of the original file, for exact-match dedup; null if omitted."),
    phash: z
      .string()
      .nullish()
      .describe("Client-computed perceptual hash (16-hex blockhash) for near-duplicate images; null for non-images."),
    width: z.number().int().nullish().describe("Original pixel width for images and video; null for audio/documents."),
    height: z
      .number()
      .int()
      .nullish()
      .describe("Original pixel height for images and video; null for audio/documents."),
    altText: z
      .string()
      .nullish()
      .describe("Alt text for an image, written by the image-to-text enrichment when enabled; null otherwise."),
    caption: z
      .string()
      .nullish()
      .describe("A longer caption for an image, written by the image-to-text enrichment when enabled; null otherwise."),
    transcription: z
      .string()
      .nullish()
      .describe("The speech-to-text transcription for audio/video, written by the transcription Workflow; null until."),
    hasTranscription: SQLiteBoolean.describe("Whether a transcription has been written to this record."),
    extractedText: z
      .string()
      .nullish()
      .describe("Extracted document text (markdown), written by the document-extraction Workflow; null until."),
    hasExtractedText: SQLiteBoolean.describe("Whether extracted text has been written to this record."),
    createdAt: SQLiteDate.describe("When the record was created (its upload URL was minted)."),
    updatedAt: SQLiteDate.describe("When the record was last written."),
  })
  .describe("One media asset in `pithy_media_assets` — the record of a stored, tracked, enrichable file.");
export type MediaAsset = z.output<typeof MediaAsset>;
export type MediaAssetRow = z.input<typeof MediaAsset>;
