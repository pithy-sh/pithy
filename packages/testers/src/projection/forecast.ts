// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { addDays, type DayKey } from "../clock/days";
import type { Observability, ProjectionBasis, ProjectionConfidence, RiskBand } from "../data/enums";
import { expectedSurvivors, probabilityAtLeast, survivalOverDays } from "./poissonBinomial";

/**
 * The forecast: how likely this cohort is to finish its window, and what to do about it.
 *
 * **Success needs two independent things to go right, and they are reported separately.** Reaching the
 * target is one problem — do enough of the people you invited actually confirm? Holding it is another —
 * do enough of the people who confirmed stay confirmed for the remaining days? Multiplying them into a
 * single percentage destroys the only actionable information in the pair. "62%" tells a developer
 * nothing they can act on; "you will reach twelve (95%) but only hold it 65% of the time" tells them to
 * invite four more people this afternoon.
 *
 * **The whole thing degrades honestly, and the mechanism is structural rather than a disclaimer.** When
 * nothing about a cohort is observable — which is the normal case for an app whose test flow never asks
 * anyone to sign in — `successProbability` is `null` with a stated basis, not a plausible-looking 0.5.
 * When coverage is partial, the reported band widens in exact proportion to how blind we are, by
 * re-running the same computation with the unobservable testers pinned pessimistic and optimistic. A
 * dashboard cannot render a wide band as a confident number, which is the point: the band's width *is*
 * the disclosure.
 *
 * And none of it is Google's number. Google computes the authoritative opt-in streak and exposes it
 * through no API at all. Everything here forecasts Pithy's own estimate.
 */

/** Nothing is certain until Google says so, and Google is not talking. */
const MAX_REPORTED_PROBABILITY = 0.99;

/** The survival rate an unobservable tester is assumed to have when we are being pessimistic. */
const PESSIMISTIC_UNKNOWN_SURVIVAL = 0.95;

/** The survival rate an unobservable tester is assumed to have when we are being optimistic. */
const OPTIMISTIC_UNKNOWN_SURVIVAL = 0.999;

/**
 * The per-day survival assumed for a tester who has not confirmed yet, on a cohort with nobody to
 * average. Matches the healthy prior: someone who has not arrived cannot yet have gone quiet.
 */
const DEFAULT_PADDING_SURVIVAL = 0.998;

/** Coverage at or above this, on a cohort with some history, is worth calling high confidence. */
const HIGH_CONFIDENCE_COVERAGE = 0.75;

/** Coverage at or above this is worth calling moderate. */
const MODERATE_CONFIDENCE_COVERAGE = 0.4;

/** A cohort younger than this has not accumulated enough days for high confidence, however visible it is. */
const HIGH_CONFIDENCE_MIN_AGE_DAYS = 7;

/** The assumed invite-to-opt-in latency before a cohort has converted anyone, in days. */
const DEFAULT_CONVERSION_LATENCY_DAYS = 3;

/** How many conversions a cohort needs before its own observed latency beats the prior. */
const MIN_CONVERSIONS_FOR_OBSERVED_LATENCY = 5;

/**
 * How much likelier an accepted tester is to convert than a merely-invited one.
 *
 * Someone who has answered the first email has demonstrably opened it and said yes — nothing more, since
 * answering needs no account and installs nothing. That is still a far better predictor than an invitation
 * nobody has replied to,
 * and authenticated. They are further along than someone who has not opened the email at all, and
 * treating the two identically would make the pipeline estimate uselessly pessimistic for exactly the
 * cohorts that are going well.
 */
const ACCEPTED_CONVERSION_MULTIPLIER = 1.6;

/** However promising, nobody is a certainty to convert until they have. */
const MAX_PER_MEMBER_CONVERSION = 0.95;

/** One opted-in tester, reduced to what the forecast needs. */
export interface ForecastMember {
  readonly riskBand: RiskBand;
  readonly observability: Observability;
  /** The published daily-survival prior their band selects. */
  readonly dailySurvival: number;
}

/** One tester who has not opted in yet, and how close they are to doing so. */
export interface PipelineMember {
  /** `accepted` testers have answered the first email agreeing to test; `invited` ones have not replied. */
  readonly stage: "invited" | "accepted";
  /** Whether their address bounced. An unreachable invitee converts at zero — we cannot even chase them. */
  readonly unreachable: boolean;
}

/** Everything the forecast needs. All of it is derived; none of it is stored. */
export interface ForecastInput {
  /** The day being forecast from. */
  readonly today: DayKey;
  /** How many testers must be opted in simultaneously. */
  readonly targetSize: number;
  /** Pithy's estimate of how many are opted in right now. */
  readonly optedInCount: number;
  /** Window days still to hold, on Pithy's estimate. */
  readonly daysRemaining: number;
  /** The currently opted-in testers, with their bands. */
  readonly members: readonly ForecastMember[];
  /** Testers still in the pipeline — invited or accepted, not yet confirmed. */
  readonly pipeline: readonly PipelineMember[];
  /** How many members have ever reached `opted_in`, for the conversion rate. */
  readonly optedInEver: number;
  /** How many members have ever been invited, for the conversion rate. */
  readonly invitedEver: number;
  /** The observed median days from invitation to opt-in, or null before enough conversions exist. */
  readonly medianConversionDays: number | null;
  /** How many conversions that median was computed from. */
  readonly conversionSampleSize: number;
  /** How many days old the cohort is. Drives confidence. */
  readonly cohortAgeDays: number;
  /** The cohort's roster cap, so the over-provisioning advice cannot exceed it. */
  readonly maxRosterSize: number;
}

/** Pithy's forecast for one cohort. Every field is an estimate; none of it reads Google. */
export interface Forecast {
  readonly basis: ProjectionBasis;
  readonly confidence: ProjectionConfidence | null;
  /** Share of opted-in testers we can see at all, 0–1. The honest denominator behind everything else. */
  readonly observedCoverage: number;
  readonly probabilityReachTarget: number;
  readonly probabilityHoldWindow: number | null;
  readonly successProbability: number | null;
  readonly successProbabilityLow: number | null;
  readonly successProbabilityHigh: number | null;
  readonly expectedSurvivors: number;
  readonly projectedTargetMetOn: DayKey | null;
  readonly projectedCompleteOn: DayKey | null;
  /** How many more people to invite to close the gap at this cohort's own conversion rate. */
  readonly invitesNeeded: number;
  /** The roster size that survives the window at this cohort's own conversion and drop-off rates. */
  readonly recommendedRosterSize: number;
  /** Always `default` today: the survival priors are numbers Pithy chose, not values fitted to your data. */
  readonly calibration: "default";
  /** The named, versioned method. A chart must not mix methods across one series. */
  readonly method: "poisson_binomial_v1";
}

/**
 * The share of invitations that have turned into opt-ins, Laplace-smoothed.
 *
 * The smoothing is not decoration. A cohort whose first invitee confirmed has converted one of one, and
 * reporting a 100% conversion rate off a single data point would tell a developer they need to invite
 * exactly twelve people — which is the advice most likely to leave them at eleven on day fourteen.
 * Adding one to the numerator and two to the denominator pulls a tiny sample toward a half and lets the
 * real rate assert itself as evidence accumulates.
 */
export function conversionRate(optedInEver: number, invitedEver: number): number {
  return (optedInEver + 1) / (invitedEver + 2);
}

/** How likely one pipeline member is to convert, given the cohort's observed rate. */
function memberConversion(member: PipelineMember, rate: number): number {
  if (member.unreachable) return 0;
  if (member.stage === "invited") return Math.min(MAX_PER_MEMBER_CONVERSION, rate);
  return Math.min(MAX_PER_MEMBER_CONVERSION, rate * ACCEPTED_CONVERSION_MULTIPLIER);
}

/** Confidence, from how much of the cohort is visible and how long it has been running. */
function confidenceFor(coverage: number, ageDays: number): ProjectionConfidence | null {
  // Zero coverage is not weak confidence. It is no opinion at all, and it must be representable as one.
  if (coverage <= 0) return null;
  if (coverage >= HIGH_CONFIDENCE_COVERAGE && ageDays >= HIGH_CONFIDENCE_MIN_AGE_DAYS) return "high";
  if (coverage >= MODERATE_CONFIDENCE_COVERAGE) return "moderate";
  return "low";
}

/**
 * Run the hold computation with unobservable testers pinned to a given survival rate.
 *
 * **Hold answers a conditional question: given the target is reached, does it hold?** That distinction
 * is the whole reason `P(success) = P(reach) × P(hold)` is a valid decomposition. Asking instead
 * "do the testers who have already confirmed hold the target?" makes the two halves dependent, and
 * worse, makes hold identically zero for every cohort below target — because `probabilityAtLeast`
 * correctly returns zero when you ask for more survivors than there are people. Since a cohort is below
 * target for most of its life, that would zero out the product's headline number almost always, and
 * report it with a zero-width band at high confidence: exactly the false certainty the band exists to
 * prevent.
 *
 * So a below-target cohort is padded with the testers it still needs, each carrying the mean survival
 * of the people already in. It is an assumption, and a mild one: a tester who has not confirmed yet is
 * assumed to behave like the ones who have.
 */
function holdProbability(
  members: readonly ForecastMember[],
  targetSize: number,
  daysRemaining: number,
  unknownSurvival: number | null,
): number {
  const probabilities = members.map((member) => {
    const daily =
      unknownSurvival !== null && member.observability !== "observed" ? unknownSurvival : member.dailySurvival;
    return survivalOverDays(daily, daysRemaining);
  });

  const deficit = targetSize - probabilities.length;
  if (deficit > 0) {
    // The mean of who is already in, or the healthy prior when nobody is — a brand-new cohort has no
    // behavior to average, and assuming the worst of people who have not arrived yet would report a
    // fresh cohort as doomed on its first day.
    const mean =
      probabilities.length > 0
        ? probabilities.reduce((sum, p) => sum + p, 0) / probabilities.length
        : survivalOverDays(DEFAULT_PADDING_SURVIVAL, daysRemaining);
    for (let i = 0; i < deficit; i++) probabilities.push(mean);
  }

  return probabilityAtLeast(probabilities, targetSize);
}

/** Cap a probability below one, so the response can never claim certainty. */
function cap(probability: number): number {
  return Math.min(MAX_REPORTED_PROBABILITY, probability);
}

/** Forecast one cohort. */
export function forecastCohort(input: ForecastInput): Forecast {
  const observed = input.members.filter((member) => member.observability === "observed").length;
  const coverage = input.members.length === 0 ? 0 : observed / input.members.length;
  const rate = conversionRate(input.optedInEver, input.invitedEver);

  const reachable = input.pipeline.filter((member) => !member.unreachable);
  const conversions = reachable.map((member) => memberConversion(member, rate));
  const deficit = Math.max(0, input.targetSize - input.optedInCount);

  const probabilityReachTarget = deficit === 0 ? 1 : probabilityAtLeast(conversions, deficit);
  const expectedConversions = conversions.reduce((sum, probability) => sum + probability, 0);

  // How many more people to invite so the *expected* conversions cover the gap. Reported even when the
  // probability looks survivable, because it is the one number a developer can act on this afternoon.
  const invitesNeeded =
    deficit === 0 ? 0 : Math.max(0, Math.ceil((deficit - expectedConversions) / Math.max(rate, 0.01)));

  const latency =
    input.medianConversionDays !== null && input.conversionSampleSize >= MIN_CONVERSIONS_FOR_OBSERVED_LATENCY
      ? input.medianConversionDays
      : DEFAULT_CONVERSION_LATENCY_DAYS;

  // Nothing observable at all: say so, rather than emit a number that looks like knowledge. This is the
  // normal case for an app whose test flow never asks anyone to sign in, so it has to be a first-class
  // answer rather than an edge case.
  if (input.members.length > 0 && coverage === 0) {
    return {
      basis: "no_observable_signal",
      confidence: null,
      observedCoverage: 0,
      probabilityReachTarget,
      probabilityHoldWindow: null,
      successProbability: null,
      successProbabilityLow: null,
      successProbabilityHigh: null,
      expectedSurvivors: expectedSurvivors(
        input.members.map((member) => survivalOverDays(member.dailySurvival, input.daysRemaining)),
      ),
      projectedTargetMetOn: deficit === 0 ? input.today : null,
      projectedCompleteOn: null,
      invitesNeeded,
      // The same drop-off factor the observed path uses. Passing 1 here would make the advice *less*
      // conservative exactly when Pithy is blind, and would contradict `expectedSurvivors` two lines
      // above, which already reads each member's own prior.
      recommendedRosterSize: recommendRoster(input, rate, holdSurvivalFactor(input)),
      calibration: "default",
      method: "poisson_binomial_v1",
    };
  }

  const hold = holdProbability(input.members, input.targetSize, input.daysRemaining, null);
  const holdLow = holdProbability(input.members, input.targetSize, input.daysRemaining, PESSIMISTIC_UNKNOWN_SURVIVAL);
  const holdHigh = holdProbability(input.members, input.targetSize, input.daysRemaining, OPTIMISTIC_UNKNOWN_SURVIVAL);

  const survivors = expectedSurvivors(
    input.members.map((member) => survivalOverDays(member.dailySurvival, input.daysRemaining)),
  );

  const targetMetOn =
    deficit === 0 ? input.today : expectedConversions >= deficit ? addDays(input.today, Math.ceil(latency)) : null;
  // `daysRemaining` means "further days after the day that produced this count" — `heldDays` counts the
  // at-target run inclusive of today. So on the at-target branch `targetMetOn` is today, itself already
  // held, and adding the whole remainder is right. On the below-target branch `targetMetOn` is the
  // *first* held day, so the window closes one day earlier than the same arithmetic suggests. Without
  // the adjustment the projected finish silently moved a day earlier the moment a cohort reached
  // target, with nothing about the cohort having changed. The floor covers `resetPolicy: "pause"`,
  // where a cohort can be below target with the remainder already at zero.
  const completeOn =
    targetMetOn === null
      ? null
      : deficit === 0
        ? addDays(targetMetOn, input.daysRemaining)
        : addDays(targetMetOn, Math.max(0, input.daysRemaining - 1));

  const basis: ProjectionBasis =
    input.cohortAgeDays === 0 && input.optedInCount === 0
      ? "no_history"
      : deficit === 0 && input.daysRemaining === 0
        ? "target_met"
        : targetMetOn === null
          ? "insufficient_pipeline"
          : "estimated";

  return {
    basis,
    confidence: confidenceFor(coverage, input.cohortAgeDays),
    observedCoverage: coverage,
    probabilityReachTarget,
    probabilityHoldWindow: hold,
    successProbability: cap(probabilityReachTarget * hold),
    // Clamped around the point estimate rather than trusted to order themselves. The bracket constants
    // are fixed while the priors they bracket are adopter-configurable, so a project that sets
    // `survival.unknown` below 0.95 would otherwise report a point estimate outside its own band — and
    // a chart drawing that gets a line escaping its own error bar.
    successProbabilityLow: cap(probabilityReachTarget * Math.min(hold, holdLow)),
    successProbabilityHigh: cap(probabilityReachTarget * Math.max(hold, holdHigh)),
    expectedSurvivors: survivors,
    projectedTargetMetOn: targetMetOn,
    projectedCompleteOn: completeOn,
    invitesNeeded,
    recommendedRosterSize: recommendRoster(input, rate, holdSurvivalFactor(input)),
    calibration: "default",
    method: "poisson_binomial_v1",
  };
}

/** The average per-tester chance of lasting the window — the drop-off half of the over-provisioning sum. */
function holdSurvivalFactor(input: ForecastInput): number {
  if (input.members.length === 0) return 1;
  const total = input.members.reduce(
    (sum, member) => sum + survivalOverDays(member.dailySurvival, Math.max(input.daysRemaining, 1)),
    0,
  );
  return Math.max(total / input.members.length, 0.01);
}

/**
 * The roster size that actually survives the window.
 *
 * "Carry twelve" is the advice that fails, because twelve is the number that must still be standing at
 * the end rather than the number to start with. Dividing the target by both the conversion rate and the
 * expected survival gives the number to start with — the answer to the question a developer is really
 * asking, which is "how many people do I need to ask?"
 */
function recommendRoster(input: ForecastInput, rate: number, survival: number): number {
  const raw = Math.ceil(input.targetSize / Math.max(survival, 0.01) / Math.max(rate, 0.01));
  return Math.min(input.maxRosterSize, Math.max(input.targetSize, raw));
}
