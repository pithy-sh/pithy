import { z } from "zod";
import { StorageMultipartFailedError } from "../error/errors";

/**
 * Part orchestration for a multipart upload: how many parts, how big, and how the ETags the client
 * reports back are turned into a completion list R2 will accept.
 *
 * **Why multipart at all.** A single presigned PUT is capped at 5 GiB, and it is not resumable — a
 * dropped connection at 4 GiB starts over. Multipart raises the ceiling and makes a lost client
 * cheap: `GET /storage/:id/parts` re-lists what R2 holds and re-presigns the rest, so the client
 * sends only what is missing. The server holds no transfer state beyond the pending row.
 *
 * **The defaults and the ceiling they imply.** Threshold 100 MiB, part size 64 MiB. R2 allows at
 * most 10,000 parts, so 10,000 × 64 MiB is a documented practical ceiling of ~625 GiB per object.
 * That is well short of R2's own 4.995 TiB object cap (and its 4.995 GiB single-part cap); an
 * adopter storing objects larger than ~625 GiB raises `partSizeBytes` in `pithy.config.ts` and gets
 * a proportionally higher ceiling. The trade is deliberate: a bigger default part size would make
 * every ordinary upload retry more expensive to serve a size almost nobody stores.
 *
 * **The 5 MiB floor** applies to every part but the last, and is S3's rule, not ours — R2 rejects a
 * completion whose non-final part is smaller. Enforcing it here means the failure lands at plan time
 * with a config-shaped message, rather than after the client has spent bandwidth on every part.
 */

/** Above this many bytes an upload goes multipart. Below it, one presigned PUT is simpler and cheaper. */
export const DEFAULT_MULTIPART_THRESHOLD_BYTES = 100 * 1024 * 1024;

/** Default bytes per part. With R2's 10,000-part cap this sets the ~625 GiB practical object ceiling. */
export const DEFAULT_PART_SIZE_BYTES = 64 * 1024 * 1024;

/** S3's floor for every part but the last. R2 rejects a completion that breaks it. */
export const MIN_PART_SIZE_BYTES = 5 * 1024 * 1024;

/** R2's per-part ceiling — the same 5 GiB that caps a single-part upload. */
export const MAX_PART_SIZE_BYTES = 5 * 1024 * 1024 * 1024;

/** R2's hard cap on parts in one multipart upload. */
export const MAX_UPLOAD_PARTS = 10_000;

/** One planned part: which number it is, where it starts, and how many bytes it carries. */
export const PartPlan = z
  .object({
    partNumber: z.number().int().min(1).describe("The part's 1-based index. R2 requires them contiguous from 1."),
    offset: z.number().int().nonnegative().describe("The part's first byte offset within the whole object."),
    length: z.number().int().positive().describe("The part's byte count. Every part but the last is `partSize`."),
  })
  .describe("One part of a planned multipart upload — the unit a client uploads and can re-send alone.");
export type PartPlan = z.output<typeof PartPlan>;

/** The whole plan for one object: the part size in force and every part it decomposes into. */
export const MultipartPlan = z
  .object({
    partSize: z.number().int().min(MIN_PART_SIZE_BYTES).describe("Bytes per part, for every part but the last."),
    partCount: z.number().int().min(1).describe("How many parts the object decomposes into."),
    parts: z.array(PartPlan).min(1).describe("Every part, ascending by `partNumber`."),
  })
  .describe("How one object is split for a multipart upload — the plan a client uploads against.");
export type MultipartPlan = z.output<typeof MultipartPlan>;

/** One part as the client reports it back after its PUT: the number it uploaded and the ETag R2 answered with. */
export const ReportedPart = z
  .object({
    partNumber: z.number().int().min(1).max(MAX_UPLOAD_PARTS).describe("The part number this ETag belongs to."),
    etag: z.string().min(1).describe("The `ETag` response header R2 returned for that part, verbatim."),
  })
  .describe("One completed part, as the client reports it back — the input to completing an upload.");
export type ReportedPart = z.output<typeof ReportedPart>;

/** Whether an upload of `size` bytes should go multipart under `threshold`. */
export function needsMultipart(size: number, threshold: number = DEFAULT_MULTIPART_THRESHOLD_BYTES): boolean {
  return size > threshold;
}

/**
 * Split `size` bytes into parts of `partSize`.
 *
 * Throws `storage/multipart_failed` when the plan cannot exist: a part size outside R2's 5 MiB–5 GiB
 * window, or a size that needs more than 10,000 parts. Both are configuration faults surfaced at
 * plan time — before a client has uploaded anything against a plan R2 would refuse to complete.
 */
export function planMultipart(size: number, partSize: number = DEFAULT_PART_SIZE_BYTES): MultipartPlan {
  if (!Number.isInteger(size) || size <= 0) {
    throw new StorageMultipartFailedError({
      message: "An upload needs a positive size.",
      action: "Declare the file's byte count when you start the upload.",
      detail: `multipart plan requested for size ${size}`,
    });
  }
  if (!Number.isInteger(partSize) || partSize < MIN_PART_SIZE_BYTES || partSize > MAX_PART_SIZE_BYTES) {
    throw new StorageMultipartFailedError({
      message: "The configured part size is outside what R2 accepts.",
      action: "Set `partSizeBytes` between 5 MiB and 5 GiB in pithy.config.ts.",
      detail: `partSize ${partSize} is outside [${MIN_PART_SIZE_BYTES}, ${MAX_PART_SIZE_BYTES}]`,
    });
  }

  const partCount = Math.ceil(size / partSize);
  if (partCount > MAX_UPLOAD_PARTS) {
    throw new StorageMultipartFailedError({
      message: "That file is too large for the configured part size.",
      action: `Raise \`partSizeBytes\` — R2 allows at most ${MAX_UPLOAD_PARTS} parts per upload.`,
      detail: `size ${size} at partSize ${partSize} needs ${partCount} parts`,
    });
  }

  const parts: PartPlan[] = [];
  for (let index = 0; index < partCount; index += 1) {
    const offset = index * partSize;
    // Only the final part may be short — that is the whole content of S3's 5 MiB floor.
    parts.push({ partNumber: index + 1, offset, length: Math.min(partSize, size - offset) });
  }
  return { partSize, partCount, parts };
}

/**
 * Turn the parts a client reports into the list R2's completion call takes: validated, deduplicated,
 * and ascending.
 *
 * Sorting is not cosmetic — S3 rejects an out-of-order part list, and the order concurrent PUTs
 * finish in is not the order the parts belong in. A gap, a duplicate, or a count that disagrees with
 * the plan is refused here rather than sent to R2, because R2's own rejection arrives as an opaque
 * SDK fault with nothing in it a client could act on.
 */
export function collectParts(reported: readonly ReportedPart[], expectedCount: number): ReportedPart[] {
  const parsed = z.array(ReportedPart).safeParse(reported);
  if (!parsed.success) {
    throw new StorageMultipartFailedError({
      detail: `reported parts failed validation: ${parsed.error.issues.map((i) => i.code).join(", ")}`,
    });
  }

  const byNumber = new Map<number, string>();
  for (const part of parsed.data) {
    const existing = byNumber.get(part.partNumber);
    if (existing !== undefined && existing !== part.etag) {
      throw new StorageMultipartFailedError({
        message: "Part list is inconsistent.",
        detail: `part ${part.partNumber} reported twice with different etags`,
      });
    }
    byNumber.set(part.partNumber, part.etag);
  }

  if (byNumber.size !== expectedCount) {
    throw new StorageMultipartFailedError({
      message: "The upload is missing parts.",
      action: "GET /storage/<id>/parts, then re-send the parts it reports missing.",
      detail: `expected ${expectedCount} distinct parts, got ${byNumber.size}`,
    });
  }

  for (let partNumber = 1; partNumber <= expectedCount; partNumber += 1) {
    if (!byNumber.has(partNumber)) {
      throw new StorageMultipartFailedError({
        message: "The upload is missing parts.",
        action: "GET /storage/<id>/parts, then re-send the parts it reports missing.",
        detail: `part ${partNumber} was never reported`,
      });
    }
  }

  return [...byNumber.entries()]
    .map(([partNumber, etag]) => ({ partNumber, etag }))
    .sort((a, b) => a.partNumber - b.partNumber);
}
