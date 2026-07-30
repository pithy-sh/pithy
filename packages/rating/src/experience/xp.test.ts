// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import type { RatingLevel } from "../config/config";
import { awardXp, classifyLevel, xpFor } from "./xp";

describe("awardXp", () => {
  test("adds a positive award to the running total", () => {
    expect(awardXp(100, 20)).toBe(120);
  });

  test("never decreases — a negative award is clamped to zero", () => {
    expect(awardXp(100, -50)).toBe(100);
  });

  test("a zero award is a no-op", () => {
    expect(awardXp(0, 0)).toBe(0);
  });
});

describe("xpFor", () => {
  const award = { win: 20, draw: 10, loss: 5 };
  test("maps each outcome to its award", () => {
    expect(xpFor(award, "win")).toBe(20);
    expect(xpFor(award, "draw")).toBe(10);
    expect(xpFor(award, "loss")).toBe(5);
  });
});

describe("classifyLevel", () => {
  const levels: RatingLevel[] = [
    { key: "bronze", from: 0 },
    { key: "silver", from: 100 },
    { key: "gold", from: 500 },
  ];

  test("returns the best rung the total has reached", () => {
    expect(classifyLevel(levels, 0)).toBe("bronze");
    expect(classifyLevel(levels, 250)).toBe("silver");
    expect(classifyLevel(levels, 900)).toBe("gold");
  });

  test("returns null below the first rung", () => {
    expect(classifyLevel([{ key: "silver", from: 100 }], 50)).toBeNull();
  });

  test("is order-independent — an unsorted ladder classifies the same", () => {
    const unsorted: RatingLevel[] = [
      { key: "gold", from: 500 },
      { key: "bronze", from: 0 },
      { key: "silver", from: 100 },
    ];
    expect(classifyLevel(unsorted, 250)).toBe("silver");
  });
});
