import { describe, expect, test } from "vitest";
import type { MediaRecord, PhashEntry, RecordStore } from "../record/store";
import { classifyDistance, findDuplicates, hammingDistance, SIMILAR_THRESHOLD } from "./duplicates";

/**
 * An in-memory {@link RecordStore} for the dedup scan. Only `findBySha256` and `listImagePhashes` need
 * real behavior — the scan touches nothing else — so the rest throw to catch an unexpected call.
 */
function fakeStore(seed: { records?: MediaRecord[]; phashes?: PhashEntry[] } = {}): RecordStore {
  const records = seed.records ?? [];
  const phashes = seed.phashes ?? [];
  const unused = (name: string) => (): never => {
    throw new Error(`unexpected call: ${name}`);
  };
  return {
    findBySha256: async (sha256) => records.filter((record) => record.sha256 === sha256),
    listImagePhashes: async () => phashes,
    create: unused("create"),
    get: unused("get"),
    patch: unused("patch"),
    delete: unused("delete"),
    list: unused("list"),
  };
}

/** Build a minimal `MediaRecord` — only the fields the dedup scan reads matter here. */
function record(fields: { id: string; sha256: string; type: MediaRecord["type"] }): MediaRecord {
  return { id: fields.id, sha256: fields.sha256, type: fields.type } as MediaRecord;
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
    const store = fakeStore({
      records: [record({ id: "doc-1", sha256: "deadbeef", type: "document" })],
    });
    const found = await findDuplicates(store, { sha256: "deadbeef", type: "document" });
    expect(found).toEqual([{ id: "doc-1", mediaType: "document", distance: 0, kind: "identical" }]);
  });

  test("an image phash within threshold returns a similar candidate", async () => {
    const store = fakeStore({
      phashes: [{ id: "img-near", phash: "ffff0001" }],
    });
    const found = await findDuplicates(store, {
      sha256: "nomatch",
      phash: "ffff0000",
      type: "image",
    });
    expect(found).toEqual([{ id: "img-near", mediaType: "image", distance: 1, kind: "similar" }]);
  });

  test("an exact match is not double-counted as a near match", async () => {
    const store = fakeStore({
      records: [record({ id: "img-1", sha256: "abc123", type: "image" })],
      phashes: [{ id: "img-1", phash: "ffff0000" }],
    });
    const found = await findDuplicates(store, {
      sha256: "abc123",
      phash: "ffff0000",
      type: "image",
    });
    expect(found).toEqual([{ id: "img-1", mediaType: "image", distance: 0, kind: "identical" }]);
  });

  test("a non-image type never runs the phash scan", async () => {
    let scanned = false;
    const store = fakeStore({ phashes: [{ id: "img-x", phash: "ffff0000" }] });
    const wrapped: RecordStore = {
      ...store,
      listImagePhashes: async () => {
        scanned = true;
        return [];
      },
    };
    const found = await findDuplicates(wrapped, {
      sha256: "nomatch",
      phash: "ffff0000",
      type: "video",
    });
    expect(scanned).toBe(false);
    expect(found).toEqual([]);
  });

  test("results are sorted closest first and capped to the limit", async () => {
    const store = fakeStore({
      records: [record({ id: "exact", sha256: "same", type: "image" })],
      phashes: [
        { id: "far", phash: "fffffff0" },
        { id: "close", phash: "ffff0001" },
      ],
    });
    const found = await findDuplicates(store, {
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
    const store = fakeStore({
      phashes: [{ id: "wrong-len", phash: "ffff" }],
    });
    const found = await findDuplicates(store, {
      sha256: "nomatch",
      phash: "ffff0000",
      type: "image",
    });
    expect(found).toEqual([]);
  });
});
