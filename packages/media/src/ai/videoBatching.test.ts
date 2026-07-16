import { describe, expect, test } from "vitest";
import {
  type AudioSegment,
  deduplicateOverlappingTranscripts,
  groupSegmentsForTranscription,
  OVERLAP_SEC,
  removeOverlapPrefix,
  TARGET_GROUP_SEC,
} from "./videoBatching";

/** Build a list of `count` segments, each `durationSec` long, with a sequential uri. */
function segments(count: number, durationSec = 1): AudioSegment[] {
  return Array.from({ length: count }, (_, idx) => ({ uri: `seg-${idx}.aac`, durationSec }));
}

describe("groupSegmentsForTranscription", () => {
  test("empty input yields no groups", () => {
    expect(groupSegmentsForTranscription([])).toEqual([]);
  });

  test("a single short segment yields one group", () => {
    const groups = groupSegmentsForTranscription([{ uri: "only.aac", durationSec: 2 }]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.segments).toHaveLength(1);
    expect(groups[0]?.durationSec).toBe(2);
  });

  test("1s segments group into >= target-length units", () => {
    const groups = groupSegmentsForTranscription(segments(90), TARGET_GROUP_SEC, OVERLAP_SEC);
    // Every non-final group reached the target by forward scan.
    for (const group of groups.slice(0, -1)) {
      expect(group.durationSec).toBeGreaterThanOrEqual(TARGET_GROUP_SEC);
    }
    expect(groups.length).toBeGreaterThan(1);
  });

  test("consecutive groups overlap by ~OVERLAP_SEC segments", () => {
    const groups = groupSegmentsForTranscription(segments(90), TARGET_GROUP_SEC, OVERLAP_SEC);
    for (let k = 0; k < groups.length - 1; k++) {
      const prev = groups[k];
      const next = groups[k + 1];
      if (!prev || !next) throw new Error("unexpected missing group");
      const prevUris = new Set(prev.segments.map((s) => s.uri));
      const shared = next.segments.filter((s) => prevUris.has(s.uri));
      // Overlap is at least OVERLAP_SEC seconds' worth of 1s segments, and leaves fresh progress.
      expect(shared.length).toBeGreaterThanOrEqual(OVERLAP_SEC);
      expect(next.segments.length).toBeGreaterThan(shared.length);
    }
  });

  test("forward progress: 100 one-second segments terminate and every segment is covered", () => {
    const input = segments(100);
    const groups = groupSegmentsForTranscription(input);
    const covered = new Set<string>();
    for (const group of groups) {
      for (const seg of group.segments) covered.add(seg.uri);
    }
    expect(covered.size).toBe(100);
    // Each group starts strictly after the previous group's start — no infinite loop.
    expect(groups.length).toBeGreaterThan(0);
  });
});

describe("removeOverlapPrefix", () => {
  test("strips the shared trailing/leading run from curr", () => {
    const result = removeOverlapPrefix("one two three four five six", "three four five six seven eight");
    expect(result).toBe("seven eight");
  });

  test("comparison is case-insensitive, kept words preserve curr casing", () => {
    const result = removeOverlapPrefix("it was The Big End", "the big end START Here now");
    expect(result).toBe("START Here now");
  });

  test("an overlap shorter than minWords is not stripped", () => {
    // "five" is a single shared word — below the 3-word floor, so nothing is removed.
    const result = removeOverlapPrefix("three four five", "five six seven");
    expect(result).toBe("five six seven");
  });

  test("no overlap returns curr unchanged", () => {
    const result = removeOverlapPrefix("alpha beta gamma", "delta epsilon zeta");
    expect(result).toBe("delta epsilon zeta");
  });
});

describe("deduplicateOverlappingTranscripts", () => {
  test("empty input yields an empty string", () => {
    expect(deduplicateOverlappingTranscripts([])).toBe("");
  });

  test("a single element is returned normalized", () => {
    expect(deduplicateOverlappingTranscripts(["  hello   world  "])).toBe("hello world");
  });

  test("removes a duplicated overlap between adjacent transcripts", () => {
    // Overlap "c d e" (three words, the minWords floor) is stripped from the second.
    const result = deduplicateOverlappingTranscripts(["a b c d e", "c d e f g"]);
    expect(result).toBe("a b c d e f g");
  });

  test("skips the join when the remainder is empty", () => {
    // The second is wholly contained in the first's trailing run — nothing to append.
    const result = deduplicateOverlappingTranscripts(["one two three four", "two three four"]);
    expect(result).toBe("one two three four");
  });
});
