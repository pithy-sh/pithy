// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { HealthCredits, HealthPenalties, SurvivalPriors } from "../config/config";
import { bandFor, type HealthInput, scoreHealth, survivalFor } from "./score";

const PENALTIES = HealthPenalties.parse({});
const CREDITS = HealthCredits.parse({});
const PRIORS = SurvivalPriors.parse({});

/** A tester who is doing everything right — every term neutral or positive. */
const IDEAL: HealthInput = {
  observability: "observed",
  daysDark: 0,
  sessionsInWindow: 8,
  deviceCount: 2,
  hasTargetPlatformDevice: true,
  sessionSinceOptIn: true,
  unansweredNudges: 0,
  daysSinceOptIn: 10,
  targetPlatform: "android",
};

function score(overrides: Partial<HealthInput>) {
  return scoreHealth({ ...IDEAL, ...overrides }, PENALTIES, CREDITS);
}

/** The points a factor contributed, or 0 if it never fired. */
function points(result: ReturnType<typeof score>, code: string): number {
  return result.factors.find((factor) => factor.code === code)?.points ?? 0;
}

describe("scoring a tester we can see", () => {
  test("an engaged tester tops out at 100 rather than exceeding it", () => {
    // Credits can push a perfect tester past the ceiling; a score of 115 would break every band
    // boundary and every progress bar downstream.
    const result = score({ daysSinceOptIn: 1 });
    expect(result.health).toBe(100);
    expect(result.riskBand).toBe("healthy");
    expect(result.basis).toBe("scored");
  });

  test("every term that fired is reported, so the number can be audited line by line", () => {
    const result = score({ daysDark: 9, unansweredNudges: 2, sessionsInWindow: 0, deviceCount: 1 });
    expect(result.factors.map((factor) => factor.code).sort()).toEqual(["dark_8_10", "unanswered_nudges"]);
    // Every factor carries a sentence — a code alone is not an explanation.
    for (const factor of result.factors) expect(factor.reason.length).toBeGreaterThan(10);
  });

  test("exactly one dark band fires, and it is the one the day count falls in", () => {
    expect(points(score({ daysDark: 2 }), "dark_3_4")).toBe(0); // two days is not yet a band
    expect(points(score({ daysDark: 4 }), "dark_3_4")).toBe(-10);
    expect(points(score({ daysDark: 6 }), "dark_5_7")).toBe(-25);
    expect(points(score({ daysDark: 9 }), "dark_8_10")).toBe(-45);
    expect(points(score({ daysDark: 12 }), "dark_11_13")).toBe(-60);
    expect(points(score({ daysDark: 40 }), "dark_14_plus")).toBe(-75);
    // Never two at once — the bands are exclusive, and overlapping them would double-penalize.
    const result = score({ daysDark: 9 });
    expect(result.factors.filter((factor) => factor.code.startsWith("dark_"))).toHaveLength(1);
  });

  test("darkness is monotonic — more days quiet is never a better score", () => {
    const scores = [0, 3, 6, 9, 12, 20].map((daysDark) => score({ daysDark }).health ?? 0);
    for (let index = 1; index < scores.length; index++) {
      expect(scores[index]).toBeLessThanOrEqual(scores[index - 1] as number);
    }
  });

  test("a tester dark for eight days lands in at_risk, which is the whole point of the signal", () => {
    // Eight days is the band the design calls the strongest silent-uninstall predictor. If it scored
    // as `watch`, the early warning would arrive too late to act on.
    const result = score({ daysDark: 8, sessionsInWindow: 1, deviceCount: 1, daysSinceOptIn: 9 });
    expect(result.health).toBe(55);
    expect(result.riskBand).toBe("at_risk");
  });

  test("the unanswered-nudge penalty is capped, because a fourth probe tells you nothing new", () => {
    expect(points(score({ unansweredNudges: 1 }), "unanswered_nudges")).toBe(-8);
    expect(points(score({ unansweredNudges: 3 }), "unanswered_nudges")).toBe(-24);
    expect(points(score({ unansweredNudges: 9 }), "unanswered_nudges")).toBe(-24);
  });

  test("a fresh opt-in is credited, so someone who joined this morning does not read as neglected", () => {
    // Without this term a tester who confirmed three hours ago has no sessions, so every engagement
    // credit is withheld and they arrive looking like a problem.
    // Both carry one real penalty, so the credit is visible rather than clipped off at the ceiling.
    const fresh = score({ daysSinceOptIn: 1, daysDark: 6, sessionsInWindow: 0, deviceCount: 1 });
    const stale = score({ daysSinceOptIn: 30, daysDark: 6, sessionsInWindow: 0, deviceCount: 1 });
    expect(points(fresh, "fresh_optin")).toBe(5);
    expect(points(stale, "fresh_optin")).toBe(0);
    expect(fresh.health).toBe(80);
    expect(stale.health).toBe(75);
  });

  test("confirming the link but never opening the app is penalized without being disqualifying", () => {
    // They still count toward Google's twelve. The score says watch them; it must not remove them.
    const result = score({ sessionSinceOptIn: false, daysSinceOptIn: 5, sessionsInWindow: 0, deviceCount: 1 });
    expect(points(result, "session_never_since_optin")).toBe(-20);
    expect(result.health).toBeGreaterThan(0);
  });

  test("the missing-device penalty names the platform, and is skipped when no platform is targeted", () => {
    const android = score({ hasTargetPlatformDevice: false });
    expect(points(android, "no_target_platform_device")).toBe(-15);
    expect(android.factors.find((f) => f.code === "no_target_platform_device")?.reason).toContain("android");
    // A cohort that declares no platform must not penalize everyone for failing an unstated test.
    expect(points(score({ hasTargetPlatformDevice: false, targetPlatform: null }), "no_target_platform_device")).toBe(
      0,
    );
  });

  test("a score never goes below zero however many penalties stack", () => {
    const result = score({
      daysDark: 60,
      unansweredNudges: 10,
      sessionsInWindow: 0,
      deviceCount: 0,
      hasTargetPlatformDevice: false,
      sessionSinceOptIn: false,
      daysSinceOptIn: 40,
    });
    expect(result.health).toBe(0);
    expect(result.riskBand).toBe("critical");
  });
});

describe("scoring a tester we cannot see", () => {
  test("an unobservable tester gets null, not a low score", () => {
    // The decision the whole model turns on. If an adopter's test flow requires no sign-in, every
    // tester is unobservable — and scoring them badly would paint a healthy cohort red.
    const result = score({ observability: "unobservable", daysDark: null });
    expect(result.health).toBeNull();
    expect(result.basis).toBe("unobservable");
    expect(result.riskBand).toBe("unknown");
    expect(result.factors).toEqual([]);
  });

  test("an unreachable tester is distinguished from an unobservable one", () => {
    // Different actions: unobservable means watch them, unreachable means replace them.
    const result = score({ observability: "unreachable", daysDark: null });
    expect(result.health).toBeNull();
    expect(result.basis).toBe("unreachable");
  });

  test("a null dark-day count is unobservable even if the flag says otherwise", () => {
    // Belt and braces: `daysDark: null` means never linked, and a caller that got the flags out of
    // step must not produce a confident score from an absent measurement.
    expect(score({ observability: "observed", daysDark: null }).basis).toBe("unobservable");
  });
});

describe("bands and their survival priors", () => {
  test("the band boundaries are where the published table says they are", () => {
    expect(bandFor(100)).toBe("healthy");
    expect(bandFor(80)).toBe("healthy");
    expect(bandFor(79)).toBe("watch");
    expect(bandFor(60)).toBe("watch");
    expect(bandFor(59)).toBe("at_risk");
    expect(bandFor(30)).toBe("at_risk");
    expect(bandFor(29)).toBe("critical");
    expect(bandFor(0)).toBe("critical");
    expect(bandFor(null)).toBe("unknown");
  });

  test("each band selects its published prior, and unknown is deliberately mild", () => {
    expect(survivalFor("healthy", "observed", PRIORS)).toBe(0.998);
    expect(survivalFor("watch", "observed", PRIORS)).toBe(0.99);
    expect(survivalFor("at_risk", "observed", PRIORS)).toBe(0.97);
    expect(survivalFor("critical", "observed", PRIORS)).toBe(0.93);
    // Absence of evidence is not evidence of risk: an unseen tester is assumed near-healthy, and the
    // uncertainty is disclosed by the widening confidence band instead.
    expect(survivalFor("unknown", "unobservable", PRIORS)).toBe(0.985);
  });

  test("unreachable overrides the band entirely — we cannot even nudge them", () => {
    expect(survivalFor("healthy", "unreachable", PRIORS)).toBe(0.95);
    expect(survivalFor("unknown", "unreachable", PRIORS)).toBe(0.95);
  });
});
