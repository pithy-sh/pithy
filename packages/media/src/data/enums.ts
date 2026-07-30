// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";

/**
 * The closed enums the media capability's schemas and handlers share. Each is a described Zod enum
 * (the object model's documentation) with its inferred type exported under the same name.
 */

/** The four kinds of media the capability stores and enriches. The discriminator across every record. */
export const MediaType = z
  .enum(["image", "video", "audio", "document"])
  .describe("The kind of media: image, video, audio, or document. The discriminator on every record.");
export type MediaType = z.output<typeof MediaType>;

/**
 * A media record's lifecycle. A record is created `pending` when its upload URL is minted, flips to
 * `stored` once the client confirms the bytes landed (finalize), and is `failed` if finalize could not
 * verify the object.
 */
export const MediaStatus = z
  .enum(["pending", "stored", "failed"])
  .describe("A media record's lifecycle: `pending` (URL minted), `stored` (upload finalized), or `failed`.");
export type MediaStatus = z.output<typeof MediaStatus>;

/**
 * Where a media object's bytes live. Chosen per media type by config: images to `r2` or `cf-images`,
 * video to `r2` or `cf-stream`, audio and documents always to `r2`.
 */
export const StorageBackend = z
  .enum(["r2", "cf-images", "cf-stream"])
  .describe("The Cloudflare product a media object's bytes live in: `r2`, `cf-images`, or `cf-stream`.");
export type StorageBackend = z.output<typeof StorageBackend>;

/**
 * The document extensions Workers AI `toMarkdown` can extract text from. Extraction is only dispatched
 * for these — a `.txt`, `.png`, or unknown extension is never enqueued (no wasted Workflow, no cost).
 * Matches the CMS's supported set.
 */
export const EXTRACTABLE_EXTENSIONS = ["pdf", "doc", "docx"] as const;

/** The file extension of a filename, lowercased, or the empty string. */
export function fileExtension(filename: string): string {
  if (typeof filename !== "string") return "";
  const dot = filename.lastIndexOf(".");
  return dot >= 0 ? filename.slice(dot + 1).toLowerCase() : "";
}

/** Whether a document's filename is one text extraction supports (pdf/doc/docx). */
export function isExtractableDocument(filename: string): boolean {
  return (EXTRACTABLE_EXTENSIONS as readonly string[]).includes(fileExtension(filename));
}
