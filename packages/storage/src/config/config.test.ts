import { describe, expect, test } from "vitest";
import { DEFAULT_MULTIPART_THRESHOLD_BYTES, DEFAULT_PART_SIZE_BYTES, MAX_UPLOAD_PARTS } from "../object/multipart";
import { maxObjectBytes, StorageConfig } from "./config";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

describe("StorageConfig defaults", () => {
  test("an empty config is valid, private by default, and unlimited", () => {
    const config = StorageConfig.parse({});
    expect(config.quota.bytesPerOwner).toBe(null);
    expect(config.defaultVisibility).toBe("private");
    expect(config.multipartThresholdBytes).toBe(DEFAULT_MULTIPART_THRESHOLD_BYTES);
    expect(config.partSizeBytes).toBe(DEFAULT_PART_SIZE_BYTES);
    expect(config.pendingTtlSeconds).toBe(86_400);
  });

  test("the quota field exists even when it is off, so turning it on is not a breaking change", () => {
    expect("bytesPerOwner" in StorageConfig.parse({}).quota).toBe(true);
    expect(StorageConfig.parse({ quota: { bytesPerOwner: 5 * GIB } }).quota.bytesPerOwner).toBe(5 * GIB);
  });
});

describe("StorageConfig validation", () => {
  test("rejects a part size below S3's 5 MiB floor or above R2's 5 GiB ceiling", () => {
    expect(StorageConfig.safeParse({ partSizeBytes: 4 * MIB }).success).toBe(false);
    expect(StorageConfig.safeParse({ partSizeBytes: 6 * GIB }).success).toBe(false);
  });

  test("rejects a multipart threshold above R2's single-part cap — above it multipart is the only option", () => {
    expect(StorageConfig.safeParse({ multipartThresholdBytes: 5 * GIB, partSizeBytes: 5 * MIB }).success).toBe(false);
  });

  test("rejects a threshold below the part size, which would make every multipart upload one part", () => {
    const result = StorageConfig.safeParse({ multipartThresholdBytes: 10 * MIB, partSizeBytes: 64 * MIB });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/single part/i);
  });

  test("rejects a zero or negative quota", () => {
    expect(StorageConfig.safeParse({ quota: { bytesPerOwner: 0 } }).success).toBe(false);
    expect(StorageConfig.safeParse({ quota: { bytesPerOwner: -1 } }).success).toBe(false);
  });
});

describe("maxObjectBytes", () => {
  test("reports the ~625 GiB ceiling the default part size implies", () => {
    expect(maxObjectBytes(StorageConfig.parse({}))).toBe(625 * GIB);
  });

  test("raising the part size raises the ceiling proportionally", () => {
    const config = StorageConfig.parse({ partSizeBytes: 512 * MIB, multipartThresholdBytes: 512 * MIB });
    expect(maxObjectBytes(config)).toBe(512 * MIB * MAX_UPLOAD_PARTS);
  });
});
