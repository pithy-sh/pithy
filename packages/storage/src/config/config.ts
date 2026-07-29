import { z } from "zod";
import { StorageVisibility } from "../data/storageObject";
import {
  DEFAULT_MULTIPART_THRESHOLD_BYTES,
  DEFAULT_PART_SIZE_BYTES,
  MAX_PART_SIZE_BYTES,
  MAX_UPLOAD_PARTS,
  MIN_PART_SIZE_BYTES,
} from "../object/multipart";

/**
 * The storage capability's config — the thin, user-owned surface in `pithy.config.ts`. Every field is
 * `.describe()`d: the descriptions feed the self-documenting CLI (CLAUDE.md §Config).
 *
 * Three decisions live here, and each has a real trade behind it.
 *
 * **Quota is unlimited by default, but the field is always present.** A default cap would silently
 * break the first adopter who stores something large; an absent field would mean bolting quotas on
 * later as a breaking change. So the knob exists from day one and starts off.
 *
 * **Multipart threshold 100 MiB, part size 64 MiB.** R2 caps an upload at 10,000 parts, so part size
 * fixes the practical object ceiling: 10,000 × 64 MiB ≈ 625 GiB. Raise `partSizeBytes` to raise the
 * ceiling (R2's own object cap is 4.995 TiB); the cost is that every retry re-sends a larger part.
 *
 * **Default visibility is private.** The safe default is the one where forgetting to set a field
 * cannot leak a file.
 */

/** The largest single-part upload R2 accepts — 5 GiB, less 5 MiB. Above it, multipart is not optional. */
const MAX_SINGLE_PART_BYTES = 5 * 1024 * 1024 * 1024 - 5 * 1024 * 1024;

export const StorageQuota = z
  .object({
    bytesPerOwner: z
      .number()
      .int()
      .positive()
      .nullable()
      .default(null)
      .describe(
        "The total bytes one owner may store, counting uploads still in flight. Null is unlimited — the default, because a cap that arrives by surprise breaks an adopter who was already storing more than it.",
      ),
  })
  .describe("Per-owner storage limits. Checked when an upload starts, against pending and stored bytes together.");
export type StorageQuota = z.output<typeof StorageQuota>;

export const StorageConfig = z
  .object({
    quota: StorageQuota.prefault({}).describe("Per-owner byte limits. Unlimited unless configured."),
    multipartThresholdBytes: z
      .number()
      .int()
      .min(MIN_PART_SIZE_BYTES)
      .max(MAX_SINGLE_PART_BYTES)
      .default(DEFAULT_MULTIPART_THRESHOLD_BYTES)
      .describe(
        "Uploads larger than this go multipart; smaller ones get one presigned PUT. It cannot exceed R2's ~5 GiB single-part cap, because above that multipart is the only way to store the bytes at all.",
      ),
    partSizeBytes: z
      .number()
      .int()
      .min(MIN_PART_SIZE_BYTES)
      .max(MAX_PART_SIZE_BYTES)
      .default(DEFAULT_PART_SIZE_BYTES)
      .describe(
        "Bytes per multipart part, for every part but the last. R2 allows at most 10,000 parts, so this fixes the largest object you can store: 64 MiB gives ~625 GiB. The floor is S3's 5 MiB rule for non-final parts.",
      ),
    defaultVisibility: StorageVisibility.default("private").describe(
      "Visibility for an upload that does not name one. Private, so a forgotten field can never publish a file.",
    ),
    pendingTtlSeconds: z
      .number()
      .int()
      .positive()
      .default(24 * 60 * 60)
      .describe(
        "How long a `pending` row holds its quota reservation before the orphan sweep reclaims it. Long enough for a slow multipart upload to finish; short enough that an abandoned one does not hold a quota forever.",
      ),
  })
  .describe("Configuration for the storage capability — quotas, multipart sizing, and default visibility.")
  .check((ctx) => {
    // A ceiling below the part size would mean the first "multipart" upload is a single short part,
    // which R2 accepts but which makes the threshold meaningless. Say so rather than silently allowing it.
    if (ctx.value.multipartThresholdBytes < ctx.value.partSizeBytes) {
      ctx.issues.push({
        code: "custom",
        input: ctx.value,
        path: ["multipartThresholdBytes"],
        message: `multipartThresholdBytes (${ctx.value.multipartThresholdBytes}) is below partSizeBytes (${ctx.value.partSizeBytes}). Every multipart upload would then be a single part.`,
      });
    }
  });
export type StorageConfig = z.output<typeof StorageConfig>;
export type StorageConfigInput = z.input<typeof StorageConfig>;

/**
 * The largest object this config can store: part size × R2's 10,000-part cap. Surfaced so the CLI and
 * docs can state a real number rather than a rule of thumb.
 */
export function maxObjectBytes(config: StorageConfig): number {
  return config.partSizeBytes * MAX_UPLOAD_PARTS;
}
