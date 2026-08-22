// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { HealthCredits, HealthPenalties, SurvivalPriors, TesterPlatform } from "../config/config";
import type { Observability, RiskBand } from "../data/enums";

/**
 * Per-tester health: how worried to be about one person, and why.
 *
 * **Health is a risk signal, never a membership signal.** A tester who opted in and never opens the app
 * still counts toward Google's twelve — Google counts opt-ins, not engagement — so nothing in this file
 * may remove anybody from the count. What it produces is the only early-warning signal that exists: a
 * tester dark for eight days is the one most likely to have quietly opted out or uninstalled, and
 * knowing that on day eight is worth a great deal more than discovering it on day fourteen.
 *
 * **Every term is reported individually.** A score is returned with the list of factors that produced
 * it, so a developer can see that 45 of their missing points came from `dark_8_10` rather than being
 * asked to accept a number. An unauditable score is an unaccountable one, and this whole capability is
 * arguing that the developer should not have to take anyone's word for a figure.
 *
 * **The formula is additive and integer, on purpose.** A logistic curve would fit the data better if
 * there were data to fit; there is not, these are declared priors, and a curve would only make the
 * arbitrariness harder to see. Addition can be explained in one sentence per line.
 */

/** The best score a tester can hold. */
const MAX_HEALTH = 100;

/** One term of a health score, with the sentence that justifies it. */
export interface HealthFactor {
  /** A stable identifier for this term, e.g. `dark_8_10`. Safe to key a UI off. */
  readonly code: string;
  /** The signed contribution to the score. Penalties are negative, credits positive. */
  readonly points: number;
  /** One sentence explaining this factor to a developer. */
  readonly reason: string;
}

/** What scoring one tester needs to know about them. Everything here is observed, not estimated. */
export interface HealthInput {
  /** How much of this tester we can see at all. Decides whether they get a score or a stated absence of one. */
  readonly observability: Observability;
  /**
   * Days since the last sign of life — a session refresh, a device sighting, or their own opt-in,
   * whichever is most recent. Null when they were never linked to a user at all.
   */
  readonly daysDark: number | null;
  /** Sessions inside the cohort's window. */
  readonly sessionsInWindow: number;
  /** How many devices are registered to them. */
  readonly deviceCount: number;
  /** Whether at least one of those devices runs the cohort's target platform. */
  readonly hasTargetPlatformDevice: boolean;
  /** Whether they have authenticated at all since following the opt-in link. */
  readonly sessionSinceOptIn: boolean;
  /** Nudges sent with no subsequent sign of life. Each is an unanswered probe. */
  /** Nudges enqueued since they last answered one — cleared by accepting or confirming, not by activity. */
  readonly unansweredNudges: number;
  /** Days since they followed the opt-in link, or null if they have not. */
  readonly daysSinceOptIn: number | null;
  /** The cohort's target platform, or null to disable the device term entirely. */
  readonly targetPlatform: TesterPlatform | null;
}

/** A scored tester: the number, the band it falls in, and every term that produced it. */
export interface HealthResult {
  /** 0–100, or null for a tester we cannot observe. Null is not zero — absence of evidence is not evidence of risk. */
  readonly health: number | null;
  /** Why the score is null when it is null. A UI must render `unobservable` gray, never red. */
  readonly basis: "scored" | "unobservable" | "unreachable";
  /** The band the score falls in, which selects the survival prior. */
  readonly riskBand: RiskBand;
  /** Every term, so the number can be audited line by line. Empty for an unscored tester. */
  readonly factors: readonly HealthFactor[];
}

/** The dark-day bands. Exclusive: exactly one fires, and the widest matching one wins. */
const DARK_BANDS: readonly { min: number; max: number; code: string; key: keyof HealthPenalties; reason: string }[] = [
  {
    min: 3,
    max: 4,
    code: "dark_3_4",
    key: "darkThreeToFour",
    reason: "Three days quiet is noise rather than signal — worth a nudge, not an alarm.",
  },
  {
    min: 5,
    max: 7,
    code: "dark_5_7",
    key: "darkFiveToSeven",
    reason: "A week without opening the app is the first real sign of drift.",
  },
  {
    min: 8,
    max: 10,
    code: "dark_8_10",
    key: "darkEightToTen",
    reason: "Eight days dark is the strongest single predictor of a silent uninstall.",
  },
  {
    min: 11,
    max: 13,
    code: "dark_11_13",
    key: "darkElevenToThirteen",
    reason: "Nearly the whole window with no sign of life.",
  },
  {
    min: 14,
    max: Number.POSITIVE_INFINITY,
    code: "dark_14_plus",
    key: "darkFourteenPlus",
    reason: "Gone for longer than the test you are asking them to complete.",
  },
];

/** The band a score falls in. Bands are inclusive at their lower bound. */
export function bandFor(health: number | null): RiskBand {
  if (health === null) return "unknown";
  if (health >= 80) return "healthy";
  if (health >= 60) return "watch";
  if (health >= 30) return "at_risk";
  return "critical";
}

/** The published daily-survival prior for a band. */
export function survivalFor(band: RiskBand, observability: Observability, priors: SurvivalPriors): number {
  if (observability === "unreachable") return priors.unreachable;
  switch (band) {
    case "healthy":
      return priors.healthy;
    case "watch":
      return priors.watch;
    case "at_risk":
      return priors.atRisk;
    case "critical":
      return priors.critical;
    default:
      return priors.unknown;
  }
}

/**
 * Score one tester.
 *
 * An unobservable or unreachable tester returns `health: null` with a stated basis rather than a low
 * number. This is the single most important decision in the file: if an adopter's test flow never asks
 * anyone to sign in, *every* tester is unobservable, and scoring them badly would paint a perfectly
 * healthy cohort red and drive a fortnight of pointless nudging. Null makes the blindness visible in
 * the aggregate — as `observedCoverage` and a widening confidence band — instead of hiding it inside a
 * number that looks like knowledge.
 */
export function scoreHealth(input: HealthInput, penalties: HealthPenalties, credits: HealthCredits): HealthResult {
  if (input.observability === "unreachable") {
    return { health: null, basis: "unreachable", riskBand: "unknown", factors: [] };
  }
  if (input.observability === "unobservable" || input.daysDark === null) {
    return { health: null, basis: "unobservable", riskBand: "unknown", factors: [] };
  }

  const factors: HealthFactor[] = [];

  const band = DARK_BANDS.find(
    (entry) => input.daysDark !== null && input.daysDark >= entry.min && input.daysDark <= entry.max,
  );
  if (band) {
    factors.push({ code: band.code, points: -penalties[band.key], reason: band.reason });
  }

  // Gated on the cohort declaring a target platform. An `ios` cohort penalizing a missing Android
  // device, or a cohort with no platform at all penalizing everybody, would both be noise.
  if (input.targetPlatform !== null && !input.hasTargetPlatformDevice) {
    factors.push({
      code: "no_target_platform_device",
      points: -penalties.noTargetPlatformDevice,
      reason: `The test targets ${input.targetPlatform}, and no ${input.targetPlatform} device is registered for them.`,
    });
  }

  if (input.unansweredNudges > 0) {
    const raw = input.unansweredNudges * penalties.unansweredNudge;
    factors.push({
      code: "unanswered_nudges",
      points: -Math.min(raw, penalties.unansweredNudgeCap),
      reason: "Each nudge is a probe. Several unanswered probes are themselves an answer.",
    });
  }

  if (input.daysSinceOptIn !== null && !input.sessionSinceOptIn) {
    factors.push({
      code: "session_never_since_optin",
      points: -penalties.noSessionSinceOptIn,
      reason: "They confirmed the opt-in link but have not opened the app since.",
    });
  }

  if (input.sessionsInWindow >= credits.engagedSessionThreshold) {
    factors.push({
      code: "engaged",
      points: credits.engaged,
      reason: `${credits.engagedSessionThreshold} or more sessions in the window is a tester who is actually testing.`,
    });
  }

  if (input.deviceCount >= 2) {
    factors.push({
      code: "multi_device",
      points: credits.multiDevice,
      reason: "Two registered devices is someone invested enough to install twice.",
    });
  }

  // Without this, a tester who confirmed three hours ago reads as neglected on arrival: they have no
  // sessions yet, so every engagement term is against them and none is for them.
  if (input.daysSinceOptIn !== null && input.daysSinceOptIn <= credits.freshOptInDays) {
    factors.push({
      code: "fresh_optin",
      points: credits.freshOptIn,
      reason: "Opted in within the last few days, so there has been no time to decay.",
    });
  }

  const total = factors.reduce((sum, factor) => sum + factor.points, MAX_HEALTH);
  const health = Math.min(MAX_HEALTH, Math.max(0, total));
  return { health, basis: "scored", riskBand: bandFor(health), factors };
}
