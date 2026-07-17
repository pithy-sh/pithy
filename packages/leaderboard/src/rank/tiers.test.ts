import { describe, expect, it } from "vitest";
import { classifyTier } from "./tiers";

const descTiers = [
  { key: "bronze", from: 0 },
  { key: "silver", from: 100 },
  { key: "gold", from: 1000 },
];

describe("classifyTier", () => {
  it("returns null when the board configures no tiers", () => {
    expect(classifyTier(undefined, "desc", 500)).toBeNull();
    expect(classifyTier([], "desc", 500)).toBeNull();
  });

  it("returns the best tier a desc score reaches", () => {
    expect(classifyTier(descTiers, "desc", 500)).toBe("silver");
    expect(classifyTier(descTiers, "desc", 5000)).toBe("gold");
  });

  it("treats a threshold as inclusive — the score that reaches it is in it", () => {
    expect(classifyTier(descTiers, "desc", 1000)).toBe("gold");
  });

  it("returns null for a desc score below every threshold", () => {
    expect(classifyTier([{ key: "gold", from: 100 }], "desc", 99)).toBeNull();
  });

  it("reads thresholds in the asc direction, where a lower score is better", () => {
    const ascTiers = [
      { key: "bronze", from: 1000 },
      { key: "silver", from: 100 },
      { key: "gold", from: 10 },
    ];
    expect(classifyTier(ascTiers, "asc", 50)).toBe("silver");
    expect(classifyTier(ascTiers, "asc", 5)).toBe("gold");
    expect(classifyTier(ascTiers, "asc", 5000)).toBeNull();
  });
});
