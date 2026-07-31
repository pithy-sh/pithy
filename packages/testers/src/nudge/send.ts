// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { NudgeKind } from "../data/enums";
import type { TestersMember } from "../data/member";
import { ESTIMATE_STATEMENT } from "../http/responses";
import { type ResolvedCopy, resolveCopy } from "./copy";

/**
 * Sending a nudge — the one place words, a recipient, and the adopter's sending domain meet.
 *
 * **Nothing here sends an email.** It enqueues a job through the seam `@pithy-sh/email` exposes, so
 * every nudge inherits the existing path in full: the send Workflow with its retries, the suppression
 * list, bounce handling, and the job history that records exactly what went out and when. A nudge that
 * bypassed that to send inline would be a second delivery path with none of it, and the first hard
 * bounce would keep being retried forever.
 *
 * **The email job is the record of what was sent.** The supplied copy lands in the job's payload, and
 * the `nudged` event records whether the words were ours or a caller's. Between them, "who mailed my
 * users, saying what, on whose authority" is answerable after the fact rather than a matter of trust.
 */

/** The enqueue seam, as `@pithy-sh/email` exposes it — bound to the request env by the caller. */
export type EnqueueNudge = (input: {
  to: string;
  template: string;
  payload: unknown;
}) => Promise<{ jobId: string; status: string }>;

/** What sending one nudge needs. */
export interface NudgeSendInput {
  readonly member: TestersMember;
  readonly kind: NudgeKind;
  /** Copy supplied by a control-plane caller, if any and if the deployment allows it. */
  readonly supplied: { subject?: string; body?: string } | undefined;
  /** The confirmation link, for a `confirm` nudge. Absent for the others. */
  readonly ctaUrl: string | undefined;
  /**
   * The tester's own way out.
   *
   * Carried on every nudge, not just the marketing-shaped ones. This capability repeatedly asks a
   * person for something over weeks; someone being chased must be able to stop it, and
   * without this the opt-out route we built is unreachable — a door with no handle on the inside.
   */
  readonly optOutUrl: string | undefined;
}

/** What one enqueued nudge produced. */
export interface NudgeSendResult {
  readonly memberId: string;
  readonly jobId: string;
  readonly copy: ResolvedCopy;
}

/**
 * The closing line on every nudge.
 *
 * The same sentence the API and the CLI carry, in the tester's mail too. It is there because a tester
 * asked to "stay opted in for fourteen days" reasonably assumes whoever is asking can see whether they
 * have — and being straight about that is what stops the developer inheriting an argument they cannot
 * win on day fifteen.
 */
const FOOTNOTE = ESTIMATE_STATEMENT;

/**
 * Enqueue one nudge.
 *
 * The caller has already applied the cooldown; this does not re-check it, because the cooldown is a
 * decision about a *set* of testers — who to mail and who to skip — and making it here would mean
 * discovering a skip after the batch had already been composed.
 */
export async function sendNudge(enqueue: EnqueueNudge, input: NudgeSendInput): Promise<NudgeSendResult> {
  const copy = resolveCopy(input.kind, input.supplied);
  const result = await enqueue({
    to: input.member.email,
    template: "testerNudge",
    payload: {
      subject: copy.subject,
      heading: copy.heading,
      // An array of plain strings, each rendered HTML-escaped by the template. This is the line that
      // makes caller-supplied copy safe to send over the adopter's own DKIM signature.
      paragraphs: [...copy.paragraphs],
      ...(input.ctaUrl ? { ctaUrl: input.ctaUrl, ctaLabel: copy.ctaLabel ?? "Confirm" } : {}),
      footnote: FOOTNOTE,
      ...(input.optOutUrl ? { optOutUrl: input.optOutUrl, optOutLabel: "No thanks, take me off this list" } : {}),
    },
  });
  return { memberId: input.member.id, jobId: result.jobId, copy };
}
