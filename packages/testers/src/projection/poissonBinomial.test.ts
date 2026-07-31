// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { expectedSurvivors, probabilityAtLeast, survivalOverDays, survivorDistribution } from "./poissonBinomial";

describe("the survivor distribution", () => {
  test("an empty roster has exactly one outcome: nobody survives", () => {
    expect(survivorDistribution([])).toEqual([1]);
  });

  test("a single tester splits the mass between the two things that can happen", () => {
    expect(survivorDistribution([0.9])).toEqual([expect.closeTo(0.1, 12), expect.closeTo(0.9, 12)]);
  });

  test("identical probabilities reproduce the binomial exactly", () => {
    // Three fair coins: 1/8, 3/8, 3/8, 1/8. If the DP disagreed with the closed form on the one case
    // that has one, nothing else it produced would be worth reading.
    const distribution = survivorDistribution([0.5, 0.5, 0.5]);
    expect(distribution).toEqual([
      expect.closeTo(0.125, 12),
      expect.closeTo(0.375, 12),
      expect.closeTo(0.375, 12),
      expect.closeTo(0.125, 12),
    ]);
  });

  test("heterogeneous probabilities match the hand-computed expansion", () => {
    // p = [0.9, 0.5, 0.2]. P(0) = 0.1·0.5·0.8 = 0.04.
    // P(3) = 0.9·0.5·0.2 = 0.09.
    const distribution = survivorDistribution([0.9, 0.5, 0.2]);
    expect(distribution[0]).toBeCloseTo(0.04, 12);
    expect(distribution[3]).toBeCloseTo(0.09, 12);
    expect(distribution.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 12);
  });

  test("the distribution always sums to one, even across a hundred testers", () => {
    const probabilities = Array.from({ length: 100 }, (_, index) => 0.5 + index / 400);
    const total = survivorDistribution(probabilities).reduce((sum, value) => sum + value, 0);
    expect(total).toBeCloseTo(1, 10);
  });
});

describe("the at-least-k tail", () => {
  test("three testers at 0.9 give a 0.972 chance that at least two hold", () => {
    // The hand-computed case from the design: 3·0.9²·0.1 + 0.9³ = 0.243 + 0.729 = 0.972.
    expect(probabilityAtLeast([0.9, 0.9, 0.9], 2)).toBeCloseTo(0.972, 12);
  });

  test("needing none of them is certain, whatever the roster", () => {
    expect(probabilityAtLeast([0.1, 0.1], 0)).toBe(1);
    expect(probabilityAtLeast([], 0)).toBe(1);
  });

  test("needing more testers than exist is impossible, not merely unlikely", () => {
    // The realistic failure this guards: a cohort of eight people trying to hold twelve. The honest
    // answer is zero, and it must be zero rather than a small positive number a dashboard rounds up.
    expect(probabilityAtLeast([0.99, 0.99, 0.99], 12)).toBe(0);
    expect(probabilityAtLeast([], 1)).toBe(0);
  });

  test("needing every tester is the product of their probabilities", () => {
    expect(probabilityAtLeast([0.9, 0.8, 0.7], 3)).toBeCloseTo(0.504, 12);
  });

  test("a certain tester is certain, and an impossible one is impossible", () => {
    expect(probabilityAtLeast([1, 1, 1], 3)).toBe(1);
    expect(probabilityAtLeast([0, 0, 0], 1)).toBe(0);
  });

  test("the answer never escapes [0,1] under floating-point accumulation", () => {
    const probabilities = Array.from({ length: 100 }, () => 0.999);
    const result = probabilityAtLeast(probabilities, 1);
    expect(result).toBeLessThanOrEqual(1);
    expect(result).toBeGreaterThanOrEqual(0);
  });

  test("a twelve-of-fourteen cohort of healthy testers is likely but never certain", () => {
    // The shape of a real reading: fourteen healthy testers, fourteen days to hold.
    const daily = 0.998;
    const probabilities = Array.from({ length: 14 }, () => survivalOverDays(daily, 14));
    const result = probabilityAtLeast(probabilities, 12);
    expect(result).toBeGreaterThan(0.99);
    expect(result).toBeLessThan(1);
  });

  test("one critical tester in a zero-headroom cohort visibly costs the forecast", () => {
    // Twelve of twelve means every single one has to hold, so the weakest link is the whole story —
    // which is exactly why the snapshot records the minimum health rather than only the median.
    const healthy = Array.from({ length: 12 }, () => survivalOverDays(0.998, 14));
    const withOneCritical = [...healthy.slice(1), survivalOverDays(0.93, 14)];
    expect(probabilityAtLeast(withOneCritical, 12)).toBeLessThan(probabilityAtLeast(healthy, 12) / 2);
  });
});

describe("expected survivors", () => {
  test("is the plain sum of the probabilities", () => {
    expect(expectedSurvivors([0.9, 0.8, 0.7])).toBeCloseTo(2.4, 12);
    expect(expectedSurvivors([])).toBe(0);
  });
});

describe("survival over days", () => {
  test("compounds the daily rate", () => {
    expect(survivalOverDays(0.99, 2)).toBeCloseTo(0.9801, 12);
  });

  test("a window with no days left is survived with certainty", () => {
    // The day the window completes, there is nothing further to hold — reporting anything less would
    // tell a developer who has finished that they might still fail.
    expect(survivalOverDays(0.5, 0)).toBe(1);
    expect(survivalOverDays(0.5, -3)).toBe(1);
  });

  test("the published fourteen-day figures match the survival table in the docs", () => {
    expect(survivalOverDays(0.998, 14)).toBeCloseTo(0.972, 3);
    expect(survivalOverDays(0.99, 14)).toBeCloseTo(0.869, 3);
    expect(survivalOverDays(0.97, 14)).toBeCloseTo(0.653, 3);
    expect(survivalOverDays(0.93, 14)).toBeCloseTo(0.362, 3);
  });
});
