// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { hasPlatformDevice, type TesterActivity } from "../activity/resolve";
import { type DayKey, dayKey, daysBetween, daysSince } from "../clock/days";
import type { CohortClock } from "../clock/replay";
import type { TestersConfig } from "../config/config";
import type { TestersCohort } from "../data/cohort";
import type { TestersMember } from "../data/member";
import type { NudgeTally, TestersCohortSnapshot } from "../data/snapshot";
import { bandFor, type HealthResult, scoreHealth, survivalFor } from "../health/score";
import { type ForecastMember, forecastCohort, type PipelineMember } from "./forecast";
import { cohortAgeDays, conversionLatency, median } from "./inputs";
import { computeTrend, type TrendPoint } from "./trend";

/**
 * Composing one day's snapshot from every part: the clock, the activity, the health scores, the
 * forecast, and the trend.
 *
 * This is a pure function of its inputs. Everything that touches D1 — reading the events, resolving
 * activity against auth, upserting the row — lives in the Workflow that calls it. The separation is
 * what makes a snapshot testable against hand-built rosters rather than only against a database, and a
 * snapshot is the row the entire dashboard trend is drawn from, so it is worth being able to assert
 * exactly.
 */

/** One member, paired with whatever we could observe about them. */
export interface MemberReading {
  readonly member: TestersMember;
  readonly activity: TesterActivity;
}

/** Everything the builder needs for one cohort on one day. */
export interface BuildInput {
  readonly cohort: TestersCohort;
  readonly config: TestersConfig;
  readonly clock: CohortClock;
  readonly readings: readonly MemberReading[];
  /** Yesterday's snapshot, for the one-day deltas. */
  readonly yesterday: TrendPoint | null;
  /**
   * Whether yesterday's snapshot recorded the cohort at target.
   *
   * The persisted `resetToday` is computed against this rather than against the replayed previous day.
   * The replay's own `resetToday` is correct for a live read but wrong to store: the pass runs at 05:00,
   * so by the time it writes day D+1 the replay of day D already reflects the lapse, and the break gets
   * annotated on no snapshot at all. Comparing snapshot to snapshot catches it wherever in the day it
   * happened.
   */
  readonly yesterdayMetTarget: boolean | null;
  /** The snapshot from seven days ago, for the weekly deltas the trend rule reads. */
  readonly weekAgo: TrendPoint | null;
  /** How many snapshots this cohort has, including the one being built. */
  readonly snapshotCount: number;
  /** Nudges enqueued on this day, by kind. */
  readonly nudgesSent: NudgeTally;
  /** How many addresses were newly found unreachable today. */
  readonly bouncedCount: number;
  /** How many observed testers first went dark this week — for the trend sentence. */
  readonly newlyDarkCount: number;
  /** The moment the pass ran. */
  readonly now: Date;
}

/** A scored member: the reading, its health, and the survival prior it selects. */
interface ScoredMember extends MemberReading {
  readonly health: HealthResult;
  readonly dailySurvival: number;
}

/**
 * The most recent thing that proves a tester is still there.
 *
 * The dark clock floors at the opt-in date. Without that floor a tester who confirmed three hours ago
 * measures their darkness from the day they were invited and arrives reading as critical — opting in is
 * a GET on a public route and creates no session, so it leaves no authentication behind.
 *
 * One function because three places need the answer — the health score, the snapshot's darkness
 * histogram, and the live member view — and a row whose histogram and health score disagree about the
 * same tester is worse than either being wrong on its own.
 */
export function lastSignOfLife(reading: {
  member: { optedInAt: Date | null };
  activity: { lastAuthenticatedAt: Date | null };
}): Date | null {
  return [reading.activity.lastAuthenticatedAt, reading.member.optedInAt]
    .filter((date): date is Date => date !== null)
    .reduce<Date | null>((latest, date) => (latest === null || date > latest ? date : latest), null);
}

/** Score every member against the cohort's own rules. */
function scoreAll(input: BuildInput): ScoredMember[] {
  return input.readings.map((reading) => {
    const optedInAt = reading.member.optedInAt;
    const signOfLife = lastSignOfLife(reading);

    const health = scoreHealth(
      {
        observability: reading.activity.observability,
        daysDark:
          reading.activity.observability === "observed" && signOfLife !== null
            ? daysSince(signOfLife, input.now)
            : null,
        sessionsInWindow: reading.activity.sessionsInWindow,
        deviceCount: reading.activity.devices.length,
        hasTargetPlatformDevice: hasPlatformDevice(reading.activity, input.cohort.targetPlatform),
        sessionSinceOptIn:
          optedInAt !== null &&
          reading.activity.lastAuthenticatedAt !== null &&
          reading.activity.lastAuthenticatedAt >= optedInAt,
        unansweredNudges: reading.member.nudgeCount,
        daysSinceOptIn: optedInAt === null ? null : daysSince(optedInAt, input.now),
        targetPlatform: input.cohort.targetPlatform,
      },
      input.config.healthPenalties,
      input.config.healthCredits,
    );

    return {
      ...reading,
      health,
      dailySurvival: survivalFor(health.riskBand, reading.activity.observability, input.config.survival),
    };
  });
}

/** The median of a list, or null when it is empty. */
/** Build one day's snapshot. */
export function buildSnapshot(input: BuildInput): TestersCohortSnapshot {
  const scored = scoreAll(input);
  const today = dayKey(input.now);

  const optedIn = scored.filter((entry) => entry.member.state === "opted_in");
  const invited = scored.filter((entry) => entry.member.state === "invited");
  const accepted = scored.filter((entry) => entry.member.state === "accepted");
  const lapsed = scored.filter((entry) => entry.member.state === "lapsed" || entry.member.state === "removed");
  const unreachable = scored.filter((entry) => entry.member.unreachable);

  const observed = optedIn.filter((entry) => entry.activity.observability === "observed");
  const neverLinked = optedIn.filter((entry) => entry.activity.state === "never_linked");
  const coverage = optedIn.length === 0 ? 0 : observed.length / optedIn.length;

  // The same floor `scoreAll` and `memberView` apply, and it has to be the same or the row disagrees
  // with itself. Opting in is a GET on a public route and creates no session, so any tester whose
  // confirmation is more recent than their last sign-in reads as long-dark to the histogram while the
  // health score on the same row scores them as barely penalized.
  const darkDays = (entry: ScoredMember): number | null => {
    if (entry.activity.observability !== "observed" || !entry.activity.lastAuthenticatedAt) return null;
    return daysSince(lastSignOfLife(entry) ?? entry.activity.lastAuthenticatedAt, input.now);
  };

  const scores = observed.map((entry) => entry.health.health).filter((health): health is number => health !== null);

  const forecastMembers: ForecastMember[] = optedIn.map((entry) => ({
    riskBand: entry.health.riskBand,
    observability: entry.activity.observability,
    dailySurvival: entry.dailySurvival,
  }));

  const pipeline: PipelineMember[] = [...invited, ...accepted].map((entry) => ({
    stage: entry.member.state === "accepted" ? "accepted" : "invited",
    unreachable: entry.member.unreachable,
  }));

  const latency = conversionLatency(scored.map((entry) => entry.member));

  const forecast = forecastCohort({
    today,
    targetSize: input.cohort.targetSize,
    optedInCount: input.clock.estimatedOptedInCount,
    daysRemaining: input.clock.estimatedDaysRemaining,
    members: forecastMembers,
    pipeline,
    optedInEver: scored.filter((entry) => entry.member.optedInAt !== null).length,
    invitedEver: scored.length,
    medianConversionDays: latency.medianConversionDays,
    conversionSampleSize: latency.conversionSampleSize,
    cohortAgeDays: cohortAgeDays(input.cohort.createdAt, today),
    maxRosterSize: input.cohort.maxRosterSize,
  });

  const weakMemberCount = optedIn.filter(
    (entry) => entry.health.riskBand === "at_risk" || entry.health.riskBand === "critical",
  ).length;

  const trend = computeTrend({
    today: {
      estimatedOptedInCount: input.clock.estimatedOptedInCount,
      activeCount: observed.filter((entry) => entry.activity.state === "active").length,
      successProbability: forecast.successProbability,
    },
    yesterday: input.yesterday,
    weekAgo: input.weekAgo,
    snapshotCount: input.snapshotCount,
    atTargetWithNoHeadroom: input.clock.meetsTarget && input.clock.headroom === 0,
    weakMemberCount,
    newlyDarkCount: input.newlyDarkCount,
  });

  const inBand = (low: number, high: number) =>
    observed.filter((entry) => {
      const days = darkDays(entry);
      return days !== null && days >= low && days <= high;
    }).length;

  const snapshotOn: DayKey = today;

  return {
    id: 0,
    cohortId: input.cohort.id,
    snapshotOn,
    dayIndex: Math.max(0, daysBetween(dayKey(input.cohort.createdAt), snapshotOn)),
    computedAt: input.now,
    // A pass writing a day that has already ended is a replay or a catch-up. The opt-in figures are
    // still exact — they replay from events — but the activity figures are whatever survived, so a
    // chart must render the point dashed rather than treat it as a measurement.
    backfilled: false,
    modelVersion: input.config.modelVersion,

    rosterSize: scored.length,
    invitedCount: invited.length,
    acceptedCount: accepted.length,
    estimatedOptedInCount: input.clock.estimatedOptedInCount,
    lapsedCount: lapsed.length,
    unreachableCount: unreachable.length,

    targetSize: input.cohort.targetSize,
    windowDays: input.cohort.windowDays,
    meetsTarget: input.clock.meetsTarget,
    headroom: input.clock.headroom,
    estimatedHeldDays: input.clock.estimatedHeldDays,
    estimatedWindowStartOn: input.clock.estimatedWindowStartOn,
    estimatedDaysRemaining: input.clock.estimatedDaysRemaining,
    resetCount: input.clock.resetCount,
    // Snapshot-to-snapshot, not replay-to-replay. See `yesterdayMetTarget` for why.
    resetToday:
      input.yesterdayMetTarget === null ? input.clock.resetToday : input.yesterdayMetTarget && !input.clock.meetsTarget,

    observedCount: observed.length,
    neverLinkedCount: neverLinked.length,
    observedCoverage: coverage,
    activeCount: observed.filter((entry) => entry.activity.state === "active").length,
    darkThreeToSevenCount: inBand(3, 7),
    darkEightToThirteenCount: inBand(8, 13),
    darkFourteenPlusCount: inBand(14, Number.POSITIVE_INFINITY),
    sessionsInWindow: scored.reduce((sum, entry) => sum + entry.activity.sessionsInWindow, 0),
    targetPlatformDeviceCount: scored.filter((entry) => hasPlatformDevice(entry.activity, input.cohort.targetPlatform))
      .length,

    healthyCount: scores.filter((score) => bandFor(score) === "healthy").length,
    watchCount: scores.filter((score) => bandFor(score) === "watch").length,
    atRiskCount: scores.filter((score) => bandFor(score) === "at_risk").length,
    criticalCount: scores.filter((score) => bandFor(score) === "critical").length,
    unknownHealthCount: optedIn.length - observed.length,
    medianHealth: median(scores),
    // The minimum, not just the median: a twelve-of-twelve cohort breaks at its weakest link, so the
    // worst tester is more informative than the typical one.
    minHealth: scores.length === 0 ? null : Math.min(...scores),

    expectedSurvivors: forecast.expectedSurvivors,
    probabilityReachTarget: forecast.probabilityReachTarget,
    probabilityHoldWindow: forecast.probabilityHoldWindow,
    successProbability: forecast.successProbability,
    successProbabilityLow: forecast.successProbabilityLow,
    successProbabilityHigh: forecast.successProbabilityHigh,
    confidence: forecast.confidence,
    basis: forecast.basis,
    projectedTargetMetOn: forecast.projectedTargetMetOn,
    projectedCompleteOn: forecast.projectedCompleteOn,
    invitesNeeded: forecast.invitesNeeded,
    recommendedRosterSize: forecast.recommendedRosterSize,

    optedInDelta1d: trend.optedInDelta1d,
    optedInDelta7d: trend.optedInDelta7d,
    activeDelta7d: trend.activeDelta7d,
    successProbabilityDelta1d: trend.successProbabilityDelta1d,
    successProbabilityDelta7d: trend.successProbabilityDelta7d,
    trendDirection: trend.direction,
    fragile: trend.fragile,
    trendReason: trend.reason,

    nudgesSent: input.nudgesSent,
    bouncedCount: input.bouncedCount,
  };
}
