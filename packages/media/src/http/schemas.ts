import { z } from "zod";
import { MediaType } from "../data/enums";

/**
 * The request schemas for the media routes. Validation happens at the HTTP boundary (CLAUDE.md §Zod).
 * The create body is `loose` so an adopter's extension fields pass through to be validated against the
 * effective record schema; the known client fields are typed and bounded here.
 */

const HEX = /^[0-9a-f]+$/;

/** The client-supplied part of a media record on upload-init. Server fields (id, status, storage) are set by the handler. */
export const CreateMediaInput = z
  .object({
    type: MediaType.describe("The kind of media being uploaded."),
    name: z.string().min(1).describe("A human-readable display name for the media."),
    filename: z.string().min(1).describe("The original client filename, including extension."),
    contentType: z.string().min(1).describe("The MIME type of the bytes being uploaded."),
    size: z.number().int().positive().nullish().describe("The declared size in bytes, if known."),
    sha256: z
      .string()
      .regex(HEX)
      .length(64)
      .nullish()
      .describe("Client-computed lowercase-hex SHA-256 of the file, for exact-match dedup."),
    phash: z.string().regex(HEX).nullish().describe("Client-computed perceptual hash (hex) for near-duplicate images."),
    width: z.number().int().positive().nullish().describe("Original pixel width for images and video."),
    height: z.number().int().positive().nullish().describe("Original pixel height for images and video."),
  })
  .loose()
  .describe("The client-supplied fields for creating a media record; extra keys are adopter extension fields.");
export type CreateMediaInput = z.output<typeof CreateMediaInput>;

/** Optional fields a client may supply on finalize (computed after the upload landed). */
export const FinalizeMediaInput = z
  .object({
    size: z.number().int().positive().nullish().describe("The final object size in bytes, now that it is known."),
    sha256: z.string().regex(HEX).length(64).nullish().describe("The SHA-256 computed over the uploaded bytes."),
    phash: z.string().regex(HEX).nullish().describe("The perceptual hash computed over the uploaded image."),
  })
  .describe("Optional fields supplied when finalizing an upload.");
export type FinalizeMediaInput = z.output<typeof FinalizeMediaInput>;

/** The duplicate-search request. */
export const DuplicatesInput = z
  .object({
    type: MediaType.describe("The media type to search within."),
    sha256: z.string().regex(HEX).length(64).describe("The SHA-256 to match exactly."),
    phash: z.string().regex(HEX).optional().describe("The perceptual hash to match near, for images."),
    threshold: z
      .number()
      .int()
      .min(0)
      .max(64)
      .optional()
      .describe("The Hamming distance under which two perceptual hashes count as near-duplicates."),
    limit: z.number().int().min(1).max(50).optional().describe("The maximum number of candidates to return."),
  })
  .describe("A request to find exact and near duplicates of a file.");
export type DuplicatesInput = z.output<typeof DuplicatesInput>;

/** Query parameters for listing media. */
export const ListMediaQuery = z
  .object({
    type: MediaType.optional().describe("Restrict the listing to one media type."),
    limit: z.coerce.number().int().min(1).max(100).optional().describe("Maximum records per page."),
    cursor: z.string().optional().describe("Continuation cursor from a previous page."),
  })
  .describe("Query parameters for the media list route.");
export type ListMediaQuery = z.output<typeof ListMediaQuery>;
