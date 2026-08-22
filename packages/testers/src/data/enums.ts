// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";

/**
 * The shared vocabulary of the roster: what state a tester is in, what moved them there, and how much
 * of them we can actually see.
 *
 * **The naming rule this file exists to hold.** Anything derived from the opt-in event log is Pithy's
 * estimate of a number Google owns and does not expose; anything derived from `@pithy-sh/auth` is
 * observed fact. The two are never merged into a single "status", because a merged field would have to
 * pick one authority and silently claim the other. `MemberState` is the estimate, `ActivityState` is the
 * fact, and every member carries both.
 */

/**
 * A tester's position on the roster.
 *
 * **Only four things write a transition, and inactivity is not one of them.** A tester who opted in and
 * never opens the app still counts toward Google's twelve, so lapsing them for going quiet would turn
 * Pithy's count from "our record of who confirmed" into "our guess dressed as a record" — and the
 * divergence from Google would become unbounded and undetectable. Silence makes a tester look alarming
 * in the health column. It never moves them off the count.
 */
export const MemberState = z
  .enum(["invited", "accepted", "opted_in", "lapsed", "removed"])
  .describe(
    "Roster state, replayed from the event log: `invited` (we sent the invitation), `accepted` (they answered it — they have agreed to test, so their address is ready to go on the store's tester list), `opted_in` (they followed the link through to the store's own opt-in page, which is the closest thing to enrollment Pithy can observe), `lapsed` (they opted out), `removed` (the developer took them off). Inactivity never writes any of these, and neither does signing in — that is activity, not membership.",
  );
export type MemberState = z.output<typeof MemberState>;

/**
 * What happened to a member, as an append-only fact.
 *
 * The streak is replayed from these rather than stored as a counter, so a correction is a recomputation
 * and the history survives it. That is also what lets a snapshot written last Tuesday stay an accurate
 * record of what we believed last Tuesday.
 */
export const MemberEventKind = z
  .enum(["invited", "reinvited", "accepted", "opted_in", "lapsed", "removed", "nudged"])
  .describe(
    "The event kinds the roster is replayed from. `reinvited` and `nudged` are recorded but do not change state — they are the outreach history the cooldown and the health score read.",
  );
export type MemberEventKind = z.output<typeof MemberEventKind>;

/**
 * Who or what caused an event.
 *
 * Worth storing because the same transition means different things depending on its author: a `lapsed`
 * the tester wrote by following an opt-out link is a fact about them, while a `lapsed` the developer
 * wrote is a fact about the roster.
 */
export const EventActor = z
  .enum(["tester", "developer", "system"])
  .describe(
    "Who caused this event: the `tester` (they followed a link), the `developer` (a control-plane or CLI action), or the `system` (the daily pass).",
  );
export type EventActor = z.output<typeof EventActor>;

/**
 * How much of a tester we can see at all.
 *
 * This is a *different kind of statement* from a health score, which is why it gets its own field
 * rather than a low number. A tester who opted in and never signed in is not evidence of risk; it is
 * absence of evidence. Scoring them badly would paint a perfectly healthy cohort red the moment an
 * adopter's test flow does not require a sign-in — and that is a common, legitimate app.
 */
export const Observability = z
  .enum(["observed", "unobservable", "unreachable"])
  .describe(
    "Whether activity data exists for this tester: `observed` (their address matched a user with at least one session or device), `unobservable` (no match, or a match with no activity at all), `unreachable` (their address bounced or is suppressed, so we cannot even nudge them).",
  );
export type Observability = z.output<typeof Observability>;

/**
 * What the observed activity says, when there is any.
 *
 * `never_linked` is deliberately not a flavour of `inactive`. "Quiet since the 12th" is a tester
 * drifting away; "never signed in" may simply be an app that does not ask anyone to sign in. A UI that
 * renders them the same way will send nudges to people who did nothing wrong.
 */
export const ActivityState = z
  .enum(["active", "inactive", "never_linked", "unreachable"])
  .describe(
    "Observed activity: `active` (authenticated inside the active window), `inactive` (matched a user but has gone quiet, with a date), `never_linked` (the invited address never matched a user, so there is no 'since'), `unreachable` (bounced or suppressed).",
  );
export type ActivityState = z.output<typeof ActivityState>;

/** The health bands a score falls into, each selecting one published survival prior. */
export const RiskBand = z
  .enum(["healthy", "watch", "at_risk", "critical", "unknown"])
  .describe(
    "The band a tester's health score falls in, which selects their daily-survival prior. `unknown` is for a tester with no score at all — unobservable or unreachable — and must render gray rather than red.",
  );
export type RiskBand = z.output<typeof RiskBand>;

/** Which nudge was sent. Each has shipped default copy and its own trigger in the daily pass. */
export const NudgeKind = z
  .enum(["confirm", "store", "inactive", "closing"])
  .describe(
    "The nudge kinds: `confirm` (will you help test?), `store` (you are on the list — here is the link to join and install), `inactive` (you have not opened the app recently), `closing` (the test window is nearly over). `confirm` and `store` are two messages rather than one because the store's opt-in page only works once the developer has added that address to the tester list, which no API can do — sending the link first produces `App not available` and a tester who thinks the app is broken. Every kind ships default copy, so `pithy testers run` chases sensibly with no dashboard involved.",
  );
export type NudgeKind = z.output<typeof NudgeKind>;

/** Which way a cohort is heading, over the last week of snapshots. */
export const TrendDirection = z
  .enum(["improving", "steady", "declining", "unknown"])
  .describe(
    "Direction of travel across the trailing snapshots. `unknown` until three snapshots exist — a chart drawn from two points is a straight line through noise.",
  );
export type TrendDirection = z.output<typeof TrendDirection>;

/**
 * Why the projection reads the way it does — and, when a number is null, why there is no number.
 *
 * The null case is the one that matters. When nothing about a cohort is observable, the forecast is
 * `null` and this says `no_observable_signal`, rather than a plausible-looking 0.5 that a dashboard
 * would render as a real answer.
 */
export const ProjectionBasis = z
  .enum(["estimated", "target_met", "insufficient_pipeline", "no_observable_signal", "no_history"])
  .describe(
    "Why the projection reads as it does: `estimated` (a normal forecast), `target_met` (already at target and holding), `insufficient_pipeline` (not enough pending invitations to close the gap at the observed conversion rate), `no_observable_signal` (nothing is observable, so the forecast is null rather than guessed), `no_history` (the cohort is too new to project).",
  );
export type ProjectionBasis = z.output<typeof ProjectionBasis>;

/** How much to trust the forecast, driven by how much of the cohort we can see. */
export const ProjectionConfidence = z
  .enum(["low", "moderate", "high"])
  .describe(
    "Confidence in the forecast, driven by observability coverage and the cohort's age. Null rather than `low` when coverage is zero — 'we can see nothing' is not a weak opinion, it is no opinion.",
  );
export type ProjectionConfidence = z.output<typeof ProjectionConfidence>;
