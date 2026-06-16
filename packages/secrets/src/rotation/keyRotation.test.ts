import { describe, expect, test } from "vitest";
import type { EncryptionConfig } from "../crypto/envelope";
import { generateKeyB64, isRotationDue, mergeNextKey, pruneOldKeys } from "./keyRotation";

describe("key rotation envelope ops", () => {
  test("generateKeyB64 produces a 32-byte (AES-256) key", async () => {
    expect(atob(await generateKeyB64()).length).toBe(32);
  });

  test("mergeNextKey adds the next version, keeps prior keys, and makes it current", async () => {
    const config: EncryptionConfig = {
      currentVersion: 1,
      keys: { "1": "k1" },
      lastRotatedAt: "2026-01-01T00:00:00.000Z",
    };
    const merged = await mergeNextKey(config, new Date("2026-02-01T00:00:00.000Z"));
    expect(merged.currentVersion).toBe(2);
    expect(Object.keys(merged.keys).sort()).toEqual(["1", "2"]);
    expect(merged.keys["1"]).toBe("k1");
    expect(merged.lastRotatedAt).toBe("2026-02-01T00:00:00.000Z");
  });

  test("pruneOldKeys keeps only the current version", () => {
    const config: EncryptionConfig = {
      currentVersion: 2,
      keys: { "1": "k1", "2": "k2" },
      lastRotatedAt: "2026-02-01T00:00:00.000Z",
    };
    expect(pruneOldKeys(config)).toEqual({
      currentVersion: 2,
      keys: { "2": "k2" },
      lastRotatedAt: "2026-02-01T00:00:00.000Z",
    });
  });

  test("pruneOldKeys returns null when there is nothing to prune", () => {
    const config: EncryptionConfig = {
      currentVersion: 1,
      keys: { "1": "k1" },
      lastRotatedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(pruneOldKeys(config)).toBeNull();
  });
});

describe("isRotationDue", () => {
  test("is due once the interval has elapsed since the last rotation", () => {
    expect(isRotationDue("2026-01-01T00:00:00.000Z", 30, new Date("2026-02-15T00:00:00.000Z"))).toBe(true);
  });

  test("is not due before the interval elapses", () => {
    expect(isRotationDue("2026-01-01T00:00:00.000Z", 30, new Date("2026-01-15T00:00:00.000Z"))).toBe(false);
  });
});
