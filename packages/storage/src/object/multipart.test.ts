import { describe, expect, test } from "vitest";
import {
  collectParts,
  DEFAULT_MULTIPART_THRESHOLD_BYTES,
  DEFAULT_PART_SIZE_BYTES,
  MAX_UPLOAD_PARTS,
  MIN_PART_SIZE_BYTES,
  needsMultipart,
  planMultipart,
} from "./multipart";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

describe("needsMultipart", () => {
  test("splits at the threshold — equal to it is a single PUT, one byte over is not", () => {
    expect(needsMultipart(DEFAULT_MULTIPART_THRESHOLD_BYTES)).toBe(false);
    expect(needsMultipart(DEFAULT_MULTIPART_THRESHOLD_BYTES + 1)).toBe(true);
  });
});

describe("planMultipart", () => {
  test("splits into full parts plus a short final one, contiguous from part 1", () => {
    const plan = planMultipart(150 * MIB, 64 * MIB);
    expect(plan.partCount).toBe(3);
    expect(plan.parts.map((p) => p.partNumber)).toEqual([1, 2, 3]);
    expect(plan.parts.map((p) => p.length)).toEqual([64 * MIB, 64 * MIB, 22 * MIB]);
    expect(plan.parts.map((p) => p.offset)).toEqual([0, 64 * MIB, 128 * MIB]);
  });

  test("covers the object exactly — offsets and lengths sum to the size with no gap or overlap", () => {
    const size = 700 * MIB + 12345;
    const plan = planMultipart(size, 64 * MIB);
    expect(plan.parts.reduce((total, part) => total + part.length, 0)).toBe(size);
    for (const [index, part] of plan.parts.entries()) {
      expect(part.offset).toBe(
        index === 0 ? 0 : (plan.parts[index - 1]?.offset ?? 0) + (plan.parts[index - 1]?.length ?? 0),
      );
    }
  });

  test("an object smaller than one part is a single short part — only the last part may be short", () => {
    const plan = planMultipart(1024, 64 * MIB);
    expect(plan.partCount).toBe(1);
    expect(plan.parts[0]).toEqual({ partNumber: 1, offset: 0, length: 1024 });
  });

  test("rejects a part size below S3's 5 MiB floor for non-final parts", () => {
    expect(() => planMultipart(100 * MIB, MIN_PART_SIZE_BYTES - 1)).toThrowError(/part size/i);
  });

  test("rejects a part size above R2's 5 GiB per-part ceiling", () => {
    expect(() => planMultipart(100 * GIB, 6 * GIB)).toThrowError(/part size/i);
  });

  test("refuses a plan that would need more than R2's 10,000 parts", () => {
    const size = DEFAULT_PART_SIZE_BYTES * MAX_UPLOAD_PARTS + 1;
    expect(() => planMultipart(size, DEFAULT_PART_SIZE_BYTES)).toThrowError(/too large/i);
  });

  test("the documented ~625 GiB ceiling at the default part size is exactly reachable", () => {
    const ceiling = DEFAULT_PART_SIZE_BYTES * MAX_UPLOAD_PARTS;
    expect(planMultipart(ceiling, DEFAULT_PART_SIZE_BYTES).partCount).toBe(MAX_UPLOAD_PARTS);
    expect(ceiling).toBe(625 * GIB);
  });

  test("rejects a zero or fractional size", () => {
    expect(() => planMultipart(0)).toThrowError(/positive size/i);
    expect(() => planMultipart(1.5)).toThrowError(/positive size/i);
  });
});

describe("collectParts", () => {
  const reported = [
    { partNumber: 3, etag: "c" },
    { partNumber: 1, etag: "a" },
    { partNumber: 2, etag: "b" },
  ];

  test("sorts ascending — S3 rejects an out-of-order list, and PUTs finish in any order", () => {
    expect(collectParts(reported, 3)).toEqual([
      { partNumber: 1, etag: "a" },
      { partNumber: 2, etag: "b" },
      { partNumber: 3, etag: "c" },
    ]);
  });

  test("tolerates a part reported twice with the same etag — a retried PUT is not an error", () => {
    expect(collectParts([...reported, { partNumber: 2, etag: "b" }], 3)).toHaveLength(3);
  });

  test("refuses a part reported twice with different etags", () => {
    expect(() => collectParts([...reported, { partNumber: 2, etag: "different" }], 3)).toThrowError(/inconsistent/i);
  });

  test("refuses a gap rather than sending it to R2, whose rejection carries nothing actionable", () => {
    expect(() => collectParts([reported[0] as never, reported[1] as never], 3)).toThrowError(/missing parts/i);
  });

  test("refuses a part list longer than the plan", () => {
    expect(() => collectParts([...reported, { partNumber: 4, etag: "d" }], 3)).toThrowError(/missing parts/i);
  });

  test("refuses an empty etag", () => {
    expect(() => collectParts([{ partNumber: 1, etag: "" }], 1)).toThrowError(/could not be assembled/i);
  });
});
