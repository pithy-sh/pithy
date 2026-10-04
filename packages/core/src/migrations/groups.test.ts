// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { generatedMigrationGroup } from "./groups";

describe("generatedMigrationGroup", () => {
  test("is an ISO-8601 timestamp to the millisecond, so one busy day is not one group", () => {
    const group = generatedMigrationGroup(new Date("2026-10-03T19:52:47.611Z"));
    expect(group).toBe("2026-10-03T19:52:47.611Z");
  });

  test("two runs a millisecond apart are two groups", () => {
    const first = generatedMigrationGroup(new Date(1_770_000_000_000));
    const second = generatedMigrationGroup(new Date(1_770_000_000_001));
    expect(first).not.toBe(second);
    // Lexicographic order is chronological order — what makes the newest group readable in a listing.
    expect([second, first].sort()).toEqual([first, second]);
  });

  test("defaults to now", () => {
    const before = Date.now();
    const group = generatedMigrationGroup();
    expect(Date.parse(group)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(group)).toBeLessThanOrEqual(Date.now());
  });
});
