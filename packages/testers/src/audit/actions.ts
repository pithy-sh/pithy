// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * The audit actions this capability emits, through the core `emit()` seam.
 *
 * Every roster change is audited, because a roster is a list of real people's email addresses that a
 * management credential can add to, remove from, and mail. "Who took Ada off the cohort on the twelfth,
 * and what did the dashboard send to the other eleven that afternoon" is a question with an answer, and
 * these are what make it one.
 *
 * Emitted with `c.var.emit`, never by importing `@pithy-sh/audit` — the seam is always present
 * (`noopEmit` when no audit capability is composed), so there is no null check and no hard dependency.
 * Identifiers and outcomes only in metadata: never a token, never the body of a nudge.
 */
export const TestersAuditActions = {
  /** A cohort was created. The start of a roster's life, and the frozen copy of its rules. */
  /** An address was added to a roster. A real person's email address, added by whoever held the credential. */
  memberInvited: "testers/member_invited",
  /** Another invitation went to someone already on the roster. */
  memberReinvited: "testers/member_reinvited",
  /**
   * A tester answered the invitation and agreed to test.
   *
   * Audited separately from the opt-in because it is the developer's cue to put a real person's address
   * on a store tester list — a list Google can see. When that address got there, and on whose say-so, is
   * a question worth being able to answer.
   */
  memberAccepted: "testers/member_accepted",
  /**
   * A tester followed the confirmation link.
   *
   * Audited because it is the single event the entire opt-in count rests on. If the count is ever
   * disputed, this is the trail that says when each confirmation arrived and from where.
   */
  memberOptedIn: "testers/member_opted_in",
  /** A tester followed the opt-out link. Their own act, recorded as theirs. */
  memberLapsed: "testers/member_lapsed",
  /** A tester was taken off a roster by the developer. */
  memberRemoved: "testers/member_removed",
  /**
   * A nudge was enqueued.
   *
   * Audited with the copy's provenance rather than its text: knowing that a message went out over the
   * adopter's own sending domain, to whom, and whether the words were Pithy's or a caller's, is what
   * makes a leaked dashboard credential investigable after the fact.
   */
  nudgeSent: "testers/nudge_sent",
  /** A nudge was refused because every selected tester was inside the cooldown. */
  nudgeThrottled: "testers/nudge_throttled",
  /** A caller supplied nudge copy on a deployment that pins the defaults. */
  copyRejected: "testers/copy_rejected",
} as const;

/** One of the testers capability's audit actions. */
export type TestersAuditAction = (typeof TestersAuditActions)[keyof typeof TestersAuditActions];
