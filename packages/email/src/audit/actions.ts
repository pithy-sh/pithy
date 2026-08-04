// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * The audit actions this capability emits, through the core `emit()` seam.
 *
 * **Reads are audited here, not only writes.** The job log is a list of who was mailed what and when,
 * and the suppression list is every address in the project that ever bounced, complained, or opted
 * out — reading either is a disclosure of other people's personal data, and a management credential
 * quietly paging through one of them at three in the morning is exactly the event an adopter needs to
 * be able to find afterwards. "Which operator read the suppression list on the twelfth" is a question
 * with an answer, and these are what make it one.
 *
 * Emitted with `c.var.emit`, never by importing `@pithy-sh/audit` — the seam is always present
 * (`noopEmit` when no audit capability is composed), so there is no null check and no hard dependency.
 * Identifiers, counts, and filters in metadata: never a rendered subject, never a template payload.
 */
export const EmailAuditActions = {
  /**
   * A page of the job log was read. Recorded with the filter and the page size, not the rows — the
   * point is that somebody read *some* of it, and how much.
   */
  jobsRead: "email/jobs_read",
  /** One job was opened in full, which is where a recipient's whole address is disclosed. */
  jobRead: "email/job_read",
  /**
   * A failed job was put back in the queue.
   *
   * The one operation here that sends mail to a real person, so it is recorded at `warning` with the
   * job id and the status it came from.
   */
  jobRetried: "email/job_retried",
  /** A page of the global suppression list was read — addresses, in bulk, across every environment. */
  suppressionsRead: "email/suppressions_read",
  /** An address was blocked by hand. Silent to the recipient, so the trail is the only record. */
  suppressionAdded: "email/suppression_added",
  /**
   * An address was unblocked.
   *
   * The most dangerous line in this file: it re-opens sending to somebody who hard-bounced, reported
   * spam, or asked to be left alone. Recorded at `warning` with the reason the row carried, so the
   * trail says what was undone and not merely that something was.
   */
  suppressionRemoved: "email/suppression_removed",
} as const;

/** One of the email capability's audit actions. */
export type EmailAuditAction = (typeof EmailAuditActions)[keyof typeof EmailAuditActions];
