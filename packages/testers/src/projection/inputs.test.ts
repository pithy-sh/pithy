// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import type { TestersMember } from "../data/member";
import { cohortAgeDays, conversionLatency, median } from "./inputs";

/**
 * These two derivations exist as a shared module because the snapshot builder and the live cohort read
 * both feed them to the same forecast, and each had its own copy. One copy was hardcoded to
 * "no evidence" and the other measured it; one counted UTC days and the other elapsed milliseconds. A
 * developer got two different completion dates for one cohort on one morning depending on whether they
 * read the card or the chart.
 */

/** A member reduced to the two dates these functions read. */
function member(invitedAt: string, optedInAt: string | null): TestersMember {
  return { invitedAt: new Date(invitedAt), optedInAt: optedInAt ? new Date(optedInAt) : null } as TestersMember;
}

describe("conversion latency", () => {
  test("is null with nobody converted, so the forecast falls back to its prior", () => {
    expect(conversionLatency([member("2026-06-01T00:00:00Z", null)])).toEqual({
      medianConversionDays: null,
      conversionSampleSize: 0,
    });
  });

  test("counts whole UTC days, so an evening invite and a small-hours opt-in is one day, not zero", () => {
    // Elapsed milliseconds would floor this to 0 and drag the median toward an instant conversion.
    expect(conversionLatency([member("2026-06-01T23:00:00Z", "2026-06-02T01:00:00Z")])).toEqual({
      medianConversionDays: 1,
      conversionSampleSize: 1,
    });
  });

  test("reports the sample size, because the forecast will not trust a median without one", () => {
    const members = [
      member("2026-06-01T00:00:00Z", "2026-06-03T00:00:00Z"),
      member("2026-06-01T00:00:00Z", "2026-06-10T00:00:00Z"),
      member("2026-06-01T00:00:00Z", null),
    ];
    expect(conversionLatency(members)).toEqual({ medianConversionDays: 6, conversionSampleSize: 2 });
  });

  test("drops a negative span rather than clamping it", () => {
    // An opt-in before its own invitation means the two timestamps disagree. Clamping to zero would let
    // one corrupt row pull the median toward instant conversion; dropping it just shrinks the evidence.
    const members = [
      member("2026-06-10T00:00:00Z", "2026-06-01T00:00:00Z"),
      member("2026-06-01T00:00:00Z", "2026-06-05T00:00:00Z"),
    ];
    expect(conversionLatency(members)).toEqual({ medianConversionDays: 4, conversionSampleSize: 1 });
  });
});

describe("cohort age", () => {
  test("counts UTC day boundaries crossed, not elapsed time", () => {
    // The forecast reads this at a hard threshold — seven days for `high` confidence — so an hour of
    // drift either side of it is a different answer on the wire.
    expect(cohortAgeDays(new Date("2026-06-01T20:00:00Z"), "2026-06-08")).toBe(7);
    // The same instant by elapsed milliseconds is 6d9h, which floors to 6 and fails the gate.
    expect(Math.floor((Date.parse("2026-06-08T05:00:00Z") - Date.parse("2026-06-01T20:00:00Z")) / 86_400_000)).toBe(6);
  });

  test("is zero on the day the cohort is created, whatever hour that was", () => {
    expect(cohortAgeDays(new Date("2026-06-01T23:59:00Z"), "2026-06-01")).toBe(0);
  });

  test("never goes negative, so a clock skew cannot produce a nonsense age", () => {
    expect(cohortAgeDays(new Date("2026-06-10T00:00:00Z"), "2026-06-01")).toBe(0);
  });
});

describe("median", () => {
  test("is null on an empty set", () => {
    expect(median([])).toBeNull();
  });

  test("takes the middle of an odd count", () => {
    expect(median([9, 1, 5])).toBe(5);
  });

  test("rounds the mean of the two middles on an even count", () => {
    expect(median([1, 2, 3, 4])).toBe(3);
  });
});
