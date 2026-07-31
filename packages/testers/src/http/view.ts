// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { hasPlatformDevice } from "../activity/resolve";
import { dayKey, daysSince } from "../clock/days";
import type { TestersConfig } from "../config/config";
import type { TestersCohortSnapshot } from "../data/snapshot";
import { scoreHealth, survivalFor } from "../health/score";
import { cooldownUntil } from "../nudge/cooldown";
import type { MemberReading } from "../projection/build";
import { type ForecastMember, forecastCohort, type PipelineMember } from "../projection/forecast";
import { cohortAgeDays, conversionLatency } from "../projection/inputs";
import type { CohortReading } from "../roster/read";
import { LIVE_STATES } from "../roster/write";
import { type CohortView, DISCLAIMER, type MemberView, type SnapshotView, type TrendView } from "./responses";

/**
 * Turning a cohort reading into the shape a dashboard receives.
 *
 * The one rule this file exists to enforce is the separation the response schema declares: the
 * estimated half and the observed half go into different objects, each carrying a literal `source`, and
 * the disclaimer is attached unconditionally rather than by any code path that could be missed. There
 * is no branch here that produces a cohort without it.
 */

/** An ISO string, or null. */
function iso(date: Date | null | undefined): string | null {
  return date ? date.toISOString() : null;
}

/** Build one tester's view, health included. */
function memberView(
  reading: MemberReading,
  cohortReading: CohortReading,
  config: TestersConfig,
  now: Date,
): MemberView {
  const { member, activity } = reading;
  const optedInAt = member.optedInAt;

  // The dark clock floors at the opt-in date, so a tester who confirmed this morning reads as fresh
  // rather than as however long ago they were first invited.
  const lastSignOfLife = [activity.lastAuthenticatedAt, optedInAt]
    .filter((date): date is Date => date !== null)
    .reduce<Date | null>((latest, date) => (latest === null || date > latest ? date : latest), null);

  const daysDark =
    activity.observability === "observed" && lastSignOfLife !== null ? daysSince(lastSignOfLife, now) : null;

  const health = scoreHealth(
    {
      observability: activity.observability,
      daysDark,
      sessionsInWindow: activity.sessionsInWindow,
      deviceCount: activity.devices.length,
      hasTargetPlatformDevice: hasPlatformDevice(activity, cohortReading.cohort.targetPlatform),
      sessionSinceOptIn:
        optedInAt !== null && activity.lastAuthenticatedAt !== null && activity.lastAuthenticatedAt >= optedInAt,
      unansweredNudges: member.nudgeCount,
      daysSinceOptIn: optedInAt === null ? null : daysSince(optedInAt, now),
      targetPlatform: cohortReading.cohort.targetPlatform,
    },
    config.healthPenalties,
    config.healthCredits,
  );

  return {
    id: member.id,
    email: member.email,
    name: member.name,
    state: member.state,
    invitedAt: member.invitedAt.toISOString(),
    acceptedAt: iso(member.acceptedAt),
    estimatedOptedInAt: iso(member.optedInAt),
    lapsedAt: iso(member.lapsedAt),
    estimatedOptInDays: optedInAt === null ? 0 : daysSince(optedInAt, now),
    activity: {
      source: "observed",
      observability: activity.observability,
      state: activity.state,
      lastAuthenticatedAt: iso(activity.lastAuthenticatedAt),
      // Only an `inactive` tester has a "since". A never-linked one has no date to report, and
      // inventing one would erase the distinction the whole activity model turns on.
      inactiveSince: activity.state === "inactive" ? iso(activity.lastAuthenticatedAt) : null,
      daysDark,
      sessionsInWindow: activity.sessionsInWindow,
      devices: activity.devices.map((device) => ({
        platform: device.platform,
        lastSeenAt: device.lastSeenAt.toISOString(),
        appVersion: device.appVersion,
      })),
    },
    health: health.health,
    healthBasis: health.basis,
    riskBand: health.riskBand,
    dailySurvival: survivalFor(health.riskBand, activity.observability, config.survival),
    factors: health.factors.map((factor) => ({ ...factor })),
    lastNudgedAt: iso(member.lastNudgedAt),
    nudgeCooldownUntil: iso(cooldownUntil(member, config.nudges.cooldownHours)),
    unreachable: member.unreachable,
  };
}

/** Project a stored snapshot into the chart's point shape. */
export function snapshotView(snapshot: TestersCohortSnapshot): SnapshotView {
  return {
    snapshotOn: snapshot.snapshotOn,
    dayIndex: snapshot.dayIndex,
    backfilled: snapshot.backfilled,
    modelVersion: snapshot.modelVersion,
    rosterSize: snapshot.rosterSize,
    invitedCount: snapshot.invitedCount,
    acceptedCount: snapshot.acceptedCount,
    estimatedOptedInCount: snapshot.estimatedOptedInCount,
    lapsedCount: snapshot.lapsedCount,
    targetSize: snapshot.targetSize,
    meetsTarget: snapshot.meetsTarget,
    headroom: snapshot.headroom,
    estimatedHeldDays: snapshot.estimatedHeldDays,
    estimatedDaysRemaining: snapshot.estimatedDaysRemaining,
    resetToday: snapshot.resetToday,
    resetCount: snapshot.resetCount,
    activeCount: snapshot.activeCount,
    darkThreeToSevenCount: snapshot.darkThreeToSevenCount,
    darkEightToThirteenCount: snapshot.darkEightToThirteenCount,
    darkFourteenPlusCount: snapshot.darkFourteenPlusCount,
    neverLinkedCount: snapshot.neverLinkedCount,
    observedCoverage: snapshot.observedCoverage,
    medianHealth: snapshot.medianHealth,
    minHealth: snapshot.minHealth,
    successProbability: snapshot.successProbability,
    successProbabilityLow: snapshot.successProbabilityLow,
    successProbabilityHigh: snapshot.successProbabilityHigh,
    expectedSurvivors: snapshot.expectedSurvivors,
    invitesNeeded: snapshot.invitesNeeded,
    trendDirection: snapshot.trendDirection,
    trendReason: snapshot.trendReason,
    fragile: snapshot.fragile,
    nudgesSent: snapshot.nudgesSent,
  };
}

/** What the view needs beyond the reading itself. */
export interface ViewOptions {
  readonly includeMembers: boolean;
  /** Trailing snapshots, oldest first. Empty when the trend was not requested. */
  readonly snapshots: readonly TestersCohortSnapshot[];
  /** The most recent snapshot, whether or not the series was requested — it carries the precomputed trend. */
  readonly latest: TestersCohortSnapshot | undefined;
}

/** Assemble the cohort view a dashboard receives. */
export function toCohortView(
  reading: CohortReading,
  config: TestersConfig,
  options: ViewOptions,
  now: Date,
): CohortView {
  const { cohort, clock, readings } = reading;

  const members = readings.map((entry) => memberView(entry, reading, config, now));
  const byState = (state: string) => members.filter((member) => member.state === state).length;
  const optedIn = members.filter((member) => member.state === "opted_in");
  const observed = optedIn.filter((member) => member.activity.observability === "observed");

  const today = dayKey(now);
  const forecast = forecastCohort({
    today,
    targetSize: cohort.targetSize,
    optedInCount: clock.estimatedOptedInCount,
    daysRemaining: clock.estimatedDaysRemaining,
    members: optedIn.map(
      (member): ForecastMember => ({
        riskBand: member.riskBand,
        observability: member.activity.observability,
        dailySurvival: member.dailySurvival,
      }),
    ),
    pipeline: members
      .filter((member) => member.state === "invited" || member.state === "accepted")
      .map(
        (member): PipelineMember => ({
          stage: member.state === "accepted" ? "accepted" : "invited",
          unreachable: member.unreachable,
        }),
      ),
    optedInEver: members.filter((member) => member.estimatedOptedInAt !== null).length,
    invitedEver: members.length,
    // Derived exactly as `buildSnapshot` derives them. Hardcoding `null`/`0` here could never clear the
    // forecast's five-conversion evidence gate, so every live read used the default three-day prior
    // even for a cohort with a hundred measured conversions — while the snapshot written the same
    // morning used the real one, and the two projected different completion dates.
    ...conversionLatency(readings.map((entry) => entry.member)),
    cohortAgeDays: cohortAgeDays(cohort.createdAt, today),
    maxRosterSize: cohort.maxRosterSize,
  });

  const weakMemberCount = optedIn.filter(
    (member) => member.riskBand === "at_risk" || member.riskBand === "critical",
  ).length;

  const latest = options.latest;
  const trend: TrendView = {
    // The direction comes off the stored snapshot rather than being recomputed here: the deltas it
    // needs are historical, and recomputing them on read would give a card and a chart two different
    // answers to the same question.
    direction: latest?.trendDirection ?? "unknown",
    reason: latest?.trendReason ?? "Not enough history yet.",
    // All three conjuncts, matching `computeTrend` and both schema descriptions: at target, no
    // headroom, AND at least one weak tester. Dropping the third made a twelve-of-twelve cohort of
    // entirely healthy testers raise "One lapse from a reset." until its first snapshot landed, at
    // which point the warning vanished with nothing about the cohort having changed.
    fragile: latest?.fragile ?? (clock.meetsTarget && clock.headroom === 0 && weakMemberCount > 0),
    optedInDelta1d: latest?.optedInDelta1d ?? null,
    optedInDelta7d: latest?.optedInDelta7d ?? null,
    activeDelta7d: latest?.activeDelta7d ?? null,
    successProbabilityDelta7d: latest?.successProbabilityDelta7d ?? null,
    series: options.snapshots.map(snapshotView),
  };

  return {
    id: cohort.id,
    name: cohort.name,
    targetPlatform: cohort.targetPlatform,
    targetSize: cohort.targetSize,
    windowDays: cohort.windowDays,
    maxRosterSize: cohort.maxRosterSize,
    resetPolicy: cohort.resetPolicy,
    createdAt: cohort.createdAt.toISOString(),
    closedAt: iso(cohort.closedAt),

    roster: {
      size: members.length,
      // Counted against the same live states `inviteMember` enforces the cap on. Counting `lapsed`
      // members as occupying slots reported no room when an invitation would in fact have succeeded.
      headroomToMax: Math.max(0, cohort.maxRosterSize - members.filter((m) => LIVE_STATES.includes(m.state)).length),
      invited: byState("invited"),
      accepted: byState("accepted"),
      optedIn: optedIn.length,
      lapsed: byState("lapsed") + byState("removed"),
      unreachable: members.filter((member) => member.unreachable).length,
      neverLinked: optedIn.filter((member) => member.activity.state === "never_linked").length,
    },

    estimatedClock: {
      source: "pithy_estimate",
      meetsTarget: clock.meetsTarget,
      headroom: clock.headroom,
      estimatedHeldDays: clock.estimatedHeldDays,
      estimatedDaysRemaining: clock.estimatedDaysRemaining,
      estimatedWindowStartOn: clock.estimatedWindowStartOn,
      resetCount: clock.resetCount,
      dayBoundary: "UTC",
    },

    activity: {
      source: "observed",
      active: observed.filter((member) => member.activity.state === "active").length,
      darkThreeToSeven: observed.filter(
        (m) => m.activity.daysDark !== null && m.activity.daysDark >= 3 && m.activity.daysDark <= 7,
      ).length,
      darkEightToThirteen: observed.filter(
        (m) => m.activity.daysDark !== null && m.activity.daysDark >= 8 && m.activity.daysDark <= 13,
      ).length,
      darkFourteenPlus: observed.filter((m) => m.activity.daysDark !== null && m.activity.daysDark >= 14).length,
      neverLinked: optedIn.filter((member) => member.activity.state === "never_linked").length,
      observedCoverage: optedIn.length === 0 ? 0 : observed.length / optedIn.length,
    },

    projection: {
      basis: forecast.basis,
      calibration: forecast.calibration,
      method: forecast.method,
      confidence: forecast.confidence,
      observedCoverage: forecast.observedCoverage,
      probabilityReachTarget: forecast.probabilityReachTarget,
      probabilityHoldWindow: forecast.probabilityHoldWindow,
      successProbability: forecast.successProbability,
      successProbabilityRange:
        forecast.successProbabilityLow === null || forecast.successProbabilityHigh === null
          ? null
          : { low: forecast.successProbabilityLow, high: forecast.successProbabilityHigh },
      expectedSurvivors: forecast.expectedSurvivors,
      projectedTargetMetOn: forecast.projectedTargetMetOn,
      projectedCompleteOn: forecast.projectedCompleteOn,
      invitesNeeded: forecast.invitesNeeded,
      recommendedRosterSize: forecast.recommendedRosterSize,
    },

    trend,

    reconciliation: {
      supported: false,
      lastReconciledAt: null,
      reason:
        "The Google Play Developer API exposes no tester roster, no opt-in count, and no opt-out signal, so there is nothing to reconcile against.",
    },

    // Unconditional. There is no code path here that returns a cohort without it, which is the point:
    // a note in the docs is advice, and a required field is a fact about the wire format.
    disclaimer: DISCLAIMER,
    ...(options.includeMembers ? { members } : {}),
  };
}
