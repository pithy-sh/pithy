// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import {
  ActivityState,
  MemberState,
  Observability,
  ProjectionBasis,
  ProjectionConfidence,
  RiskBand,
  TrendDirection,
} from "../data/enums";

/**
 * What a dashboard receives — and the structure that keeps it honest.
 *
 * **The honesty guardrails here are structural rather than advisory, and that is the whole point.** It
 * is not enough to write "this is an estimate" in the docs, because the person who reads the docs and
 * the person who writes `cohort.heldDays >= 14 && applyForProduction()` are the same person on
 * different days. So:
 *
 * - Every figure derived from opt-in records is named `estimated*`. `estimatedHeldDays: 9` reads as a
 *   claim about our own records; `optInStreak: 9` reads as a fact about Google, and the difference is
 *   a refund.
 * - The estimated half and the observed half are **separate objects with literal `source`
 *   discriminators**, so a developer destructuring `cohort.estimatedClock` cannot reach the number
 *   without typing the word `estimated`.
 * - `disclaimer` is **required and non-nullable**, on the cohort and on the envelope, so the common
 *   "spread the object into a card component" path still carries it.
 * - `successProbability` is **nullable**, so "we do not know" is representable and never has to be
 *   faked as a plausible 0.5.
 * - `reconciliation` is present, `supported: false`, with the reason — because "we checked and cannot"
 *   and "we never thought about it" are different facts, and an absent field says the second.
 */

/** The sentence, verbatim, that must appear wherever an opt-in figure appears. */
export const ESTIMATE_STATEMENT =
  "Pithy's count is an estimate from your own invite records. Google's count is authoritative and no API exposes it.";

/** The named ways Pithy's count can drift from Google's. */
export const DivergenceRisk = z
  .enum(["silent_opt_out", "opt_in_outside_pithy", "uninstall", "day_boundary_mismatch", "reset_policy_assumed"])
  .describe(
    "A named, enumerated reason Pithy's estimate can differ from Google's authoritative count. Enumerated rather than prose so a dashboard can render each one and none can be quietly dropped.",
  );
export type DivergenceRisk = z.output<typeof DivergenceRisk>;

/** The disclosure that travels with every opt-in figure. Required everywhere, always. */
export const EstimateDisclaimer = z
  .object({
    authority: z.literal("google_play_console").describe("Who owns the number that actually decides this. Not us."),
    readable: z
      .literal(false)
      .describe(
        "Always false. No Google API exposes the opt-in count or the continuous-day streak, so Pithy cannot read it.",
      ),
    source: z
      .literal("pithy_invite_records")
      .describe("What Pithy's figure is derived from: our own invitation and confirmation records, and nothing else."),
    statement: z.string().min(1).describe("The sentence a dashboard must render beside any opt-in figure."),
    divergenceRisks: z
      .array(DivergenceRisk)
      .min(1)
      .describe(
        "Why the two can differ. Never empty — there is always at least a silent opt-out and an assumed reset policy.",
      ),
  })
  .describe(
    "Required on every cohort and on the envelope. A dashboard that spreads the cohort object cannot accidentally drop it.",
  );
export type EstimateDisclaimer = z.output<typeof EstimateDisclaimer>;

/** The disclaimer value, built once. */
export const DISCLAIMER: EstimateDisclaimer = {
  authority: "google_play_console",
  readable: false,
  source: "pithy_invite_records",
  statement: ESTIMATE_STATEMENT,
  divergenceRisks: [
    "silent_opt_out",
    "opt_in_outside_pithy",
    "uninstall",
    "day_boundary_mismatch",
    "reset_policy_assumed",
  ],
};

/** One term of a health score, so the number is auditable rather than asserted. */
export const HealthFactorView = z
  .object({
    code: z.string().describe("A stable identifier for this term, e.g. `dark_8_10`. Safe for a UI to key off."),
    points: z
      .number()
      .int()
      .describe("The signed contribution to the score. Penalties are negative, credits positive."),
    reason: z.string().describe("One sentence explaining this factor to a developer."),
  })
  .describe("One term of a tester's health score.");
export type HealthFactorView = z.output<typeof HealthFactorView>;

/** One registered device, as the roster reports it. */
export const DeviceView = z
  .object({
    platform: z.enum(["ios", "android", "web"]).describe("The device platform, from the auth device registry."),
    lastSeenAt: z.iso.datetime().describe("When this device was last seen signing in."),
    appVersion: z.string().nullable().describe("The client app version at that sign-in, or null."),
  })
  .describe("One device registered to a tester.");
export type DeviceView = z.output<typeof DeviceView>;

/** The observed half of a tester: fact, read from `@pithy-sh/auth`. */
export const TesterActivityView = z
  .object({
    source: z.literal("observed").describe("This block is fact read from the auth tables. It is not an estimate."),
    observability: Observability.describe("Whether we can see this tester at all, and why not when we cannot."),
    state: ActivityState.describe(
      "What the activity says. `never_linked` must render differently from `inactive`: one is a tester drifting away, the other may simply be an app that never asks anyone to sign in.",
    ),
    lastAuthenticatedAt: z.iso
      .datetime()
      .nullable()
      .describe("The most recent sign of life, or null when never linked."),
    inactiveSince: z.iso
      .datetime()
      .nullable()
      .describe(
        "Set only when the state is `inactive`. Null for `never_linked`, because there is no 'since' to report.",
      ),
    daysDark: z
      .number()
      .int()
      .nullable()
      .describe("Days since the last sign of life, floored at their opt-in date. Null when never linked."),
    sessionsInWindow: z
      .number()
      .int()
      .describe("Sessions inside the cohort's window. Zero for a tester we cannot see."),
    devices: z.array(DeviceView).describe("Registered devices, most recently seen first."),
  })
  .describe("The observed half of a tester — kept a separate object from the estimated half, by design.");
export type TesterActivityView = z.output<typeof TesterActivityView>;

/** One tester on a roster. */
export const MemberView = z
  .object({
    id: z.string().describe("The member id. Opaque and server-generated."),
    email: z.string().describe("The invited address — the join key to the user record if they ever sign in."),
    name: z.string().nullable().describe("The display name the developer supplied, or null."),
    state: MemberState.describe("Roster state, replayed from the event log. Never written by inactivity."),
    invitedAt: z.iso.datetime().describe("When the first invitation was sent."),
    acceptedAt: z.iso
      .datetime()
      .nullable()
      .describe("When they answered the first email agreeing to test, or null. A tap on a link, needing no account."),
    estimatedOptedInAt: z.iso
      .datetime()
      .nullable()
      .describe(
        "When they followed Pithy's confirmation link. OUR record that they clicked our link — not evidence Google recorded an opt-in.",
      ),
    lapsedAt: z.iso
      .datetime()
      .nullable()
      .describe("When they opted out or were removed, or null. Written only by an explicit act."),
    estimatedOptInDays: z
      .number()
      .int()
      .describe("Days since they confirmed, on Pithy's record. Zero when they have not."),
    activity: TesterActivityView.describe("The observed half."),
    health: z
      .number()
      .int()
      .min(0)
      .max(100)
      .nullable()
      .describe(
        "0–100, or NULL for a tester we cannot observe. Null is not zero — absence of evidence is not evidence of risk.",
      ),
    healthBasis: z
      .enum(["scored", "unobservable", "unreachable"])
      .describe("Why the health is null when it is null. A UI must render `unobservable` grey, never red."),
    riskBand: RiskBand.describe("The band the score falls in, which selects the survival prior."),
    dailySurvival: z.number().describe("The published daily-survival prior used for this tester in the forecast."),
    factors: z
      .array(HealthFactorView)
      .describe("Every term that produced the score, so it can be audited line by line."),
    lastNudgedAt: z.iso.datetime().nullable().describe("When a nudge was last enqueued for them, or null."),
    nudgeCooldownUntil: z.iso
      .datetime()
      .nullable()
      .describe(
        "When they may be nudged again, or null if they may be now. Enforced server-side; this is a preview of that decision.",
      ),
    unreachable: z.boolean().describe("Whether their address bounced or is suppressed. We cannot nudge them at all."),
  })
  .describe("One tester, with the estimated half and the observed half kept visibly separate.");
export type MemberView = z.output<typeof MemberView>;

/** Pithy's forecast for one cohort. Every field an estimate; none of it reads Google. */
export const CohortProjection = z
  .object({
    basis: ProjectionBasis.describe("Why the forecast reads as it does, and why any null here is null."),
    calibration: z
      .literal("default")
      .describe(
        "`default` says out loud that the survival priors are numbers Pithy chose, not values fitted to your data.",
      ),
    method: z
      .literal("poisson_binomial_v1")
      .describe("The named, versioned method. A chart must not splice two methods into one line."),
    confidence: ProjectionConfidence.nullable().describe(
      "How much to trust this. Null when nothing is observable at all.",
    ),
    observedCoverage: z
      .number()
      .min(0)
      .max(1)
      .describe("Share of opted-in testers we can see. The honest denominator behind every number here."),
    probabilityReachTarget: z
      .number()
      .min(0)
      .max(1)
      .describe("Chance of reaching the target at all. One when already there."),
    probabilityHoldWindow: z
      .number()
      .min(0)
      .max(1)
      .nullable()
      .describe("Chance at least `targetSize` testers hold for the remaining days. Null when nothing is observable."),
    successProbability: z
      .number()
      .min(0)
      .max(0.99)
      .nullable()
      .describe(
        "PITHY'S ESTIMATE of completing the window. Capped below one — nothing is certain until Google says so. Null when there is no observable signal, rather than a plausible-looking guess.",
      ),
    successProbabilityRange: z
      .object({
        low: z.number().min(0).max(1).describe("The pessimistic bound, treating every unobservable tester as fragile."),
        high: z.number().min(0).max(1).describe("The optimistic bound, treating every unobservable tester as solid."),
      })
      .nullable()
      .describe(
        "The band widens exactly in proportion to how blind Pithy is. Render the band, not the point — the width IS the disclosure.",
      ),
    expectedSurvivors: z.number().describe("How many testers we expect to still be opted in when the window closes."),
    projectedTargetMetOn: z
      .string()
      .nullable()
      .describe("Projected UTC day the cohort first reaches target, or null with a basis."),
    projectedCompleteOn: z.string().nullable().describe("Projected UTC day the window completes, on Pithy's estimate."),
    invitesNeeded: z
      .number()
      .int()
      .describe(
        "How many more people to invite to close the gap at this cohort's own conversion rate. Usually worth more than the probability beside it.",
      ),
    recommendedRosterSize: z
      .number()
      .int()
      .describe("The roster size that survives the window at this cohort's own conversion and drop-off rates."),
  })
  .describe("Pithy's forecast for a cohort. Every field is an estimate; none of it reads Google.");
export type CohortProjection = z.output<typeof CohortProjection>;

/** One daily snapshot, as the chart consumes it. */
export const SnapshotView = z
  .object({
    snapshotOn: z.string().describe("The UTC day this point covers, `YYYY-MM-DD`."),
    dayIndex: z
      .number()
      .int()
      .describe("Days since the cohort was created — a zero-based x-axis so cohorts can be overlaid."),
    backfilled: z
      .boolean()
      .describe(
        "Written after its day had passed. Render dashed: the activity figures were reconstructed, not measured.",
      ),
    modelVersion: z
      .string()
      .describe("The constant set behind this point's forecast. Annotate the chart where it changes."),
    rosterSize: z.number().int().describe("Members on the roster that day."),
    invitedCount: z.number().int().describe("Invited, and have not yet answered."),
    acceptedCount: z.number().int().describe("Have agreed to test, and are waiting for the store link."),
    estimatedOptedInCount: z.number().int().describe("Pithy's estimate of the opted-in count that day."),
    lapsedCount: z.number().int().describe("Opted out or removed."),
    targetSize: z.number().int().describe("The target in force that day."),
    meetsTarget: z.boolean().describe("Whether the estimate reached the target that day."),
    headroom: z.number().int().describe("Estimated count minus target. Zero is the danger line; it can go negative."),
    estimatedHeldDays: z.number().int().describe("The estimated unbroken at-target run ending that day."),
    estimatedDaysRemaining: z.number().int().describe("Window days still to hold, on Pithy's estimate."),
    resetToday: z
      .boolean()
      .describe("Whether the run broke that day — the single most important annotation on the chart."),
    resetCount: z.number().int().describe("How many times the run had broken by that day."),
    activeCount: z.number().int().describe("Observed testers who authenticated inside the active window."),
    darkThreeToSevenCount: z.number().int().describe("Observed testers quiet 3–7 days. The first leading indicator."),
    darkEightToThirteenCount: z
      .number()
      .int()
      .describe("Observed testers quiet 8–13 days. The strongest silent-uninstall signal."),
    darkFourteenPlusCount: z.number().int().describe("Observed testers quiet 14 days or more."),
    neverLinkedCount: z
      .number()
      .int()
      .describe("Opted-in testers who never signed in. Counted toward the target; invisible to activity."),
    observedCoverage: z.number().describe("Share of opted-in testers visible that day."),
    medianHealth: z.number().int().nullable().describe("Median health across observed testers, or null."),
    minHealth: z
      .number()
      .int()
      .nullable()
      .describe("The weakest observed tester. A cohort breaks at its weakest link."),
    successProbability: z.number().nullable().describe("Pithy's estimate of completing the window, as of that day."),
    successProbabilityLow: z.number().nullable().describe("The pessimistic bound that day."),
    successProbabilityHigh: z.number().nullable().describe("The optimistic bound that day."),
    expectedSurvivors: z.number().describe("Expected survivors as of that day."),
    invitesNeeded: z.number().int().describe("How many more to invite, as of that day."),
    trendDirection: TrendDirection.describe("The direction as of that day."),
    trendReason: z.string().describe("The one-sentence explanation as of that day."),
    fragile: z.boolean().describe("At target, no headroom, at least one weak tester."),
    nudgesSent: z
      .object({
        confirm: z.number().int().describe("Will-you-test nudges enqueued that day."),
        store: z
          .number()
          .int()
          .describe("Store-link nudges enqueued that day — the only kind that can move the opt-in count."),
        inactive: z.number().int().describe("Inactivity nudges enqueued that day."),
        closing: z.number().int().describe("Window-closing nudges enqueued that day."),
      })
      .describe("Nudges enqueued that day, so an intervention can be read against its effect."),
  })
  .describe("One point on the trend chart — a day of a cohort's position, as it was believed on that day.");
export type SnapshotView = z.output<typeof SnapshotView>;

/** Direction of travel, plus the series behind it. */
export const TrendView = z
  .object({
    direction: TrendDirection.describe("Improving, steady, declining, or unknown — by a published rule, not a fit."),
    reason: z.string().describe("One sentence explaining the direction, for rendering beside the arrow."),
    fragile: z.boolean().describe("At target with no headroom and at least one weak tester: one lapse from a reset."),
    optedInDelta1d: z
      .number()
      .int()
      .nullable()
      .describe("Opt-in change since yesterday. Null without a prior snapshot."),
    optedInDelta7d: z.number().int().nullable().describe("Opt-in change over seven days."),
    activeDelta7d: z
      .number()
      .int()
      .nullable()
      .describe("Active-count change over seven days — engagement's direction."),
    successProbabilityDelta7d: z
      .number()
      .nullable()
      .describe("Forecast change over seven days. The rule's primary input."),
    series: z
      .array(SnapshotView)
      .describe("Trailing daily snapshots, oldest first. Present only when `trend` was requested."),
  })
  .describe("Direction of travel, plus the chartable series behind it.");
export type TrendView = z.output<typeof TrendView>;

/** One cohort: state, the estimated clock, observed activity, the forecast, and the trend. */
export const CohortView = z
  .object({
    id: z.string().describe("The cohort id."),
    name: z.string().describe("The cohort's human label."),
    targetPlatform: z.enum(["android", "ios"]).describe("Which store's programme this cohort serves."),
    targetSize: z.number().int().describe("Testers required simultaneously. Twelve for Google Play."),
    windowDays: z.number().int().describe("Continuous days required. Fourteen for Google Play."),
    maxRosterSize: z.number().int().describe("The cohort's roster cap."),
    resetPolicy: z
      .enum(["reset", "pause"])
      .describe(
        "Pithy's ASSUMPTION about what a dip below target does to the streak. Google documents neither behaviour.",
      ),
    createdAt: z.iso.datetime().describe("When the cohort was created."),
    closedAt: z.iso.datetime().nullable().describe("When it was closed, or null while running."),

    roster: z
      .object({
        size: z.number().int().describe("Members on the roster, in every state."),
        headroomToMax: z.number().int().describe("How many more may be added before the cap."),
        invited: z.number().int().describe("Invited, and have not yet answered."),
        accepted: z.number().int().describe("Have agreed to test, and are waiting for the store link."),
        optedIn: z.number().int().describe("Pithy's estimate of currently opted-in testers."),
        lapsed: z.number().int().describe("Opted out or removed."),
        unreachable: z.number().int().describe("Bounced or suppressed — we cannot nudge them."),
        neverLinked: z
          .number()
          .int()
          .describe("Confirmed but never signed in. Counted toward the target; invisible to activity."),
      })
      .describe("Current roster composition."),

    estimatedClock: z
      .object({
        source: z
          .literal("pithy_estimate")
          .describe(
            "This block is Pithy's estimate, replayed from our own invite records. Google's equivalent is not readable.",
          ),
        meetsTarget: z.boolean().describe("Whether the estimated opted-in count is at or above target right now."),
        headroom: z.number().int().describe("Estimated count minus target. Zero means one lapse from a reset."),
        estimatedHeldDays: z.number().int().describe("The estimated unbroken at-target run ending today."),
        estimatedDaysRemaining: z.number().int().describe("Days still to hold, on Pithy's estimate."),
        estimatedWindowStartOn: z.string().nullable().describe("The UTC day the current run began, or null."),
        resetCount: z.number().int().describe("How many times the run has broken since the cohort started."),
        dayBoundary: z
          .literal("UTC")
          .describe(
            "Pithy counts days in UTC. Google's boundary is undocumented and may differ, which is one more reason not to trust day fourteen.",
          ),
      })
      .describe("Pithy's clock, named `estimated*` field by field so it cannot be mistaken for Google's."),

    activity: z
      .object({
        source: z.literal("observed").describe("This block is fact from the auth tables, not an estimate."),
        active: z.number().int().describe("Authenticated inside the active window."),
        darkThreeToSeven: z.number().int().describe("Quiet 3–7 days."),
        darkEightToThirteen: z.number().int().describe("Quiet 8–13 days — the strongest silent-uninstall signal."),
        darkFourteenPlus: z.number().int().describe("Quiet 14 days or more."),
        neverLinked: z.number().int().describe("No activity data exists for these testers at all."),
        observedCoverage: z.number().describe("Share of opted-in testers with any activity signal."),
      })
      .describe("The observed half."),

    projection: CohortProjection.describe("Pithy's forecast for this cohort."),
    trend: TrendView.describe("Direction of travel, plus the series when requested."),

    reconciliation: z
      .object({
        supported: z.literal(false).describe("Always false today. No store API reconciliation exists."),
        lastReconciledAt: z
          .null()
          .describe(
            "Always null today. The field exists so a future version has a home and this one cannot be misread.",
          ),
        reason: z
          .string()
          .describe(
            "Why not, in one sentence — so 'we checked and cannot' is distinguishable from 'we never thought about it'.",
          ),
      })
      .describe("Store reconciliation status. Honestly empty rather than absent."),

    disclaimer: EstimateDisclaimer.describe("Required. Render it wherever an opt-in figure is rendered."),
    members: z
      .array(MemberView)
      .optional()
      .describe("The full roster with per-tester health. Present only when requested."),
  })
  .describe("One cohort: current state, the estimated clock, observed activity, the forecast, and the trend.");
export type CohortView = z.output<typeof CohortView>;

/** The control-plane cohort read. */
export const CohortsResponse = z
  .object({
    cohorts: z.array(CohortView).describe("Every cohort in this Worker, or the one requested."),
    modelVersion: z.string().describe("The constant set behind every forecast in this response."),
    generatedAt: z.iso.datetime().describe("When this response was computed."),
    disclaimer: EstimateDisclaimer.describe(
      "Repeated at the envelope, so a dashboard rendering a list still carries it.",
    ),
  })
  .describe("What a dashboard needs to render cohort state, per-tester health, the trend, and the forecast.");
export type CohortsResponse = z.output<typeof CohortsResponse>;

/**
 * ## The write routes, and the tester's own read
 *
 * Everything above describes the control-plane cohort read. What follows is the rest of the wire
 * contract — the roster writes, the nudge, and the one route a tester calls about themselves. They
 * were object literals with no schema, which meant a management client had nothing to validate them
 * with and hand-wrote a mirror of each.
 *
 * **The three write responses carry an id and never an address.** The scopes are separated so a
 * credential may mail or manage a roster it was never granted permission to read; echoing the address
 * back on every write would turn a list of ids into a list of real people's email addresses, which is
 * exactly what `testers:roster:read` exists to gate. `invite` is the one exception and it is not one:
 * the caller sent the address in the request body, so returning it discloses nothing new.
 */

/** One membership, as the tester themselves sees it. */
export const MembershipView = z
  .object({
    cohortName: z.string().describe("The cohort's human label — the only thing about it a tester is shown."),
    state: MemberState.describe("Their own roster state."),
    estimatedOptedInAt: z.iso
      .datetime()
      .nullable()
      .describe("When they followed Pithy's confirmation link, or null. OUR record, not Google's."),
    estimatedDaysRemaining: z.number().int().describe("Window days still to hold, on Pithy's estimate."),
    windowDays: z.number().int().describe("Continuous days the programme requires."),
  })
  .describe("One cohort a tester belongs to, as that tester sees it — never the roster, never the forecast.");
export type MembershipView = z.output<typeof MembershipView>;

/**
 * `GET {base}/status` — a tester's own view.
 *
 * A tester sees their memberships and nothing else. An address this Worker cannot resolve to a user
 * gets an empty list rather than a 404, so the route is not an oracle for who is on a roster.
 */
export const MembershipsResponse = z
  .object({
    memberships: z
      .array(MembershipView)
      .describe("Every cohort the caller belongs to. Empty when they belong to none."),
    disclaimer: EstimateDisclaimer.describe("Required here too — a tester reading days remaining is reading a guess."),
  })
  .describe("What a tester is told about their own participation.");
export type MembershipsResponse = z.output<typeof MembershipsResponse>;

/** `POST {base}/invite`. */
export const InviteResponse = z
  .object({
    member: z
      .object({
        id: z.string().describe("The member id — the handle every other write route takes."),
        email: z.string().describe("The invited address. Returned because the caller just sent it."),
        state: MemberState.describe("Their roster state after the invitation."),
      })
      .describe("The roster row, as the invitation left it."),
    created: z
      .boolean()
      .describe(
        "False when the address was already on this roster. Re-inviting is not an error, so this is how a caller tells the two apart.",
      ),
    jobId: z
      .string()
      .nullable()
      .describe("The email job the invitation was enqueued as, or null when the caller asked for no mail."),
  })
  .describe("The invited tester, whether the roster row is new, and the mail it enqueued.");
export type InviteResponse = z.output<typeof InviteResponse>;

/** `POST {base}/resend`. */
export const ResendResponse = z
  .object({
    member: z
      .object({ id: z.string().describe("The member the invitation went to. An id, never the address.") })
      .describe("Who was re-invited."),
    jobId: z.string().describe("The email job the re-invitation was enqueued as."),
  })
  .describe("Which tester was re-invited, and the mail it enqueued.");
export type ResendResponse = z.output<typeof ResendResponse>;

/** `POST {base}/remove`. */
export const RemoveResponse = z
  .object({
    member: z
      .object({
        id: z.string().describe("The member removed. An id, never the address."),
        state: MemberState.describe("Their roster state after the removal."),
      })
      .describe("The roster row, as the removal left it."),
  })
  .describe("The removed tester's row, as it now stands.");
export type RemoveResponse = z.output<typeof RemoveResponse>;

/** Why an eligible tester was not mailed. Counts, so a caller can tell a full send from a partial one. */
const NudgeSkipped = z
  .object({
    cooling: z.number().int().describe("Inside the cooldown window, so they were not mailed again."),
    unreachable: z.number().int().describe("Bounced or suppressed — we cannot mail them at all."),
    chasedOut: z.number().int().describe("Already chased as far as the policy allows."),
    truncated: z
      .number()
      .int()
      .describe(
        "Eligible testers dropped by the batch cap. Reported rather than silent: without it a caller cannot tell 'everyone eligible was mailed' from 'the first two hundred were'.",
      ),
  })
  .describe("Who was eligible and still not mailed, by reason.");

/**
 * `POST {base}/nudge` with `dryRun: true`.
 *
 * Ids, not addresses. A caller holding only `testers:nudge:send` can mail the roster but was never
 * granted permission to read it, and a preview returning every eligible tester's email would hand
 * them exactly what `testers:roster:read` exists to gate.
 */
export const NudgeDryRunResponse = z
  .object({
    dryRun: z.literal(true).describe("Always true. The discriminator that keeps a preview from being read as a send."),
    wouldSend: z
      .array(z.object({ id: z.string().describe("A member who would be mailed. An id, never the address.") }))
      .describe("Who this send would reach, capped at the batch limit."),
    cooling: z.number().int().describe("Inside the cooldown window."),
    unreachable: z.number().int().describe("Bounced or suppressed."),
    chasedOut: z.number().int().describe("Already chased as far as the policy allows."),
    truncated: z.number().int().describe("Eligible testers dropped by the batch cap."),
  })
  .describe("What a nudge would do, without doing it.");
export type NudgeDryRunResponse = z.output<typeof NudgeDryRunResponse>;

/** `POST {base}/nudge`. */
export const NudgeResponse = z
  .object({
    sent: z
      .array(
        z
          .object({
            memberId: z.string().describe("The tester mailed. An id, never the address."),
            jobId: z.string().describe("The email job it was enqueued as."),
          })
          .describe("One enqueued nudge."),
      )
      .describe("Every nudge actually enqueued. Never empty — an empty send is refused, not reported as success."),
    skipped: NudgeSkipped.describe("Who was eligible and still not mailed, by reason."),
    copySource: z
      .enum(["supplied", "default"])
      .describe(
        "Whether the caller supplied the copy or the capability's own was used. The provenance, never the words.",
      ),
  })
  .describe("What a nudge send actually did, and who it left out.");
export type NudgeResponse = z.output<typeof NudgeResponse>;
