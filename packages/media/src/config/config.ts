// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { VisibilityPolicy } from "@pithy-sh/core/src/access/visibility";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
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

/** The default lifetime of a signed delivery URL: one hour, long enough to play a video through. */
export const DEFAULT_SIGNED_URL_TTL_SECONDS = 60 * 60;

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
        "A public base URL for R2 objects when the bucket is served publicly. A public bucket serves every key in it, so this is refused unless `visibility.allowed` is `['public']`; otherwise consumers use a presigned download URL.",
      ),
    signedUrlTtlSeconds: z
      .number()
      .int()
      .min(60)
      .max(7 * 24 * 60 * 60)
      .default(DEFAULT_SIGNED_URL_TTL_SECONDS)
      .describe(
        "How long a signed delivery URL for a non-public record stays valid, in seconds. One hour by default. A signed URL cannot be revoked, only outlived, so keep it short.",
      ),
  })
  .describe("Public delivery configuration for building consumer media URLs.");
export type MediaDelivery = z.output<typeof MediaDelivery>;

/**
 * How far duplicate detection looks. `tenant` — the default — is the organization when one is in force
 * and the owner otherwise, because *do you have this file* is not a question one tenant may ask about
 * another. `account` is every record in the account, and is the adopter saying so out loud.
 */
export const MediaDedup = z
  .object({
    scope: z
      .enum(["tenant", "account"])
      .default("tenant")
      .describe(
        "How far duplicate detection looks: `tenant` (default) is the organization in force, or the owner when none is; `account` is every record in the account. Only `account` lets one tenant learn another holds a file, so it is never the default.",
      ),
  })
  .describe("The scope duplicate detection searches within.");
export type MediaDedup = z.output<typeof MediaDedup>;

/**
 * The full media configuration. Records live in D1 — the only record store, because ownership, scoped
 * dedup and per-owner rollups are all queries. Each media type block picks a backend and toggles its
 * enrichment.
 */
export const MediaConfig = z
  .object({
    recordStore: z
      .literal("d1")
      .default("d1")
      .describe(
        "Where media records live: `d1`, the only record store. Transcriptions and extracted text are queryable, and so are owners and organizations. The `kv` store was removed — it could not group, sum, or scope a read.",
      ),
    visibility: VisibilityPolicy.prefault({}).describe(
      "Which visibility levels a media record may carry, and the one it gets when an upload names none. Private by default.",
    ),
    dedup: MediaDedup.prefault({}).describe("How far duplicate detection searches."),
    delivery: MediaDelivery.prefault({}).describe("Public delivery configuration for building consumer media URLs."),
    images: MediaImageConfig.prefault({}).describe("Image storage and enrichment settings."),
    video: MediaVideoConfig.prefault({}).describe("Video storage and enrichment settings."),
    audio: MediaAudioConfig.prefault({}).describe("Audio storage and enrichment settings."),
    documents: MediaDocumentConfig.prefault({}).describe("Document storage and enrichment settings."),
  })
  .describe(
    "Configuration for the media capability — visibility, dedup scope, delivery, and per-type backend and enrichment.",
  )
  .check((ctx) => {
    // A public bucket serves every key in it, so a private record stored there is public in all but name.
    if (!ctx.value.delivery.r2PublicBaseUrl) return;
    if (ctx.value.visibility.allowed.every((level) => level === "public")) return;
    ctx.issues.push({
      code: "custom",
      input: ctx.value,
      path: ["delivery", "r2PublicBaseUrl"],
      message: `delivery.r2PublicBaseUrl serves every key in the bucket, and visibility.allowed (${ctx.value.visibility.allowed.join(", ")}) admits a record that is not public. Remove r2PublicBaseUrl and serve through signed URLs, or narrow visibility.allowed to ["public"].`,
    });
  });
export type MediaConfig = z.output<typeof MediaConfig>;
export type MediaConfigInput = z.input<typeof MediaConfig>;

/**
 * Refuse the options a release removed, by name, before the config is parsed.
 *
 * **Never read as an empty table.** `recordStore: 'kv'` used to keep records in KV; a Worker that still
 * names it would otherwise parse as a type error at best, and at worst — had the key simply been dropped
 * — boot against an empty D1 record table and serve nothing, which is the failure that costs somebody a
 * day. `kvMetadata` was the KV store's alone. Both are refused with the remedy named.
 */
export function refuseRemovedMediaOptions(input: Record<string, unknown>): void {
  if (input.recordStore === "kv") {
    throw new ValidationError({
      message: "The `kv` media record store was removed. Media records live in D1.",
      action:
        "Remove `recordStore: 'kv'` from media({ … }) in this Worker's pithy.config.ts, then migrate each environment so the record table exists.",
      detail: "media({ recordStore: 'kv' }) names a record store this release no longer ships",
    });
  }
  if ("kvMetadata" in input) {
    throw new ValidationError({
      message: "`kvMetadata` was the KV record store's, and that store was removed.",
      action: "Remove `kvMetadata` from media({ … }) in this Worker's pithy.config.ts.",
      detail: "media({ kvMetadata }) configures a record store this release no longer ships",
    });
  }
}
