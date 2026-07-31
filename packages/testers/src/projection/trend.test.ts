// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { computeTrend, type TrendInput, type TrendPoint } from "./trend";

function point(optedIn: number, active = optedIn, probability: number | null = 0.8): TrendPoint {
  return { estimatedOptedInCount: optedIn, activeCount: active, successProbability: probability };
}

const BASE: TrendInput = {
  today: point(12),
  yesterday: point(12),
  weekAgo: point(12),
  snapshotCount: 10,
  atTargetWithNoHeadroom: false,
  weakMemberCount: 0,
  newlyDarkCount: 0,
};

function trend(overrides: Partial<TrendInput> = {}) {
  return computeTrend({ ...BASE, ...overrides });
}

describe("the deltas", () => {
  test("are computed against yesterday and a week back", () => {
    const result = trend({
      today: point(12, 9, 0.72),
      yesterday: point(11, 10, 0.68),
      weekAgo: point(8, 8, 0.5),
    });
    expect(result.optedInDelta1d).toBe(1);
    expect(result.optedInDelta7d).toBe(4);
    expect(result.activeDelta7d).toBe(1);
    expect(result.successProbabilityDelta1d).toBeCloseTo(0.04, 12);
    expect(result.successProbabilityDelta7d).toBeCloseTo(0.22, 12);
  });

  test("are null rather than zero when the history does not exist", () => {
    // Zero would chart as "no change", which is a claim. Null is the absence of one.
    const result = trend({ yesterday: null, weekAgo: null });
    expect(result.optedInDelta1d).toBeNull();
    expect(result.optedInDelta7d).toBeNull();
    expect(result.activeDelta7d).toBeNull();
    expect(result.successProbabilityDelta7d).toBeNull();
  });

  test("a null probability on either end yields a null delta, not a difference against zero", () => {
    // An unobservable cohort has a null forecast. Differencing it against 0.8 would manufacture a
    // catastrophic drop out of the fact that we stopped being able to see anything.
    expect(trend({ today: point(12, 12, null) }).successProbabilityDelta7d).toBeNull();
    expect(trend({ weekAgo: point(12, 12, null) }).successProbabilityDelta7d).toBeNull();
  });
});

describe("the direction rule", () => {
  test("is unknown until three snapshots exist", () => {
    // Two points make a straight line through noise. Saying so beats drawing it.
    const result = trend({ snapshotCount: 2 });
    expect(result.direction).toBe("unknown");
    expect(result.reason).toBe("Not enough history yet.");
  });

  test("losing testers over a week is declining, and the sentence counts them", () => {
    expect(trend({ today: point(10), weekAgo: point(12) }).direction).toBe("declining");
    expect(trend({ today: point(10), weekAgo: point(12) }).reason).toBe("2 testers dropped out this week.");
    expect(trend({ today: point(11), weekAgo: point(12) }).reason).toBe("One tester dropped out this week.");
  });

  test("a forecast that fell materially is declining even with the count unchanged", () => {
    // This is the case worth having: twelve testers all week, three of them now dark for nine days.
    // The count says nothing has happened; the forecast is the only thing that moved.
    const result = trend({
      today: point(12, 8, 0.55),
      weekAgo: point(12, 12, 0.85),
      newlyDarkCount: 3,
    });
    expect(result.direction).toBe("declining");
    expect(result.reason).toBe("3 testers have gone quiet this week.");
  });

  test("a small forecast wobble is not a direction", () => {
    const result = trend({ today: point(12, 12, 0.78), weekAgo: point(12, 12, 0.8) });
    expect(result.direction).toBe("steady");
  });

  test("gaining testers is improving, and the sentence counts them", () => {
    expect(trend({ today: point(12), weekAgo: point(9) }).reason).toBe("3 more opt-ins this week.");
    expect(trend({ today: point(12), weekAgo: point(11) }).reason).toBe("One more opt-in this week.");
    expect(trend({ today: point(12), weekAgo: point(9) }).direction).toBe("improving");
  });

  test("a materially risen forecast is improving even with the count unchanged", () => {
    const result = trend({ today: point(12, 12, 0.9), weekAgo: point(12, 6, 0.6) });
    expect(result.direction).toBe("improving");
    expect(result.reason).toBe("The forecast has risen this week.");
  });

  test("decline is evaluated before improvement, so a mixed week reports the bad news", () => {
    // Two more opt-ins and a collapsed forecast is a cohort in trouble, and reporting it as improving
    // would be the single most misleading arrow this rule could draw.
    const result = trend({ today: point(14, 4, 0.4), weekAgo: point(12, 12, 0.85), newlyDarkCount: 6 });
    expect(result.direction).toBe("declining");
  });
});

describe("fragility, which is not a direction", () => {
  test("at target with no headroom and a weak member is fragile", () => {
    const result = trend({ atTargetWithNoHeadroom: true, weakMemberCount: 1 });
    expect(result.fragile).toBe(true);
    expect(result.reason).toBe("Holding at target. No headroom.");
  });

  test("no headroom but every tester healthy is not fragile", () => {
    expect(trend({ atTargetWithNoHeadroom: true, weakMemberCount: 0 }).fragile).toBe(false);
  });

  test("a weak member with headroom to spare is not fragile", () => {
    expect(trend({ atTargetWithNoHeadroom: false, weakMemberCount: 3 }).fragile).toBe(false);
  });

  test("a cohort can be improving and fragile at once — collapsing them would lose the urgent one", () => {
    const result = trend({
      today: point(12),
      weekAgo: point(9),
      atTargetWithNoHeadroom: true,
      weakMemberCount: 2,
    });
    expect(result.direction).toBe("improving");
    expect(result.fragile).toBe(true);
  });
});

describe("the sentence", () => {
  test("is always present, short, and ends in a period", () => {
    const cases: Partial<TrendInput>[] = [
      {},
      { snapshotCount: 1 },
      { today: point(9), weekAgo: point(12) },
      { today: point(14), weekAgo: point(12) },
      { atTargetWithNoHeadroom: true, weakMemberCount: 1 },
      { today: point(12, 12, 0.4), weekAgo: point(12, 12, 0.9) },
    ];
    for (const override of cases) {
      const { reason } = trend(override);
      expect(reason.length).toBeGreaterThan(0);
      expect(reason.length).toBeLessThan(60);
      expect(reason.endsWith(".")).toBe(true);
    }
  });
});

describe("the first week, before there is a week to compare against", () => {
  /** A cohort on its fourth day: four snapshots, and no snapshot exactly seven days back. */
  function earlyDays(overrides: Partial<TrendInput> = {}): TrendInput {
    return {
      today: { estimatedOptedInCount: 3, activeCount: 2, successProbability: 0.05 },
      yesterday: { estimatedOptedInCount: 12, activeCount: 11, successProbability: 0.9 },
      weekAgo: null,
      snapshotCount: 4,
      atTargetWithNoHeadroom: false,
      weakMemberCount: 0,
      newlyDarkCount: 0,
      ...overrides,
    };
  }

  test("an overnight collapse is reported, not smoothed into `steady`", () => {
    // The window this rule exists to watch is fourteen days. Reading only the weekly delta left it with
    // nothing to read for the first half of it, and the residual branch is a positive claim — so a
    // cohort that lost nine of twelve testers overnight rendered as "Steady this week."
    const trend = computeTrend(earlyDays());
    expect(trend.direction).toBe("declining");
    expect(trend.reason).toBe("9 testers dropped out since yesterday.");
  });

  test("and the sentence says which comparison it made", () => {
    // "this week" on a four-day-old cohort would be a second false claim on top of the first.
    expect(computeTrend(earlyDays()).reason).toContain("since yesterday");
    expect(computeTrend(earlyDays()).reason).not.toContain("this week");
  });

  test("a gain reads the same way round", () => {
    const trend = computeTrend(
      earlyDays({
        today: { estimatedOptedInCount: 12, activeCount: 11, successProbability: 0.9 },
        yesterday: { estimatedOptedInCount: 11, activeCount: 10, successProbability: 0.85 },
      }),
    );
    expect(trend.direction).toBe("improving");
    expect(trend.reason).toBe("One more opt-in since yesterday.");
  });

  test("the week wins whenever there is a week, so the wording does not flap day to day", () => {
    const trend = computeTrend(
      earlyDays({
        weekAgo: { estimatedOptedInCount: 1, activeCount: 1, successProbability: 0.01 },
        snapshotCount: 10,
      }),
    );
    expect(trend.reason).toContain("this week");
  });

  test("with neither comparison available the direction is unknown, not steady", () => {
    // The deltas go null so that absent data never charts as "no change". The direction has to obey the
    // same rule, or the sentence beside the arrow makes the claim the number refused to.
    const trend = computeTrend(earlyDays({ yesterday: null, weekAgo: null }));
    expect(trend.direction).toBe("unknown");
    expect(trend.reason).toBe("Not enough history yet.");
  });
});

describe("the dark-tester sentence is not a windowed claim", () => {
  test("it never says `since yesterday`, because nobody goes dark in a day", () => {
    // `newlyDark` counts testers whose darkness is currently between three and seven days, measured
    // against now alone. On a cohort young enough to take the daily window, "since yesterday" would be
    // false by construction — and the sentence is persisted and rendered verbatim beside the arrow.
    const trend = computeTrend({
      today: { estimatedOptedInCount: 12, activeCount: 8, successProbability: 0.4 },
      yesterday: { estimatedOptedInCount: 12, activeCount: 11, successProbability: 0.9 },
      weekAgo: null,
      snapshotCount: 5,
      atTargetWithNoHeadroom: false,
      weakMemberCount: 2,
      newlyDarkCount: 2,
    });
    expect(trend.direction).toBe("declining");
    expect(trend.reason).toBe("2 testers have gone quiet this week.");
    expect(trend.reason).not.toContain("since yesterday");
  });
});
