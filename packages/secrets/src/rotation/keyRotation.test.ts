// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import type { EncryptionConfig } from "../crypto/envelope";
import { generateKeyB64, isRotationDue, mergeNextKey, pruneOldKeys } from "./keyRotation";

describe("key rotation envelope ops", () => {
  test("generateKeyB64 produces a 32-byte (AES-256) key", async () => {
    expect(atob(await generateKeyB64()).length).toBe(32);
  });

  test("mergeNextKey adds the next version, keeps prior keys, and makes it current", async () => {
    const config: EncryptionConfig = {
      currentVersion: "1",
      versions: { "1": "k1" },
      lastRotatedAt: "2026-01-01T00:00:00.000Z",
    };
    const merged = await mergeNextKey(config, new Date("2026-02-01T00:00:00.000Z"));
    expect(merged.currentVersion).toBe("2");
    expect(Object.keys(merged.versions).sort()).toEqual(["1", "2"]);
    expect(merged.versions["1"]).toBe("k1");
    expect(merged.lastRotatedAt).toBe("2026-02-01T00:00:00.000Z");
  });

  test("pruneOldKeys keeps only the current version", () => {
    const config: EncryptionConfig = {
      currentVersion: "2",
      versions: { "1": "k1", "2": "k2" },
      lastRotatedAt: "2026-02-01T00:00:00.000Z",
    };
    expect(pruneOldKeys(config)).toEqual({
      currentVersion: "2",
      versions: { "2": "k2" },
      lastRotatedAt: "2026-02-01T00:00:00.000Z",
    });
  });

  test("pruneOldKeys returns null when there is nothing to prune", () => {
    const config: EncryptionConfig = {
      currentVersion: "1",
      versions: { "1": "k1" },
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

  test.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["zero", 0],
    ["a negative interval", -30],
  ])("refuses an interval of %s rather than answering it", (_label, intervalDays) => {
    // The cron computes this as `Number(env.ROTATION_INTERVAL_DAYS)`, so `"30 days"` is `NaN` — and
    // `now >= NaN` is false, which means at-rest rotation of the master key never comes due, on every tick,
    // forever, with no error and no line in the log. Zero and a negative are the opposite failure: due on
    // every tick. Neither has a safe number to clamp to.
    expect(() =>
      isRotationDue("2026-01-01T00:00:00.000Z", intervalDays as number, new Date("2027-01-01T00:00:00.000Z")),
    ).toThrowError(/misconfigured/);
  });

  test("a rotation a decade overdue is still answered true once the interval is a number", () => {
    // The half that keeps the cases above about the interval rather than about the dates.
    expect(isRotationDue("2016-01-01T00:00:00.000Z", 30, new Date("2026-01-01T00:00:00.000Z"))).toBe(true);
  });
});
