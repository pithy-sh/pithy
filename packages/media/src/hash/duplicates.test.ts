// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import type { HashMatch, HashPhashEntry, HashStore } from "../record/hashStore";
import { classifyDistance, findDuplicates, hammingDistance, SIMILAR_THRESHOLD } from "./duplicates";

/**
 * An in-memory {@link HashStore} for the dedup scan. Only `findBySha256` and `listImagePhashes` need real
 * behavior — the scan touches nothing else — so the writes throw to catch an unexpected call.
 */
function fakeHashes(seed: { matches?: HashMatch[]; phashes?: HashPhashEntry[] } = {}): HashStore {
  const matches = seed.matches ?? [];
  const phashes = seed.phashes ?? [];
  const unused = (name: string) => (): never => {
    throw new Error(`unexpected call: ${name}`);
  };
  return {
    findBySha256: async () => matches,
    listImagePhashes: async () => phashes,
    upsert: unused("upsert"),
    deleteByMedia: unused("deleteByMedia"),
  };
}

describe("classifyDistance", () => {
  test("0 is identical", () => {
    expect(classifyDistance(0)).toBe("identical");
  });

  test("a distance at the threshold is similar", () => {
    expect(classifyDistance(SIMILAR_THRESHOLD)).toBe("similar");
  });

  test("a distance past the threshold is different", () => {
    expect(classifyDistance(SIMILAR_THRESHOLD + 1)).toBe("different");
  });
});

describe("hammingDistance", () => {
  test("counts one differing position", () => {
    expect(hammingDistance("aaaa", "aaab")).toBe(1);
  });

  test("equal strings are distance 0", () => {
    expect(hammingDistance("abcd", "abcd")).toBe(0);
  });

  test("throws on a length mismatch", () => {
    expect(() => hammingDistance("aaa", "aaaa")).toThrow(/equal length/);
  });
});

describe("findDuplicates", () => {
  test("an exact SHA-256 match returns an identical candidate at distance 0", async () => {
    const hashes = fakeHashes({ matches: [{ mediaId: "doc-1", mediaType: "document" }] });
    const found = await findDuplicates(hashes, { sha256: "deadbeef", type: "document" });
    expect(found).toEqual([{ id: "doc-1", mediaType: "document", distance: 0, kind: "identical" }]);
  });

  test("an image phash within threshold returns a similar candidate", async () => {
    const hashes = fakeHashes({ phashes: [{ mediaId: "img-near", phash: "ffff0001" }] });
    const found = await findDuplicates(hashes, { sha256: "nomatch", phash: "ffff0000", type: "image" });
    expect(found).toEqual([{ id: "img-near", mediaType: "image", distance: 1, kind: "similar" }]);
  });

  test("an exact match is not double-counted as a near match", async () => {
    const hashes = fakeHashes({
      matches: [{ mediaId: "img-1", mediaType: "image" }],
      phashes: [{ mediaId: "img-1", phash: "ffff0000" }],
    });
    const found = await findDuplicates(hashes, { sha256: "abc123", phash: "ffff0000", type: "image" });
    expect(found).toEqual([{ id: "img-1", mediaType: "image", distance: 0, kind: "identical" }]);
  });

  test("a non-image type never runs the phash scan", async () => {
    let scanned = false;
    const hashes: HashStore = {
      ...fakeHashes(),
      listImagePhashes: async () => {
        scanned = true;
        return [];
      },
    };
    const found = await findDuplicates(hashes, { sha256: "nomatch", phash: "ffff0000", type: "video" });
    expect(scanned).toBe(false);
    expect(found).toEqual([]);
  });

  test("results are sorted closest first and capped to the limit", async () => {
    const hashes = fakeHashes({
      matches: [{ mediaId: "exact", mediaType: "image" }],
      phashes: [
        { mediaId: "far", phash: "fffffff0" },
        { mediaId: "close", phash: "ffff0001" },
      ],
    });
    const found = await findDuplicates(hashes, {
      sha256: "same",
      phash: "ffff0000",
      type: "image",
      threshold: 5,
      limit: 2,
    });
    expect(found.map((candidate) => candidate.id)).toEqual(["exact", "close"]);
    expect(found).toHaveLength(2);
  });

  test("phashes of a different length are skipped", async () => {
    const hashes = fakeHashes({ phashes: [{ mediaId: "wrong-len", phash: "ffff" }] });
    const found = await findDuplicates(hashes, { sha256: "nomatch", phash: "ffff0000", type: "image" });
    expect(found).toEqual([]);
  });
});
