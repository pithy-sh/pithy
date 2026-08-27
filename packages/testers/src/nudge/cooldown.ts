// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { TestersMember } from "../data/member";

/**
 * The per-tester nudge cooldown.
 *
 * **Mandatory, server-side, and on every path.** A nudge trigger with no guard is a button that mails
 * the same twelve people repeatedly, and the fastest way to lose a cohort is to become the reason they
 * muted the sender. The dashboard cannot be trusted to hold the line here — not because it is
 * malicious, but because a retried request, a double-clicked button, and a cron that overlaps its own
 * previous run all produce the same duplicate send, and none of them is a bug anyone would notice
 * before the testers did.
 *
 * The cooldown reads `lastNudgedAt`, which is stamped at **enqueue** rather than at delivery. That is
 * the ordering that makes the guard actually hold: waiting for the send Workflow to confirm would leave
 * a window in which a second request sees no recent nudge and mails again. An email enqueued and then
 * failing to send is a delivery problem; an email sent twice is a lost tester.
 */

/** Milliseconds in one hour. */
const MS_PER_HOUR = 3_600_000;

/** When a tester may next be nudged, or null if they may be nudged now. */
export function cooldownUntil(member: TestersMember, cooldownHours: number): Date | null {
  if (!member.lastNudgedAt) return null;
  return new Date(member.lastNudgedAt.getTime() + cooldownHours * MS_PER_HOUR);
}

/** Whether this tester may be nudged right now. */
export function mayNudge(member: TestersMember, cooldownHours: number, now: Date): boolean {
  const until = cooldownUntil(member, cooldownHours);
  return until === null || until <= now;
}

/**
 * How many unanswered nudges a tester takes before we stop.
 *
 * The cooldown bounds how *often* somebody is mailed; this bounds how *many times*. The counter resets
 * the moment they answer, so it only ever bites the genuinely unresponsive — who stay on the roster and
 * stay visible, they simply stop being chased. Without it a tester who never replies is mailed every
 * three days for the life of the cohort.
 *
 * It lives here rather than in the daily pass because the pass is not the only sender. It was read by
 * `dueNudge` alone, so a dashboard holding `testers:nudge:send` could chase an unresponsive address
 * indefinitely — the very thing https://pithy.sh/docs/capabilities/testers/use says cannot happen. The same reasoning that makes the
 * cooldown re-enforced inside every handler applies to the cap.
 */
export const MAX_UNANSWERED_NUDGES = 3;

/** Whether this tester has stopped answering and should no longer be chased. */
export function chasedOut(member: TestersMember): boolean {
  return member.nudgeCount >= MAX_UNANSWERED_NUDGES;
}

/** A roster split into who may be nudged and who is still cooling down. */
export interface CooldownSplit {
  readonly eligible: readonly TestersMember[];
  readonly cooling: readonly TestersMember[];
  readonly unreachable: readonly TestersMember[];
  /** Testers who have stopped answering. Separate again, because this one never resolves with time. */
  readonly chasedOut: readonly TestersMember[];
}

/**
 * Split a set of testers by whether they may be nudged.
 *
 * Unreachable testers are separated rather than merged into `cooling`, because the two call for
 * different actions: a cooling tester will be nudgeable tomorrow, while an unreachable one never will
 * be and needs replacing. A response that reported them together would tell a developer to wait for
 * something that is not going to happen.
 */
export function splitByCooldown(members: readonly TestersMember[], cooldownHours: number, now: Date): CooldownSplit {
  const eligible: TestersMember[] = [];
  const cooling: TestersMember[] = [];
  const unreachable: TestersMember[] = [];
  const exhausted: TestersMember[] = [];
  for (const member of members) {
    if (member.unreachable) unreachable.push(member);
    else if (chasedOut(member)) exhausted.push(member);
    else if (mayNudge(member, cooldownHours, now)) eligible.push(member);
    else cooling.push(member);
  }
  return { eligible, cooling, unreachable, chasedOut: exhausted };
}

/**
 * Whether this nudge answers something the tester just did, and so should not wait for the cooldown.
 *
 * **The cooldown exists to stop repeated chasing, not to delay a reply.** A tester who has just agreed
 * to test and is waiting for the link is not being chased — they are waiting on us. Holding that email
 * for three days because we happened to ask them two days ago is how a cohort loses the people who were
 * most willing, and it is the single most avoidable way this capability could fail.
 *
 * The test is that their acceptance is newer than our last message to them. That needs no extra column
 * and no second query: if we have not written to them since they said yes, this is the reply. Once it
 * has gone, `lastNudgedAt` moves past `acceptedAt` and every later reminder falls under the normal
 * cooldown like anything else.
 */
export function answersRecentAction(member: TestersMember): boolean {
  if (!member.acceptedAt) return false;
  return !member.lastNudgedAt || member.acceptedAt > member.lastNudgedAt;
}
