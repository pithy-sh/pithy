// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * The audit action codes `@pithy-sh/support` emits, as `domain/reason` strings under the `support`
 * domain.
 *
 * Support emits through core's seam (`c.var.emit`) and never imports `@pithy-sh/audit` — audit is
 * optional and separately licensed (principle 4: depend on core seams, not on sibling capabilities).
 * With audit absent the seam is a no-op; with it composed these land in `pithy_audit_events`. The
 * taxonomy is federated, so this list is owned here and core holds no union of every action.
 *
 * **What is audited, and why these.** Mail arriving is not interesting — the messages table is a
 * better record of it than an event could be, and auditing every inbound message would drown the
 * trail in exactly the volume a public address attracts. What an audit trail adds here is the
 * *human decisions taken on somebody else's data*: who marked a thread done, who sent mail out under
 * the adopter's domain, and who re-ran a model over a customer's words. Those have no other record,
 * and they are the ones a support console has to be able to answer for.
 *
 * **Never put a message body, a subject, or a sender's name in an event's metadata.** The trail is
 * queryable and long-lived, and this capability's entire input is untrusted mail somebody else wrote
 * — the same rule as `detail` on a `PithyError`, for a sharper reason.
 */
export const SupportAuditActions = {
  /**
   * A thread was marked done, or reopened. The one shared piece of state in the capability, so "who
   * marked this done" is answerable from the trail rather than from an ownership column — which is
   * precisely why the model gets away with having no ownership column.
   */
  threadArchived: "support/thread_archived",
  /** A thread was taken back out of the archive. Recorded separately, because undoing is its own decision. */
  threadUnarchived: "support/thread_unarchived",
  /**
   * A reply went out. Audited because it leaves under the adopter's domain and their DKIM: to the
   * recipient it is indistinguishable from the founder writing it, so who actually sent it is a
   * security-relevant fact with no other record.
   */
  replySent: "support/reply_sent",
  /**
   * A classification was re-run by hand. Audited because it rewrites a judgement about a customer's
   * message, and because a run of them is what somebody fishing for a different answer looks like.
   */
  threadReclassified: "support/thread_reclassified",
  /**
   * An inbound message was refused by the guard — too large, or over a rate bound. Outcome `denied`.
   *
   * The one inbound event that is audited, and the exception proves the rule at the top of this
   * file: an accepted message leaves a row, so auditing it would duplicate a better record, whereas
   * a refused one leaves **nothing anywhere**. Without this, a flood is invisible in exactly the
   * situation where an operator most needs to see it.
   */
  inboundRejected: "support/inbound_rejected",
  /**
   * An in-app submission was refused — over the per-account bound. Outcome `denied`.
   *
   * Its own action rather than a share of `inboundRejected`, because the two answer different
   * questions and an operator acts on them differently. A refused *message* names an address in a
   * header nobody proved, so its actor is anonymous and the event is evidence of a flood. A refused
   * *submission* names an account the adopter issued: the actor is real, and the action available is
   * to disable it. Folding them together would put a proven identity and an unproven claim in the same
   * `actorId` column, which is the distinction this whole channel exists to keep.
   *
   * Same argument for auditing it at all as the mail path's: an accepted submission leaves a row in
   * the messages table, which is a better record than an event could be — a refused one leaves nothing
   * anywhere, and one account quietly filling the inbox is exactly when somebody needs to see it.
   */
  submissionRejected: "support/submission_rejected",
} as const;

/** One of the support audit action codes. */
export type SupportAuditAction = (typeof SupportAuditActions)[keyof typeof SupportAuditActions];
