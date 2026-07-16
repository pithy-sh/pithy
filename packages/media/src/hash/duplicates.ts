import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import type { MediaType } from "../data/enums";
import type { RecordStore } from "../record/store";

/**
 * Duplicate detection — one exact key, one fuzzy key.
 *
 * Two records are the *same bytes* when their SHA-256 matches: an exact-duplicate is a single equality
 * lookup. Two images are *visually alike* when their perceptual hashes are close: a near-duplicate is a
 * Hamming distance under a threshold. This module ports the CMS dedup pass into pithy conventions — the
 * exact check runs for every type, the fuzzy check runs only for images that carry a perceptual hash.
 */

/**
 * The default perceptual-hash distance under which two images count as near-duplicates. A Hamming distance
 * of `0` is a pixel-identical image; small distances are crops, re-encodes, or watermarks; large distances
 * are unrelated images. Five is a conservative starting point tuned in the CMS — override per call when a
 * corpus wants a tighter or looser match.
 */
export const SIMILAR_THRESHOLD = 5;

/** How a perceptual-hash distance reads: an exact match, a near match under threshold, or unrelated. */
export type HammingResult = "identical" | "similar" | "different";

/**
 * Classify a perceptual-hash distance. `0` is `identical` (the same hash); a distance within `threshold`
 * is `similar` (a near-duplicate); anything further is `different`. The one place a raw distance becomes a
 * decision, so the scan and any caller agree on where the lines fall.
 */
export function classifyDistance(distance: number, threshold = SIMILAR_THRESHOLD): HammingResult {
  if (distance === 0) return "identical";
  if (distance <= threshold) return "similar";
  return "different";
}

/**
 * The Hamming distance between two equal-length hex perceptual hashes: the count of positions whose
 * characters differ. Both hashes come from the same phash algorithm, so they are always the same length;
 * a length mismatch means the inputs were produced differently and cannot be compared — an internal
 * invariant, so it throws rather than returning a meaningless number.
 */
export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) {
    throw new InternalError({
      message: "Perceptual hashes must be equal length.",
      detail: `lengths ${a.length} vs ${b.length}`,
    });
  }
  let distance = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) distance++;
  }
  return distance;
}

/** A record that matches the query, with why: `identical` bytes (SHA-256) or a `similar` image (phash). */
export interface DuplicateCandidate {
  /** The matching record's id. */
  id: string;
  /** The matching record's media type. */
  mediaType: MediaType;
  /** The perceptual-hash distance: `0` for an exact byte match, a small count for a near image match. */
  distance: number;
  /** Whether the match is the same bytes (`identical`) or a visually close image (`similar`). */
  kind: "identical" | "similar";
}

/** The query for a duplicate scan: the new object's hashes, its type, and optional scan tuning. */
export interface FindDuplicatesParams {
  /** The SHA-256 of the new object's bytes — the exact-duplicate key. */
  sha256: string;
  /** The new image's perceptual hash, when it has one. Absent for non-images; enables the near scan. */
  phash?: string;
  /** The new object's media type. The near scan runs only for `image`. */
  type: MediaType;
  /** Override the near-match distance threshold. Defaults to {@link SIMILAR_THRESHOLD}. */
  threshold?: number;
  /** Cap the number of candidates returned. Defaults to 10, closest first. */
  limit?: number;
}

/**
 * Find the records that duplicate a new object. Runs two passes against the {@link RecordStore}:
 *
 * 1. **Exact.** Every record with the same SHA-256 is a byte-identical duplicate (`kind: "identical"`,
 *    `distance: 0`), for any media type.
 * 2. **Near.** Only for an `image` that carries a `phash`: compare against every stored image phash,
 *    skipping records already matched exactly and any hash of a different length, and keep the ones whose
 *    Hamming distance is not `different` (`kind: "similar"`).
 *
 * The two sets are combined — exact matches never double-counted as near — sorted closest first (exact
 * matches lead at distance `0`), and capped to `limit`. Inputs are not mutated.
 */
export async function findDuplicates(store: RecordStore, params: FindDuplicatesParams): Promise<DuplicateCandidate[]> {
  const threshold = params.threshold ?? SIMILAR_THRESHOLD;
  const limit = params.limit ?? 10;

  // Pass 1 — exact byte matches by SHA-256. The id → type map also lets pass 2 skip records already exact.
  const exactRecords = await store.findBySha256(params.sha256);
  const exactTypes = new Map<string, MediaType>();
  for (const record of exactRecords) {
    exactTypes.set(record.id, record.type as MediaType);
  }

  const exact: DuplicateCandidate[] = exactRecords.map((record) => ({
    id: record.id,
    mediaType: record.type as MediaType,
    distance: 0,
    kind: "identical",
  }));

  // Pass 2 — near image matches by perceptual hash. Only when this is an image with a phash to compare.
  const near: DuplicateCandidate[] = [];
  if (params.type === "image" && params.phash) {
    const phash = params.phash;
    for (const entry of await store.listImagePhashes()) {
      if (exactTypes.has(entry.id)) continue;
      if (entry.phash.length !== phash.length) continue;
      const distance = hammingDistance(phash, entry.phash);
      if (classifyDistance(distance, threshold) === "different") continue;
      near.push({ id: entry.id, mediaType: "image", distance, kind: "similar" });
    }
  }

  // Combine, closest first, capped. A stable sort keeps the exact matches (distance 0) ahead of near ones.
  return [...exact, ...near].sort((a, b) => a.distance - b.distance).slice(0, limit);
}
