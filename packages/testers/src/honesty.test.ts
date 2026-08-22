// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { z } from "zod";
import { TestersCohortSnapshot } from "./data/snapshot";
import { CohortView, DISCLAIMER, ESTIMATE_STATEMENT, EstimateDisclaimer } from "./http/responses";

/**
 * The guardrails that keep this package from claiming to know something it cannot.
 *
 * Google computes the authoritative opt-in count and the continuous-day streak, and exposes neither
 * through any API — not the roster, not the number, not a tester quietly opting out. Everything Pithy
 * reports about opt-ins is therefore a replay of its own invite records: a well-informed estimate of a
 * figure somebody else owns.
 *
 * **A note in the docs does not survive contact with a deadline.** The person who reads "this is an
 * estimate" and the person who writes `if (cohort.heldDays >= 14) applyForProduction()` are the same
 * person on different days, and the second one is not thinking about the first one's caveat. So the
 * honesty is enforced in the schema — required fields, `estimated*` names, nullable probabilities — and
 * this file is what stops a later refactor quietly softening any of it.
 *
 * Every assertion here is a decision somebody could reasonably want to undo, which is exactly why each
 * one is written down with the reason attached.
 */

/**
 * Field names that would read as authoritative.
 *
 * `optInStreak: 9` reads as a fact about Google. `estimatedHeldDays: 9` reads as a claim about our own
 * records. That difference is the whole disclosure, and it costs nothing to keep.
 */
const BANNED_FIELD_NAMES = [
  "optInStreak",
  "streakDays",
  "daysOptedIn",
  "daysCompleted",
  "googleDays",
  "playStatus",
  "verified",
  "confirmed",
];

/**
 * Walk every field of a Zod object, however wrapped.
 *
 * The unwrapping has to follow `innerType` **and** `element` at every step rather than peeking at
 * `element` only on the outermost wrapper. `CohortView.members` is `z.array(MemberView).optional()`,
 * so the outer node is a `ZodOptional` whose `def` has `innerType` and no `element` — the old walker
 * looked for `element` there, missed, recursed into the `ZodArray`, found it was not a `ZodObject`
 * and had no `innerType`, and returned. The entire per-tester half of the response went unwalked,
 * which is the half the file's own comment says holds most of the naming. `trend.series` was covered
 * only because it happens to be a bare array with no `.optional()`.
 */
function fieldNames(schema: z.ZodType, found: string[] = [], depth = 0): string[] {
  if (depth > 12) return found;
  let current: z.ZodType | undefined = schema;
  while (current && !(current instanceof z.ZodObject)) {
    const def: { innerType?: z.ZodType; element?: z.ZodType } | undefined = (
      current as unknown as { def?: { innerType?: z.ZodType; element?: z.ZodType } }
    ).def;
    current = def?.innerType ?? def?.element;
  }
  if (!(current instanceof z.ZodObject)) return found;
  for (const [key, field] of Object.entries(current.shape)) {
    found.push(key);
    fieldNames(field as z.ZodType, found, depth + 1);
  }
  return found;
}

describe("naming: an estimate must read as one", () => {
  test("no response field is named as though it were Google's own figure", () => {
    const names = [...fieldNames(CohortView), ...fieldNames(TestersCohortSnapshot)];
    const offenders = names.filter((name) => BANNED_FIELD_NAMES.includes(name));
    expect(
      offenders,
      `These field names read as authoritative claims about Google's count rather than as Pithy's estimate. Prefix them 'estimated'.`,
    ).toEqual([]);
  });

  test("the walk actually reaches the roster, which is where most of the naming lives", () => {
    // The guard above is only worth what it covers. `members` is an optional array, and the walker
    // used to stop at the `ZodOptional` — so every per-tester field was unchecked, including the one
    // name in the banned list (`daysOptedIn`) that could only ever appear there.
    const names = fieldNames(CohortView);
    expect(names).toContain("members");
    for (const perTester of ["email", "estimatedOptedInAt", "estimatedOptInDays", "riskBand"]) {
      expect(names, `${perTester} is on MemberView but the walk never reached it`).toContain(perTester);
    }
  });

  test("the opt-in figures on the wire are all prefixed `estimated`", () => {
    // The three numbers a developer would actually act on. If any of them lost the prefix, the
    // response would start asserting something it cannot check.
    const clock = CohortView.shape.estimatedClock;
    const names = fieldNames(clock);
    for (const required of ["estimatedHeldDays", "estimatedDaysRemaining", "estimatedWindowStartOn"]) {
      expect(names).toContain(required);
    }
  });

  test("the snapshot's opt-in count is named as an estimate", () => {
    expect(fieldNames(TestersCohortSnapshot)).toContain("estimatedOptedInCount");
  });
});

describe("structure: the disclosure cannot be dropped", () => {
  test("a cohort without a disclaimer does not parse", () => {
    // Required and non-nullable, so the common "spread the cohort into a card component" path still
    // carries it. A field that could be omitted would be omitted.
    const { disclaimer: _dropped, ...withoutDisclaimer } = sampleCohort();
    expect(() => CohortView.parse(withoutDisclaimer)).toThrow();
    expect(() => CohortView.parse(sampleCohort())).not.toThrow();
  });

  test("the disclaimer states who owns the number and that it is unreadable", () => {
    expect(DISCLAIMER.authority).toBe("google_play_console");
    expect(DISCLAIMER.readable).toBe(false);
    expect(DISCLAIMER.source).toBe("pithy_invite_records");
    expect(DISCLAIMER.statement).toBe(ESTIMATE_STATEMENT);
  });

  test("`readable` is a literal false, so no code path can set it true", () => {
    expect(() => EstimateDisclaimer.parse({ ...DISCLAIMER, readable: true })).toThrow();
  });

  test("the divergence risks are never empty", () => {
    // There is always at least a silent opt-out and an assumed reset policy. An empty list would say
    // the two counts agree, which is a claim nobody can make.
    expect(DISCLAIMER.divergenceRisks.length).toBeGreaterThan(0);
    expect(() => EstimateDisclaimer.parse({ ...DISCLAIMER, divergenceRisks: [] })).toThrow();
    expect(DISCLAIMER.divergenceRisks).toContain("silent_opt_out");
    expect(DISCLAIMER.divergenceRisks).toContain("reset_policy_assumed");
  });

  test("the estimated and observed halves carry literal source discriminators", () => {
    // So a developer destructuring `cohort.estimatedClock` cannot reach the number without typing the
    // word `estimated`, and a developer reading `cohort.activity` knows it is fact.
    const cohort = CohortView.parse(sampleCohort());
    expect(cohort.estimatedClock.source).toBe("pithy_estimate");
    expect(cohort.activity.source).toBe("observed");
    expect(() =>
      CohortView.parse({ ...sampleCohort(), estimatedClock: { ...sampleCohort().estimatedClock, source: "google" } }),
    ).toThrow();
  });

  test("the day boundary is stated, because ours may not be Google's", () => {
    expect(CohortView.parse(sampleCohort()).estimatedClock.dayBoundary).toBe("UTC");
  });
});

describe("uncertainty: 'we do not know' must be representable", () => {
  test("the success probability accepts null rather than forcing a plausible guess", () => {
    // The normal case for an app whose test flow never asks anyone to sign in. A 0.5 here would render
    // in a dashboard as a real answer.
    const blind = sampleCohort();
    blind.projection.successProbability = null;
    blind.projection.probabilityHoldWindow = null;
    blind.projection.successProbabilityRange = null;
    blind.projection.confidence = null;
    blind.projection.basis = "no_observable_signal";
    expect(() => CohortView.parse(blind)).not.toThrow();
  });

  test("the success probability is capped below one — nothing here is ever certain", () => {
    const certain = sampleCohort();
    certain.projection.successProbability = 1;
    expect(() => CohortView.parse(certain)).toThrow();
  });

  test("the calibration says out loud that the priors are numbers we chose", () => {
    expect(CohortView.parse(sampleCohort()).projection.calibration).toBe("default");
  });

  test("the method is named, so a chart cannot splice two models into one line", () => {
    expect(CohortView.parse(sampleCohort()).projection.method).toBe("poisson_binomial_v1");
  });

  test("reconciliation is present and honestly empty rather than absent", () => {
    // "We checked and cannot" and "we never thought about it" are different facts, and an absent field
    // says the second.
    const cohort = CohortView.parse(sampleCohort());
    expect(cohort.reconciliation.supported).toBe(false);
    expect(cohort.reconciliation.lastReconciledAt).toBeNull();
    expect(cohort.reconciliation.reason.length).toBeGreaterThan(20);
    expect(() =>
      CohortView.parse({ ...sampleCohort(), reconciliation: { ...sampleCohort().reconciliation, supported: true } }),
    ).toThrow();
  });

  test("the reset policy is exposed as the assumption it is", () => {
    // Google documents neither behavior, so naming the field for what it is beats burying it in the
    // arithmetic.
    expect(["reset", "pause"]).toContain(CohortView.parse(sampleCohort()).resetPolicy);
  });
});

describe("the sentence", () => {
  test("names Google as the authority and says no API exposes it", () => {
    expect(ESTIMATE_STATEMENT).toMatch(/estimate/i);
    expect(ESTIMATE_STATEMENT).toMatch(/Google/);
    expect(ESTIMATE_STATEMENT).toMatch(/no API exposes it/i);
  });
});

/** A complete, valid cohort view — the fixture every structural assertion above mutates one field of. */
function sampleCohort(): z.output<typeof CohortView> {
  return {
    id: "cohort-1",
    name: "closed-test",
    targetPlatform: "android",
    targetSize: 12,
    windowDays: 14,
    maxRosterSize: 100,
    resetPolicy: "reset",
    createdAt: "2026-06-01T00:00:00.000Z",
    closedAt: null,
    roster: {
      size: 14,
      headroomToMax: 86,
      invited: 1,
      accepted: 1,
      optedIn: 12,
      lapsed: 0,
      unreachable: 0,
      neverLinked: 3,
    },
    estimatedClock: {
      source: "pithy_estimate",
      meetsTarget: true,
      headroom: 0,
      estimatedHeldDays: 9,
      estimatedDaysRemaining: 5,
      estimatedWindowStartOn: "2026-06-02",
      resetCount: 0,
      dayBoundary: "UTC",
    },
    activity: {
      source: "observed",
      active: 7,
      darkThreeToSeven: 1,
      darkEightToThirteen: 1,
      darkFourteenPlus: 0,
      neverLinked: 3,
      observedCoverage: 0.75,
    },
    projection: {
      basis: "estimated",
      calibration: "default",
      method: "poisson_binomial_v1",
      confidence: "moderate",
      observedCoverage: 0.75,
      probabilityReachTarget: 1,
      probabilityHoldWindow: 0.71,
      successProbability: 0.71,
      successProbabilityRange: { low: 0.55, high: 0.84 },
      expectedSurvivors: 11.3,
      projectedTargetMetOn: "2026-06-10",
      projectedCompleteOn: "2026-06-15",
      invitesNeeded: 0,
      recommendedRosterSize: 18,
    },
    trend: {
      direction: "declining",
      reason: "Two testers went dark this week.",
      fragile: true,
      optedInDelta1d: 0,
      optedInDelta7d: -1,
      activeDelta7d: -2,
      successProbabilityDelta7d: -0.14,
      series: [],
    },
    reconciliation: {
      supported: false,
      lastReconciledAt: null,
      reason: "The Google Play Developer API exposes no tester roster, no opt-in count, and no opt-out signal.",
    },
    disclaimer: DISCLAIMER,
  };
}
