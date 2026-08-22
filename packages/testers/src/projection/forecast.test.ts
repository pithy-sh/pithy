// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { conversionRate, type ForecastInput, type ForecastMember, forecastCohort } from "./forecast";

/** `count` opted-in testers, all in one band. */
function members(count: number, dailySurvival = 0.998, observable = true): ForecastMember[] {
  return Array.from({ length: count }, () => ({
    riskBand: observable ? ("healthy" as const) : ("unknown" as const),
    observability: observable ? ("observed" as const) : ("unobservable" as const),
    dailySurvival,
  }));
}

const BASE: ForecastInput = {
  today: "2026-06-10",
  targetSize: 12,
  optedInCount: 12,
  daysRemaining: 7,
  members: members(12),
  pipeline: [],
  optedInEver: 12,
  invitedEver: 20,
  medianConversionDays: 2,
  conversionSampleSize: 12,
  cohortAgeDays: 7,
  maxRosterSize: 100,
};

function forecast(overrides: Partial<ForecastInput> = {}) {
  return forecastCohort({ ...BASE, ...overrides });
}

describe("the conversion rate", () => {
  test("is Laplace-smoothed, so one-for-one does not read as certainty", () => {
    // Untouched, a first invitee who confirmed reads as a 100% conversion rate and tells a developer
    // to invite exactly twelve people — the advice most likely to leave them at eleven on day fourteen.
    expect(conversionRate(1, 1)).toBeCloseTo(2 / 3, 12);
    expect(conversionRate(0, 0)).toBeCloseTo(0.5, 12);
  });

  test("converges on the true rate as evidence accumulates", () => {
    expect(conversionRate(50, 100)).toBeCloseTo(0.5, 2);
    expect(conversionRate(500, 1000)).toBeCloseTo(0.5, 3);
  });
});

describe("a cohort already at target", () => {
  test("reaching is certain, and the projection is about holding", () => {
    const result = forecast();
    expect(result.probabilityReachTarget).toBe(1);
    expect(result.projectedTargetMetOn).toBe("2026-06-10");
    expect(result.basis).toBe("estimated");
    expect(result.invitesNeeded).toBe(0);
  });

  test("never reports certainty, however healthy the roster", () => {
    // Twenty healthy testers holding twelve for one more day is as close to a sure thing as this model
    // can produce, and it still must not say 1.0 — Google's is the number that decides, and we cannot
    // read it.
    const result = forecast({ members: members(20), daysRemaining: 1 });
    expect(result.successProbability).toBeLessThanOrEqual(0.99);
    expect(result.successProbability).toBeGreaterThan(0.9);
  });

  test("zero headroom is visibly more fragile than a spare tester", () => {
    const exact = forecast({ members: members(12), optedInCount: 12 });
    const spare = forecast({ members: members(14), optedInCount: 14 });
    expect(spare.probabilityHoldWindow as number).toBeGreaterThan(exact.probabilityHoldWindow as number);
  });

  test("a completed window reports target_met rather than forecasting a day that has passed", () => {
    const result = forecast({ daysRemaining: 0 });
    expect(result.basis).toBe("target_met");
    expect(result.probabilityHoldWindow).toBe(1);
  });
});

describe("a cohort short of target", () => {
  test("the pipeline drives the chance of reaching it", () => {
    const result = forecast({
      optedInCount: 9,
      members: members(9),
      pipeline: Array.from({ length: 8 }, () => ({ stage: "accepted" as const, unreachable: false })),
    });
    expect(result.probabilityReachTarget).toBeGreaterThan(0);
    expect(result.probabilityReachTarget).toBeLessThan(1);
  });

  test("an accepted tester counts for more than a merely invited one", () => {
    // Someone who signed in with the invited address has opened the email, installed, and
    // authenticated. Treating them identically to someone who never opened the email would make the
    // estimate uselessly pessimistic for exactly the cohorts that are going well.
    const shape = { optedInCount: 10, members: members(10) };
    const accepted = forecast({
      ...shape,
      pipeline: Array.from({ length: 3 }, () => ({ stage: "accepted" as const, unreachable: false })),
    });
    const invited = forecast({
      ...shape,
      pipeline: Array.from({ length: 3 }, () => ({ stage: "invited" as const, unreachable: false })),
    });
    expect(accepted.probabilityReachTarget).toBeGreaterThan(invited.probabilityReachTarget);
  });

  test("an unreachable invitee contributes nothing — we cannot even chase them", () => {
    const result = forecast({
      optedInCount: 11,
      members: members(11),
      pipeline: [{ stage: "invited", unreachable: true }],
    });
    expect(result.probabilityReachTarget).toBe(0);
    expect(result.basis).toBe("insufficient_pipeline");
  });

  test("an empty pipeline short of target is insufficient, with a null projected date", () => {
    // Reporting a date here would be inventing one. The actionable answer is `invitesNeeded`.
    const result = forecast({ optedInCount: 8, members: members(8), pipeline: [] });
    expect(result.basis).toBe("insufficient_pipeline");
    expect(result.projectedTargetMetOn).toBeNull();
    expect(result.projectedCompleteOn).toBeNull();
    expect(result.invitesNeeded).toBeGreaterThan(0);
  });

  test("invitesNeeded accounts for the conversion rate, not just the raw gap", () => {
    // Four short at a 50% conversion rate is eight invitations, not four. Telling a developer to
    // invite four is the single most expensive rounding error this package could make.
    const result = forecast({
      optedInCount: 8,
      members: members(8),
      pipeline: [],
      optedInEver: 8,
      invitedEver: 16,
    });
    expect(result.invitesNeeded).toBeGreaterThanOrEqual(8);
  });

  test("the projected date uses the cohort's own latency once it has enough conversions", () => {
    const observed = forecast({
      optedInCount: 11,
      members: members(11),
      pipeline: Array.from({ length: 5 }, () => ({ stage: "accepted" as const, unreachable: false })),
      medianConversionDays: 6,
      conversionSampleSize: 11,
    });
    expect(observed.projectedTargetMetOn).toBe("2026-06-16");
  });

  test("a thin sample falls back to the stated prior rather than trusting two data points", () => {
    const thin = forecast({
      optedInCount: 11,
      members: members(11),
      pipeline: Array.from({ length: 5 }, () => ({ stage: "accepted" as const, unreachable: false })),
      medianConversionDays: 9,
      conversionSampleSize: 2,
    });
    expect(thin.projectedTargetMetOn).toBe("2026-06-13"); // the 3-day prior, not the 9-day sample
  });
});

describe("degrading honestly when we cannot see the cohort", () => {
  test("zero coverage returns a null forecast with a stated basis, never a plausible number", () => {
    // The normal case for an app whose test flow requires no sign-in. A 0.5 here would be read as a
    // real answer, and it would be the most damaging single number this package could emit.
    const result = forecast({ members: members(12, 0.985, false) });
    expect(result.observedCoverage).toBe(0);
    expect(result.successProbability).toBeNull();
    expect(result.probabilityHoldWindow).toBeNull();
    expect(result.confidence).toBeNull();
    expect(result.basis).toBe("no_observable_signal");
    // The reach half is still real — it comes from invite records, which we always have.
    expect(result.probabilityReachTarget).toBe(1);
  });

  test("the band widens exactly in proportion to how blind we are", () => {
    const fullyObserved = forecast({ members: members(12) });
    const halfObserved = forecast({ members: [...members(6), ...members(6, 0.985, false)] });
    const seen = (fullyObserved.successProbabilityHigh as number) - (fullyObserved.successProbabilityLow as number);
    const partly = (halfObserved.successProbabilityHigh as number) - (halfObserved.successProbabilityLow as number);
    expect(partly).toBeGreaterThan(seen);
    expect(halfObserved.observedCoverage).toBeCloseTo(0.5, 12);
  });

  test("the low bound is never above the high bound", () => {
    for (const unobserved of [0, 3, 6, 9, 12]) {
      const result = forecast({
        members: [...members(12 - unobserved), ...members(unobserved, 0.985, false)],
      });
      if (result.successProbabilityLow === null || result.successProbabilityHigh === null) continue;
      expect(result.successProbabilityLow).toBeLessThanOrEqual(result.successProbabilityHigh);
    }
  });

  test("confidence tracks coverage and age, and a young cohort cannot be high however visible", () => {
    expect(forecast({ cohortAgeDays: 14 }).confidence).toBe("high");
    expect(forecast({ cohortAgeDays: 2 }).confidence).toBe("moderate");
    expect(forecast({ members: [...members(6), ...members(6, 0.985, false)] }).confidence).toBe("moderate");
    expect(forecast({ members: [...members(2), ...members(10, 0.985, false)] }).confidence).toBe("low");
  });
});

describe("the over-provisioning recommendation", () => {
  test("recommends carrying more than the target, because the target is the finish line", () => {
    // "Carry twelve" is the advice that fails: twelve is the number that must still be standing at the
    // end, not the number to start with.
    const result = forecast({ optedInEver: 12, invitedEver: 24 });
    expect(result.recommendedRosterSize).toBeGreaterThan(12);
  });

  test("never exceeds the cohort's own roster cap", () => {
    const result = forecast({ optedInEver: 1, invitedEver: 40, maxRosterSize: 20 });
    expect(result.recommendedRosterSize).toBeLessThanOrEqual(20);
  });

  test("never falls below the target — you cannot finish with fewer than you need", () => {
    const result = forecast({ optedInEver: 40, invitedEver: 40, members: members(12, 1) });
    expect(result.recommendedRosterSize).toBeGreaterThanOrEqual(12);
  });
});

describe("the model's own labels", () => {
  test("declares its calibration and its method on every reading", () => {
    // `default` says out loud that 0.998 is a number we chose. `method` stops a chart silently
    // splicing two different models into one line.
    const result = forecast();
    expect(result.calibration).toBe("default");
    expect(result.method).toBe("poisson_binomial_v1");
  });

  test("a brand-new empty cohort reports no_history rather than a forecast", () => {
    const result = forecast({
      optedInCount: 0,
      members: [],
      pipeline: [],
      cohortAgeDays: 0,
      optedInEver: 0,
      invitedEver: 0,
    });
    expect(result.basis).toBe("no_history");
  });
});

describe("hold is conditional on reaching the target", () => {
  test("a cohort one short still reports a real hold probability, not zero", () => {
    // The bug this pins: asking `P(at least 12 of the 11 who confirmed)` is correctly zero, which
    // silently zeroed the product's headline number for most of every cohort's life — and reported it
    // with a zero-width band at high confidence, the exact false certainty the band exists to prevent.
    const result = forecast({
      optedInCount: 11,
      members: members(11),
      pipeline: [{ stage: "accepted", unreachable: false }],
    });
    expect(result.probabilityHoldWindow).toBeGreaterThan(0);
    expect(result.successProbability).toBeGreaterThan(0);
    expect(result.successProbability).toBeLessThan(1);
  });

  test("success decomposes as reach x hold, both non-degenerate", () => {
    const result = forecast({
      optedInCount: 9,
      members: members(9),
      pipeline: Array.from({ length: 6 }, () => ({ stage: "accepted" as const, unreachable: false })),
    });
    const reach = result.probabilityReachTarget;
    const hold = result.probabilityHoldWindow as number;
    expect(reach).toBeGreaterThan(0);
    expect(reach).toBeLessThan(1);
    expect(hold).toBeGreaterThan(0);
    expect(result.successProbability).toBeCloseTo(Math.min(0.99, reach * hold), 10);
  });

  test("an empty cohort is not reported as doomed on its first day", () => {
    // Nobody has confirmed, so there is nobody to average — assuming the worst of people who have not
    // arrived yet would paint a brand-new cohort as hopeless before anyone had a chance to answer.
    const result = forecast({
      optedInCount: 0,
      members: [],
      pipeline: Array.from({ length: 20 }, () => ({ stage: "invited" as const, unreachable: false })),
      cohortAgeDays: 1,
      optedInEver: 0,
      invitedEver: 20,
    });
    expect(result.probabilityHoldWindow).toBeGreaterThan(0);
  });

  test("padding assumes the behavior of who is already in, so a sick cohort forecasts worse", () => {
    const healthy = forecast({ optedInCount: 8, members: members(8, 0.998) });
    const ailing = forecast({ optedInCount: 8, members: members(8, 0.93) });
    expect(ailing.probabilityHoldWindow as number).toBeLessThan(healthy.probabilityHoldWindow as number);
  });
});

describe("the reported band always contains the point estimate", () => {
  test("under the shipped priors", () => {
    for (const unobserved of [0, 4, 8, 12]) {
      const result = forecast({ members: [...members(12 - unobserved), ...members(unobserved, 0.985, false)] });
      if (result.successProbability === null) continue;
      expect(result.successProbabilityLow as number).toBeLessThanOrEqual(result.successProbability);
      expect(result.successProbabilityHigh as number).toBeGreaterThanOrEqual(result.successProbability);
    }
  });

  test("and under a config whose unknown prior sits outside the bracket constants", () => {
    // The bracket is fixed while the priors it brackets are adopter-configurable. A project that sets
    // `survival.unknown` below the pessimistic constant would otherwise get a line outside its own bar.
    const result = forecast({ members: [...members(6), ...members(6, 0.8, false)] });
    expect(result.successProbabilityLow as number).toBeLessThanOrEqual(result.successProbability as number);
    expect(result.successProbabilityHigh as number).toBeGreaterThanOrEqual(result.successProbability as number);
  });
});

describe("the projected finish line", () => {
  /** A cohort short of target, with enough pipeline to close the gap. */
  function shortOfTarget(overrides: Partial<ForecastInput> = {}): ForecastInput {
    return {
      today: "2026-06-10",
      targetSize: 12,
      optedInCount: 8,
      daysRemaining: 14,
      members: Array.from({ length: 8 }, () => ({
        riskBand: "healthy" as const,
        observability: "observed" as const,
        dailySurvival: 0.99,
      })),
      pipeline: Array.from({ length: 10 }, () => ({ stage: "accepted" as const, unreachable: false })),
      optedInEver: 8,
      invitedEver: 18,
      medianConversionDays: null,
      conversionSampleSize: 0,
      cohortAgeDays: 5,
      maxRosterSize: 30,
      ...overrides,
    };
  }

  test("does not move when the cohort reaches target", () => {
    // The same cohort, three days apart, projected from either branch. `daysRemaining` counts further
    // days after the day that produced it, and the day target is met is itself the first held day — so
    // adding the whole remainder on the below-target branch lands one day past the fourteenth.
    const early = forecastCohort(shortOfTarget());
    expect(early.projectedTargetMetOn).toBe("2026-06-13");

    const arrived = forecastCohort(
      shortOfTarget({
        today: "2026-06-13",
        optedInCount: 12,
        daysRemaining: 13,
        members: Array.from({ length: 12 }, () => ({
          riskBand: "healthy" as const,
          observability: "observed" as const,
          dailySurvival: 0.99,
        })),
      }),
    );

    expect(arrived.projectedTargetMetOn).toBe("2026-06-13");
    expect(early.projectedCompleteOn).toBe(arrived.projectedCompleteOn);
  });

  test("counts the day target is met as the first of the window, not the zeroth", () => {
    // Fourteen continuous days beginning 2026-06-13 ends on 2026-06-26.
    expect(forecastCohort(shortOfTarget()).projectedCompleteOn).toBe("2026-06-26");
  });

  test("never projects a finish before the target is met", () => {
    // Reachable under `resetPolicy: "pause"`, where days are banked: a cohort can sit below target with
    // the remainder already at zero.
    const paused = forecastCohort(shortOfTarget({ daysRemaining: 0 }));
    expect(paused.projectedCompleteOn).toBe(paused.projectedTargetMetOn);
  });
});
