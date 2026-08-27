// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";

/**
 * The media capability's configuration — the thin, user-owned surface in `pithy.config.ts`. The adopter
 * picks a storage backend per media type and toggles AI enrichment; the package owns everything else.
 * Every AI model is a configurable parameter with the CMS default, so an adopter swaps a model without
 * touching package code. Every field is `.describe()`d — the descriptions feed the self-documenting CLI.
 */

/** Default Workers AI model for image-to-text (alt text and captions). */
export const DEFAULT_IMAGE_TO_TEXT_MODEL = "@cf/llava-hf/llava-1.5-7b-hf";
/** Default Workers AI model for speech-to-text transcription (audio and video). */
export const DEFAULT_TRANSCRIBE_MODEL = "@cf/openai/whisper-large-v3-turbo";

/** Image storage + optional alt-text/caption enrichment. */
export const MediaImageConfig = z
  .object({
    store: z
      .enum(["r2", "cf-images"])
      .default("cf-images")
      .describe(
        "Where image bytes live: `cf-images` (Cloudflare Images — variants and optimized delivery) or `r2` (raw ownership).",
      ),
    imageToText: z
      .boolean()
      .default(false)
      .describe("Generate alt text and a caption for each image with Workers AI. A no-op with no cost when off."),
    model: z
      .string()
      .default(DEFAULT_IMAGE_TO_TEXT_MODEL)
      .describe(
        "The Workers AI vision model used for alt text and captions. Override to swap models with no code edits.",
      ),
  })
  .describe("Image storage backend and optional image-to-text enrichment.");
export type MediaImageConfig = z.output<typeof MediaImageConfig>;

/** Video storage + optional transcription enrichment. */
export const MediaVideoConfig = z
  .object({
    store: z
      .enum(["r2", "cf-stream"])
      .default("cf-stream")
      .describe(
        "Where video lives: `cf-stream` (Cloudflare Stream — encoding, HLS delivery, adaptive bitrate) or `r2` (raw files).",
      ),
    transcribe: z
      .boolean()
      .default(false)
      .describe("Transcribe each video's audio with Workers AI as a Workflow. A no-op with no cost when off."),
    model: z
      .string()
      .default(DEFAULT_TRANSCRIBE_MODEL)
      .describe(
        "The Workers AI speech-to-text model used for transcription. Override to swap models with no code edits.",
      ),
  })
  .describe("Video storage backend and optional speech-to-text enrichment.");
export type MediaVideoConfig = z.output<typeof MediaVideoConfig>;

/** Audio storage (R2) + optional transcription enrichment. */
export const MediaAudioConfig = z
  .object({
    store: z.literal("r2").default("r2").describe("Audio is always stored in R2; the field is fixed for symmetry."),
    transcribe: z
      .boolean()
      .default(false)
      .describe("Transcribe each audio file with Workers AI as a Workflow. A no-op with no cost when off."),
    model: z
      .string()
      .default(DEFAULT_TRANSCRIBE_MODEL)
      .describe(
        "The Workers AI speech-to-text model used for transcription. Override to swap models with no code edits.",
      ),
  })
  .describe("Audio storage (R2) and optional speech-to-text enrichment.");
export type MediaAudioConfig = z.output<typeof MediaAudioConfig>;

/** Document storage (R2) + optional text extraction. */
export const MediaDocumentConfig = z
  .object({
    store: z
      .literal("r2")
      .default("r2")
      .describe("Documents are always stored in R2; the field is fixed for symmetry."),
    extractText: z
      .boolean()
      .default(false)
      .describe(
        "Extract text (markdown) from pdf/doc/docx with Workers AI as a Workflow. A no-op with no cost when off.",
      ),
  })
  .describe("Document storage (R2) and optional text extraction.");
export type MediaDocumentConfig = z.output<typeof MediaDocumentConfig>;

/**
 * Public delivery configuration — the non-secret account values needed to build consumer URLs for stored
 * media (see `deliver/url.ts`). These are public identifiers (they appear in delivery URLs), so they live
 * in config, not in `@pithy-sh/secrets`.
 */
export const MediaDelivery = z
  .object({
    imagesAccountHash: z
      .string()
      .optional()
      .describe(
        "The Cloudflare Images account hash, used to build `imagedelivery.net` URLs and to read image bytes for enrichment.",
      ),
    streamCustomerCode: z
      .string()
      .optional()
      .describe(
        "The Cloudflare Stream customer subdomain code, used to build `customer-<code>.cloudflarestream.com` playback URLs.",
      ),
    r2PublicBaseUrl: z
      .string()
      .optional()
      .describe(
        "A public base URL for R2 objects when the bucket is served publicly; otherwise consumers use a presigned download URL.",
      ),
  })
  .describe("Public delivery configuration for building consumer media URLs.");
export type MediaDelivery = z.output<typeof MediaDelivery>;

/**
 * The full media configuration. `recordStore` chooses where records live (D1 by default; a KV opt-in for
 * KV-only projects, with its query limitations documented). Each media type block picks a backend and
 * toggles its enrichment.
 */
export const MediaConfig = z
  .object({
    recordStore: z
      .enum(["d1", "kv"])
      .default("d1")
      .describe(
        "Where media records live: `d1` (default — transcriptions and extracted text are queryable) or `kv` (key-lookup only; no text search over derived content). Duplicate detection always uses D1 either way.",
      ),
    delivery: MediaDelivery.prefault({}).describe("Public delivery configuration for building consumer media URLs."),
    kvMetadata: z
      .array(z.string())
      .default(["type", "status", "hasTranscription", "hasExtractedText"])
      .describe(
        "For `recordStore: 'kv'` only: which record fields to also store as KV metadata. Metadata rides free on a KV `list` (no per-value read), so `list` filters, sorts, and renders from it — put the fields your list views need here (e.g. an owning `userId` for owner-scoped lists). KV caps metadata at 1024 bytes serialized, so keep it to small scalar fields. `type` and `createdAt` are always included (list filters by type and sorts by recency). Ignored in D1 mode.",
      ),
    images: MediaImageConfig.prefault({}).describe("Image storage and enrichment settings."),
    video: MediaVideoConfig.prefault({}).describe("Video storage and enrichment settings."),
    audio: MediaAudioConfig.prefault({}).describe("Audio storage and enrichment settings."),
    documents: MediaDocumentConfig.prefault({}).describe("Document storage and enrichment settings."),
  })
  .describe("Configuration for the media capability — record store plus per-type backend and enrichment.");
export type MediaConfig = z.output<typeof MediaConfig>;
export type MediaConfigInput = z.input<typeof MediaConfig>;
