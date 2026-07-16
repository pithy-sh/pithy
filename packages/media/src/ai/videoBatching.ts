/**
 * Pure batching and overlap-dedup for video/audio transcription. These functions carry the whole
 * algorithm the transcription Workflow orchestrates — no Cloudflare imports, no I/O, no clock. The
 * Workflow fetches a Cloudflare Stream HLS audio rendition, hands its segment list here to decide what
 * to transcribe as one unit, then stitches the per-group transcripts back together here. Keeping the
 * logic pure is deliberate: this is the unit-testable core, and the Workflow stays a thin durable shell.
 *
 * Ported faithfully from the leed-ai CMS `audioUtils.ts`. The grouping is whole-segment (HLS segments
 * are the atomic unit — you can only fetch and decode a segment in full), greedy to a target length,
 * with a deliberate backward overlap so a model that drops or garbles words at a group boundary gets a
 * second look at that audio in the next group. The overlap is then removed from the text by
 * `removeOverlapPrefix` so the final transcript reads clean.
 */

/** One audio segment from a Cloudflare Stream HLS audio rendition: its URI and playback duration. */
export interface AudioSegment {
  /** The segment's URI, relative to or absolute against the rendition playlist; the fetch handle. */
  uri: string;
  /** The segment's playback duration in seconds, read from the HLS `#EXTINF` tag. */
  durationSec: number;
}

/** A group of contiguous segments to transcribe as one unit, with the group's total duration. */
export interface SegmentGroup {
  /** The contiguous segments in this group, in playlist order; transcribed together as one request. */
  segments: AudioSegment[];
  /** The forward-scan duration of the group in seconds — the sum accumulated before the overlap back-up. */
  durationSec: number;
}

/** The length a group grows to before the greedy scan stops. Long enough for coherent context. */
export const TARGET_GROUP_SEC = 30;

/** The minimum audio each group re-covers from the next, so boundary words are never lost. */
export const OVERLAP_SEC = 3;

/**
 * Group contiguous segments into transcription units. Greedy: scan whole segments forward until the
 * accumulated duration reaches `targetGroupSec`, emit that group, then back up over trailing segments
 * until at least `overlapSec` of audio will be re-covered by the next group — while always leaving at
 * least one fresh segment (`i > startIdx + 1`) so the next group makes forward progress and the loop
 * terminates. Empty input yields no groups.
 *
 * `SegmentGroup.durationSec` is the forward-scan total for that group, recorded before the overlap
 * back-up — it is not recomputed after backing up, matching the CMS behavior exactly.
 */
export function groupSegmentsForTranscription(
  segments: AudioSegment[],
  targetGroupSec = TARGET_GROUP_SEC,
  overlapSec = OVERLAP_SEC,
): SegmentGroup[] {
  const groups: SegmentGroup[] = [];
  let i = 0;

  while (i < segments.length) {
    const startIdx = i;
    let durationSec = 0;

    // Forward scan: accumulate whole segments until the group reaches the target length.
    while (i < segments.length && durationSec < targetGroupSec) {
      const seg = segments[i];
      if (seg === undefined) break;
      durationSec += seg.durationSec;
      i++;
    }

    groups.push({ segments: segments.slice(startIdx, i), durationSec });
    if (i >= segments.length) break;

    // Back up so the next group re-covers >= overlapSec of audio, keeping >= 1 fresh segment ahead.
    let overlapDur = 0;
    while (i > startIdx + 1 && overlapDur < overlapSec) {
      i--;
      const seg = segments[i];
      if (seg === undefined) break;
      overlapDur += seg.durationSec;
    }
  }

  return groups;
}

/**
 * Strip from `curr` the leading words it shares with the trailing words of `prev`. Search the LONGEST
 * overlap first: try `maxWords` trailing/leading words down to `minWords`, and on the first exact match
 * (case-insensitive) drop that many leading words from `curr`, returning the trimmed remainder. Below
 * `minWords` the match is too weak to trust, so on no match at any length `curr` is returned unchanged —
 * content is never dropped on an uncertain overlap.
 *
 * Words split on whitespace with empty tokens ignored. Comparison lowercases both sides, but the kept
 * words preserve `curr`'s own casing (re-joined with single spaces).
 */
export function removeOverlapPrefix(prev: string, curr: string, maxWords = 40, minWords = 3): string {
  const prevWords = prev.split(/\s+/).filter((w) => w.length > 0);
  const currWords = curr.split(/\s+/).filter((w) => w.length > 0);
  const maxN = Math.min(maxWords, prevWords.length, currWords.length);

  for (let n = maxN; n >= minWords; n--) {
    const tail = prevWords.slice(prevWords.length - n);
    const head = currWords.slice(0, n);
    const matches = tail.every((word, idx) => word.toLowerCase() === head[idx]?.toLowerCase());
    if (matches) return currWords.slice(n).join(" ").trim();
  }

  return curr;
}

/**
 * Stitch overlapping transcripts (one per `SegmentGroup`, in order) into one clean string. Fold left:
 * seed with the first transcript, then for each subsequent transcript append the remainder that
 * `removeOverlapPrefix` leaves after removing the run it shares with the text so far — joined with a
 * single space, and only when that remainder is non-empty. The result is whitespace-normalized (runs of
 * whitespace collapsed to single spaces, trimmed). Empty input yields an empty string.
 */
export function deduplicateOverlappingTranscripts(transcripts: string[]): string {
  if (transcripts.length === 0) return "";

  let accumulated = transcripts[0] ?? "";
  for (let idx = 1; idx < transcripts.length; idx++) {
    const next = transcripts[idx];
    if (next === undefined) continue;
    const remainder = removeOverlapPrefix(accumulated, next);
    if (remainder.length > 0) accumulated += ` ${remainder}`;
  }

  return accumulated.replace(/\s+/g, " ").trim();
}
