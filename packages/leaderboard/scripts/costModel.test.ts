import { describe, expect, test } from "vitest";
import {
  averageUpsertsPerSecond,
  computeCost,
  DEFAULT_WORKLOAD,
  IMPLIED_UPSERT_CEILING_PER_SECOND,
  monthlyRowsRead,
  monthlyRowsWritten,
  storageGb,
  type Workload,
} from "./costModel";

/**
 * These pin the figures published in `docs/costs.md`. They are not testing arithmetic for its own sake:
 * the issue's requirement is that the cost model is reproducible, so that each release can re-run it and
 * find out whether the docs have gone stale. If a unit price or an assumption changes, these fail — and
 * the docs are wrong until both are updated together.
 */

const at = (players: number): Workload => ({ ...DEFAULT_WORKLOAD, players });
const live = { kind: "live" } as const;
const daily = { kind: "materialize", refreshesPerDay: 1 } as const;
const hourly = { kind: "materialize", refreshesPerDay: 24 } as const;
const dollars = (n: number) => Math.round(n);

describe("the published table", () => {
  test("live rank is free at the scale most adopters actually run", () => {
    expect(dollars(computeCost(at(1_000), live).total)).toBe(0);
    expect(dollars(computeCost(at(10_000), live).total)).toBe(0);
  });

  test("live rank costs $765/mo at 100k players", () => {
    expect(dollars(computeCost(at(100_000), live).total)).toBe(765);
  });

  test("live rank costs $75,825/mo at 1M players — the number that makes materialize the default advice", () => {
    expect(dollars(computeCost(at(1_000_000), live).total)).toBe(75_825);
  });

  test("live rank costs $7,508,925/mo at 10M players", () => {
    expect(dollars(computeCost(at(10_000_000), live).total)).toBe(7_508_925);
  });

  test("materializing daily turns $75,825 into $940 at 1M players (worst case, every submission writes)", () => {
    expect(dollars(computeCost(at(1_000_000), daily).total)).toBe(940);
  });

  test("materializing hourly costs $3,010 at 1M players — the cadence dial, priced", () => {
    expect(dollars(computeCost(at(1_000_000), hourly).total)).toBe(3_010);
  });

  test("materializing costs $49 daily and $256 hourly at 100k players", () => {
    expect(dollars(computeCost(at(100_000), daily).total)).toBe(49);
    expect(dollars(computeCost(at(100_000), hourly).total)).toBe(256);
  });

  test("materializing costs $9,850 daily and $30,550 hourly at 10M players", () => {
    expect(dollars(computeCost(at(10_000_000), daily).total)).toBe(9_850);
    expect(dollars(computeCost(at(10_000_000), hourly).total)).toBe(30_550);
  });
});

describe("the guarded default is the biggest cost lever", () => {
  // trackActivity: false (the default) skips non-improving `best` submissions — 0 rows. The model
  // expresses that as writingSubmissionFraction < 1. The published table uses 1.0 (worst case); a real
  // board writes only for the minority of submissions that improve a player's best.
  const guarded = (players: number, fraction: number) =>
    computeCost({ ...at(players), writingSubmissionFraction: fraction }, daily);

  test("a realistic 20% improve rate cuts 1M-player cost from $940 to ~$220 — near PlayFab territory", () => {
    expect(dollars(guarded(1_000_000, 0.2).total)).toBe(220);
  });

  test("halving the improve rate roughly halves the submission-write term", () => {
    const full = guarded(1_000_000, 1).writeCost;
    const half = guarded(1_000_000, 0.5).writeCost;
    // Not exactly half — the refresh-write term is fixed — but the dominant submission term is.
    expect(half).toBeLessThan(full);
    expect(half).toBeGreaterThan(full * 0.4);
  });

  test("the fraction cannot make an already-free small board cost anything", () => {
    expect(dollars(guarded(10_000, 1).total)).toBe(dollars(guarded(10_000, 0.1).total));
  });
});

describe("what the table is saying", () => {
  test("past 1M players the dominant term is submissions, not the refresh — so cadence tuning stops helping", () => {
    const cost = computeCost(at(10_000_000), daily);
    // $8,950 of the $9,850 is submission writes. No refresh cadence touches that term.
    const submissionsOnly = computeCost(at(10_000_000), live);
    expect(dollars(submissionsOnly.writeCost)).toBe(8_950);
    expect(dollars(cost.total)).toBe(9_850);
  });

  test("live rank grows quadratically: 10x the players is ~100x the read bill", () => {
    const hundredK = computeCost(at(100_000), live).readCost;
    const million = computeCost(at(1_000_000), live).readCost;
    expect(million / hundredK).toBeGreaterThan(90);
  });

  test("materialized rank grows linearly: 10x the players is ~10x the rows read", () => {
    const hundredK = monthlyRowsRead(at(100_000), daily);
    const million = monthlyRowsRead(at(1_000_000), daily);
    expect(million / hundredK).toBeCloseTo(10, 5);
  });

  test("storage never binds — 10M players is 3 GB against a 10 GB cap", () => {
    expect(storageGb(at(10_000_000))).toBeCloseTo(3, 5);
    expect(dollars(computeCost(at(10_000_000), live).storageCost)).toBe(0);
  });

  test("throughput binds before cost does: 1M players already runs at ~87% of the implied write ceiling", () => {
    const rate = averageUpsertsPerSecond(at(1_000_000));
    expect(Math.round(rate)).toBe(174);
    expect(rate / IMPLIED_UPSERT_CEILING_PER_SECOND).toBeGreaterThan(0.85);
  });

  test("10M players is over 8x the implied write ceiling, which no cadence fixes — only sharding", () => {
    expect(averageUpsertsPerSecond(at(10_000_000)) / IMPLIED_UPSERT_CEILING_PER_SECOND).toBeGreaterThan(8);
  });
});

describe("the model's shape", () => {
  test("a live board writes nothing for a refresh it never runs", () => {
    expect(monthlyRowsWritten(at(1_000), live)).toBeLessThan(monthlyRowsWritten(at(1_000), daily));
  });

  test("refreshing more often costs strictly more writes, and the refresh term scales with cadence", () => {
    const dailyWrites = monthlyRowsWritten(at(1_000_000), daily);
    const hourlyWrites = monthlyRowsWritten(at(1_000_000), hourly);
    expect(hourlyWrites).toBeGreaterThan(dailyWrites);
    // The submission term is identical in both; the difference is purely the refresh term, which is 24x
    // as many passes. That difference must equal 23 extra daily-refresh passes' worth of writes.
    const oneRefreshPass = monthlyRowsWritten(at(1_000_000), daily) - monthlyRowsWritten(at(1_000_000), live);
    expect(hourlyWrites - dailyWrites).toBeCloseTo(oneRefreshPass * 23, 5);
  });

  test("a rank check reads one board, not every window — the assumption the live column rests on", () => {
    const oneWindow = monthlyRowsRead({ ...at(100_000), windows: 1 }, live);
    const threeWindows = monthlyRowsRead({ ...at(100_000), windows: 3 }, live);
    expect(threeWindows).toBe(oneWindow);
  });
});
