// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { EmailJob } from "../data/emailJob";
import type { EmailSuppression } from "../data/emailSuppression";

/**
 * What a management client is allowed to see. Nothing in this package ever returns a raw row.
 *
 * ## `payload` is never projected. Anywhere.
 *
 * `EmailJob.payload` holds the template's input variables, and that is not merely "often PII" — it is
 * the most sensitive column this capability owns. A `magicLink` job's payload contains the sign-in URL,
 * an `otp` job's contains the code, an order confirmation's contains a name, an address, and what
 * somebody bought. Projecting it on a read scope would turn "let the dashboard show me the email log"
 * into "let the dashboard sign in as any user who requested a magic link recently", which is a full
 * account takeover reachable from the least privileged credential this capability defines.
 *
 * There is no flag to turn it on and no field that carries a redacted version of it. An operator
 * diagnosing a send needs to know *which template* ran and *what went wrong*, and both are projected.
 * They do not need the variables, and the one case where they would — reproducing a render — is
 * reachable from the adopter's own database, where the audit trail is not a substitute for authority.
 *
 * ## The list masks the recipient; the detail does not
 *
 * `toAddress` is personal data on its own. The list is the bulk surface — a hundred rows a request,
 * paged, is precisely how a compromised credential turns a job log into a customer address book — so it
 * carries a masked address: enough for an operator to recognise the row they are looking for, and
 * useless for harvesting. The **detail** route returns the whole address, one job at a time, with an
 * audit event naming that job.
 *
 * This is a bulk-harvest control, not anonymisation, and it is not sold as one. `ad***@example.com`
 * identifies a person to anyone who already knows them. What it does is raise the cost of taking the
 * whole list from one request per hundred addresses to one request per address, each individually
 * recorded — which is the difference between an incident nobody can reconstruct and one whose every
 * step is in the trail. The precedent is the same one testers' `resend` and `remove` follow: return the
 * id, not the address, and let the audit trail hold what the response does not.
 *
 * The **domain survives masking**, deliberately. It is the field an operator reads a deliverability
 * problem off — every failure landing on one provider is the diagnosis — and it names an organisation
 * rather than a person.
 *
 * The suppression list is the deliberate exception: an address *is* the record there, so masking it
 * would leave a list of blocks nobody could act on. That is exactly why reading it is its own scope.
 */

/**
 * Mask a recipient for the list.
 *
 * Two characters of the local part survive, then the domain in full. Anything that does not parse as
 * `local@domain` collapses to `***` rather than being echoed — a row whose address is malformed is
 * usually a row whose address came from somewhere unexpected, and passing it through unchanged is how
 * the one value the mask exists for escapes it.
 */
export function maskAddress(address: string): string {
  const at = address.lastIndexOf("@");
  if (at <= 0 || at === address.length - 1) return "***";
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  return `${local.slice(0, 2)}***@${domain}`;
}

/** One job as the list shows it: enough to scan, not enough to harvest. */
export interface EmailJobListItem {
  /** The job id — what the detail and retry routes take. */
  id: string;
  /** The recipient, masked. The detail route has the whole address. */
  recipient: string;
  /** The template that produced this email. Structural, so it identifies the kind of mail with no rendered content. */
  template: string;
  /** `transactional` or `marketing`. */
  category: string;
  /** The lifecycle state. */
  status: string;
  /** How the send time was decided. */
  mode: string;
  /** How many send attempts have been made. */
  attempts: number;
  /** The campaign this belongs to, for attribution; null for transactional mail. */
  campaignId: string | null;
  /** How a bounce was classified, when one arrived. */
  bounceType: string | null;
  /**
   * Whether the row carries an error, without carrying it.
   *
   * Provider error strings routinely embed the recipient (`550 5.1.1 <ada@example.com> user unknown`),
   * so the text itself is on the detail route, behind the same request that discloses the address
   * anyway. In the list it is a boolean, which is all a "show me the failures" pane needs.
   */
  failed: boolean;
  /** When this job is (or was) due to send, ISO-8601. */
  sendAt: string;
  /** When the row was created, ISO-8601. The list's sort key. */
  createdAt: string;
  /** When the send succeeded, ISO-8601; null until then. */
  sentAt: string | null;
}

/**
 * One job in full.
 *
 * Everything in the list, plus the whole recipient, the rendered subject, the sender identity, and the
 * failure detail. Deliberately absent, beyond `payload`: `inReplyTo` and `references`, which are
 * threading internals of a support reply and tell an operator nothing they would act on.
 */
export interface EmailJobDetail extends Omit<EmailJobListItem, "recipient" | "failed"> {
  /** The recipient, in full. Disclosed one job at a time, and audited as such. */
  toAddress: string;
  /**
   * The rendered subject line.
   *
   * Rendered *from* the payload, so it can carry a fragment of it — "Your receipt for order 4471".
   * That is the one piece of rendered content an operator genuinely cannot diagnose a send without, and
   * it is here rather than in the list for the same reason the address is: one row, one request, one
   * audit event.
   */
  subject: string;
  /** The sending identity — the adopter's own configuration, not the recipient's data. */
  fromAddress: string;
  /** The sender display name recipients saw. */
  fromName: string;
  /** The Email Service message id, the handle a later bounce is attributed through. */
  messageId: string | null;
  /** The last error recorded against this job; null when healthy. */
  error: string | null;
  /** The SMTP or Email Service code from a bounce; null unless it bounced. */
  bounceCode: string | null;
  /** The recipient's IANA timezone, for a `timezone`-mode send. */
  timezone: string | null;
  /** The recipient-local time-of-day, for a `timezone`-mode send. */
  localTime: string | null;
  /** Whether an open-tracking pixel was injected. */
  openTracking: boolean;
  /** Whether links were rewritten to tracked callbacks. */
  clickTracking: boolean;
  /** When the row was last written, ISO-8601. */
  updatedAt: string;
}

/** Project one job for the list. */
export function jobListView(job: EmailJob): EmailJobListItem {
  return {
    id: job.id,
    recipient: maskAddress(job.toAddress),
    template: job.template,
    category: job.category,
    status: job.status,
    mode: job.mode,
    attempts: job.attempts,
    campaignId: job.campaignId ?? null,
    bounceType: job.bounceType ?? null,
    failed: Boolean(job.error),
    sendAt: job.sendAt.toISOString(),
    createdAt: job.createdAt.toISOString(),
    sentAt: job.sentAt ? job.sentAt.toISOString() : null,
  };
}

/** Project one job in full. */
export function jobDetailView(job: EmailJob): EmailJobDetail {
  const { recipient: _masked, failed: _failed, ...common } = jobListView(job);
  return {
    ...common,
    toAddress: job.toAddress,
    subject: job.subject,
    fromAddress: job.fromAddress,
    fromName: job.fromName,
    messageId: job.messageId ?? null,
    error: job.error ?? null,
    bounceCode: job.bounceCode ?? null,
    timezone: job.timezone ?? null,
    localTime: job.localTime ?? null,
    openTracking: job.openTracking,
    clickTracking: job.clickTracking,
    updatedAt: job.updatedAt.toISOString(),
  };
}

/** One suppressed address, as a management client sees it. */
export interface EmailSuppressionView {
  /** The row's surrogate key. */
  id: number;
  /** The blocked address, in full — the record is the address, so there is nothing to mask. */
  email: string;
  /** Why it is blocked: hard bounce, complaint, unsubscribe, or a manual block. */
  reason: string;
  /** The environment the triggering job came from; the block itself applies everywhere. */
  environment: string | null;
  /** The job that triggered it, when one did. */
  jobId: string | null;
  /** Free-form context — the bounce code, or what an operator typed when blocking by hand. */
  detail: string | null;
  /** When the address was blocked, ISO-8601. */
  createdAt: string;
  /** When a temporary block lifts, ISO-8601; null when permanent. */
  expiresAt: string | null;
  /**
   * Whether the block is in force right now.
   *
   * Computed rather than left to the client, because "is this person blocked" is the actual question
   * and answering it from `expiresAt` means every client re-implements the comparison the send path
   * already makes — and one of them gets the boundary wrong and tells an operator an expired block is
   * still stopping their mail.
   */
  active: boolean;
}

/** Project one suppression row, resolving `active` against `now`. */
export function suppressionView(row: EmailSuppression, now: Date): EmailSuppressionView {
  const expiresAt = row.expiresAt ?? null;
  return {
    id: row.id,
    email: row.email,
    reason: row.reason,
    environment: row.environment ?? null,
    jobId: row.jobId ?? null,
    detail: row.detail ?? null,
    createdAt: row.createdAt.toISOString(),
    expiresAt: expiresAt ? expiresAt.toISOString() : null,
    active: expiresAt === null || expiresAt.getTime() > now.getTime(),
  };
}
