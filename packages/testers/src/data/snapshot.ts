// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { SQLiteBoolean, SQLiteDate, sqliteJson } from "@pithy-sh/core/src/data/codecs";
import { z } from "zod";
import { ProjectionBasis, ProjectionConfidence, TrendDirection } from "./enums";

/** A day-key: `YYYY-MM-DD`, UTC. */
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** How many nudges of each kind went out on one day. */
export const NudgeTally = z
  .object({
    confirm: z.number().int().describe("Will-you-test nudges enqueued on this day — the first email of the two."),
    store: z
      .number()
      .int()
      .describe(
        "Store-link nudges enqueued on this day — the second email, and the only one that can move the opt-in count, because it is the one carrying the link that joins the test.",
      ),
    inactive: z.number().int().describe("You-have-not-opened-the-app nudges enqueued on this day."),
    closing: z.number().int().describe("The-window-is-closing nudges enqueued on this day."),
  })
  .describe("Nudges enqueued on this day, by kind, so send volume can be charted against the health series.");
export type NudgeTally = z.output<typeof NudgeTally>;

/**
 * One day of a cohort's position — the row in `pithy_testers_cohort_snapshots`, and the chartable
 * record the whole dashboard trend is drawn from.
 *
 * **Why a snapshot table exists at all, when everything in it is derivable.** Two reasons, and the
 * second is the load-bearing one. First, cost: a summary card should be one row, not a replay of every
 * event plus a join against auth. Second, and more important, **activity is not derivable
 * retroactively**. Sessions expire and rotate, devices are re-registered, and a tester who was quiet on
 * the 9th but active on the 11th leaves no trace on the 12th that they were ever quiet. The opt-in
 * clock can always be replayed; the early-warning signal cannot. If it is not written down on the day,
 * it is gone — which is exactly why the darkness histogram, the thing that moves *before* the opt-in
 * count does, has to be captured daily rather than computed on read.
 *
 * **Every field is one of two kinds and the names say which.** Anything prefixed `estimated` is Pithy's
 * replay of its own invite records — its best guess at a figure Google computes and exposes through no
 * API. Everything under the activity block is observed fact from `@pithy-sh/auth`. A field that blurred
 * the two would be the single most damaging thing this package could ship, because a developer reading
 * `heldDays: 13` and planning to apply for production access tomorrow is making a decision on it.
 *
 * The day key is UTC and stored as `YYYY-MM-DD` **text**, not a timestamp: day arithmetic and the
 * unique index are then exact, with no timezone in the query. Google's own day boundary is undocumented
 * and may not be ours, which is one more reason day fourteen is the wrong day to start trusting this.
 */
export const TestersCohortSnapshot = z
  .object({
    id: z
      .number()
      .int()
      .describe("Primary key, auto-incrementing. Internal — a snapshot is addressed by cohort and day."),
    cohortId: z.string().describe("The cohort this snapshot describes. Unique with `snapshotOn`."),
    snapshotOn: z
      .string()
      .regex(DAY_KEY)
      .describe("The UTC day this snapshot covers, `YYYY-MM-DD`. The chart's x-axis, and half of the row's identity."),
    dayIndex: z
      .number()
      .int()
      .describe("Days since the cohort was created — a zero-based x-axis, so two cohorts can be overlaid."),
    computedAt: SQLiteDate.describe("When the daily pass computed this row."),
    backfilled: SQLiteBoolean.describe(
      "True when this row was written after its day had already passed — a missed run, or a replay. Charts must render a backfilled point dashed: the opt-in figures are still exact, but the activity figures were reconstructed from whatever survived, and are therefore a floor rather than a measurement.",
    ),
    modelVersion: z
      .string()
      .describe(
        "The survival and health constant set that produced this row's forecast. A trend line silently spanning two model versions is a lie; the chart annotates where it changes.",
      ),

    // — roster composition: a stacked area falls out of these five —
    rosterSize: z.number().int().describe("Members on the roster on this day, in every state."),
    invitedCount: z.number().int().describe("Invited, and have not yet answered the first email."),
    acceptedCount: z.number().int().describe("Agreed to test on this day, and waiting for the store link."),
    estimatedOptedInCount: z
      .number()
      .int()
      .describe(
        "PITHY'S ESTIMATE of how many testers were opted in on this day, replayed from the confirmation-link records. Google's authoritative count is not readable by any API.",
      ),
    lapsedCount: z.number().int().describe("Explicitly opted out or removed. Never written by inactivity."),
    unreachableCount: z
      .number()
      .int()
      .describe("Hard-bounced or suppressed in `@pithy-sh/email` — we cannot even nudge them."),

    // — the clock, entirely Pithy's estimate —
    targetSize: z
      .number()
      .int()
      .describe("The target in force on this day, denormalized so a later change cannot rewrite history."),
    windowDays: z.number().int().describe("The window in force on this day, denormalized for the same reason."),
    meetsTarget: SQLiteBoolean.describe("Whether the estimated opted-in count reached the target on this day."),
    headroom: z
      .number()
      .int()
      .describe(
        "Estimated opted-in count minus target. Charts as a signed series where zero is the danger line, and it can go negative.",
      ),
    estimatedHeldDays: z
      .number()
      .int()
      .describe(
        "Pithy's estimate of the unbroken run of at-target days ending on this day. The number Play Console shows, as far as we can infer it.",
      ),
    estimatedWindowStartOn: z
      .string()
      .regex(DAY_KEY)
      .nullable()
      .describe("The UTC day the current run began, or null while below target."),
    estimatedDaysRemaining: z
      .number()
      .int()
      .describe("Window days still to hold, on Pithy's estimate, floored at zero."),
    resetCount: z
      .number()
      .int()
      .describe(
        "How many times the run has broken since the cohort started. Scar tissue, and it belongs on the chart.",
      ),
    resetToday: SQLiteBoolean.describe(
      "Whether the run broke on this day — the single most important annotation a cohort chart can carry.",
    ),

    // — activity: observed fact from @pithy-sh/auth —
    observedCount: z
      .number()
      .int()
      .describe("Opted-in members whose address matched a user with at least one session or device."),
    neverLinkedCount: z
      .number()
      .int()
      .describe(
        "Opted-in members whose invited address never matched a user. They still count toward the target — an app whose test flow needs no sign-in produces nothing else — and they must render differently from inactive.",
      ),
    observedCoverage: z
      .number()
      .min(0)
      .max(1)
      .describe(
        "Observed count over opted-in count, 0–1. The honest denominator behind every forecast number on this row.",
      ),
    activeCount: z.number().int().describe("Observed members who authenticated inside the cohort's active window."),
    darkThreeToSevenCount: z.number().int().describe("Observed members quiet 3–7 days. The first leading indicator."),
    darkEightToThirteenCount: z
      .number()
      .int()
      .describe("Observed members quiet 8–13 days. The strongest silent-uninstall signal."),
    darkFourteenPlusCount: z.number().int().describe("Observed members quiet 14 days or more."),
    sessionsInWindow: z.number().int().describe("Total sessions across the cohort inside the trailing window."),
    targetPlatformDeviceCount: z
      .number()
      .int()
      .describe("Members with at least one registered device on the cohort's target platform."),

    // — health distribution —
    healthyCount: z.number().int().describe("Observed members scoring 80–100."),
    watchCount: z.number().int().describe("Observed members scoring 60–79."),
    atRiskCount: z.number().int().describe("Observed members scoring 30–59."),
    criticalCount: z.number().int().describe("Observed members scoring 0–29."),
    unknownHealthCount: z.number().int().describe("Members with no score at all — unobservable or unreachable."),
    medianHealth: z
      .number()
      .int()
      .nullable()
      .describe("Median health across observed members, or null when none are observed."),
    minHealth: z
      .number()
      .int()
      .nullable()
      .describe(
        "The weakest observed member's score, or null. A twelve-of-twelve cohort breaks at its weakest link, so the minimum matters more than the mean.",
      ),

    // — the forecast, as of this day —
    expectedSurvivors: z
      .number()
      .describe(
        "Sum of each opted-in tester's chance of lasting the remaining days — 'we expect 11.3 of your 14 to still be in'.",
      ),
    probabilityReachTarget: z.number().describe("Chance of reaching the target at all. One when already there."),
    probabilityHoldWindow: z
      .number()
      .nullable()
      .describe(
        "Chance at least `targetSize` testers hold for the remaining days. Null when nothing about the cohort is observable.",
      ),
    successProbability: z
      .number()
      .min(0)
      .max(1)
      .nullable()
      .describe(
        "PITHY'S ESTIMATE of completing the window: reach times hold. Capped below one — nothing is certain until Google says so, and Google is not talking. Null when there is no observable signal at all.",
      ),
    successProbabilityLow: z
      .number()
      .min(0)
      .max(1)
      .nullable()
      .describe("The pessimistic bound, treating every unobservable tester as fragile."),
    successProbabilityHigh: z
      .number()
      .min(0)
      .max(1)
      .nullable()
      .describe("The optimistic bound, treating every unobservable tester as solid."),
    confidence: ProjectionConfidence.nullable().describe("How much to trust the forecast. Null when coverage is zero."),
    basis: ProjectionBasis.describe("Why the forecast reads as it does, and why any null on this row is null."),
    projectedTargetMetOn: z
      .string()
      .regex(DAY_KEY)
      .nullable()
      .describe("Projected UTC day the cohort first reaches target, or null with a basis."),
    projectedCompleteOn: z
      .string()
      .regex(DAY_KEY)
      .nullable()
      .describe("Projected UTC day the window completes, or null with a basis."),
    invitesNeeded: z
      .number()
      .int()
      .describe(
        "How many more people to invite to close the gap at the observed conversion rate. Zero when at target. Worth more to a developer than the probability next to it.",
      ),
    recommendedRosterSize: z
      .number()
      .int()
      .describe(
        "The roster size that survives the window at this cohort's own conversion and drop-off rates. The over-provisioning answer.",
      ),

    // — the trend, precomputed so one row renders a whole card —
    optedInDelta1d: z
      .number()
      .int()
      .nullable()
      .describe("Change in the estimated opted-in count since yesterday. Null without a prior snapshot."),
    optedInDelta7d: z
      .number()
      .int()
      .nullable()
      .describe("Change over seven days. Null without a snapshot seven days back."),
    activeDelta7d: z
      .number()
      .int()
      .nullable()
      .describe("Change in the active count over seven days — engagement's direction."),
    successProbabilityDelta1d: z.number().nullable().describe("Change in the forecast since yesterday."),
    successProbabilityDelta7d: z
      .number()
      .nullable()
      .describe("Change in the forecast over seven days. The trend rule's primary input."),
    trendDirection: TrendDirection.describe(
      "Improving, steady, declining, or unknown — by a published rule, not a fit.",
    ),
    fragile: SQLiteBoolean.describe(
      "At target, with zero headroom, and at least one at-risk or critical member: one lapse from a reset. Deliberately not a trend direction — a cohort can be improving and fragile at once, and collapsing them loses the more urgent of the two.",
    ),
    trendReason: z
      .string()
      .describe(
        "One brand-voice sentence explaining the direction, for rendering beside the arrow. E.g. `Two testers went dark this week.`",
      ),

    // — operations —
    nudgesSent: sqliteJson(NudgeTally).describe(
      "Nudges enqueued on this day, by kind. Overlays the health series so an intervention can be read against its effect.",
    ),
    bouncedCount: z.number().int().describe("Addresses newly found unreachable on this day."),
  })
  .describe(
    "One day of a cohort's position in `pithy_testers_cohort_snapshots` — the chartable trend record the daily pass writes. Every opt-in figure here is Pithy's estimate from its own invite records; every activity figure is observed fact.",
  );
export type TestersCohortSnapshot = z.output<typeof TestersCohortSnapshot>;
export type TestersCohortSnapshotRow = z.input<typeof TestersCohortSnapshot>;
