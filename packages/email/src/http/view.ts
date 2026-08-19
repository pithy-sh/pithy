// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { EmailJob } from "../data/emailJob";
import type { EmailSuppression } from "../data/emailSuppression";
import type { EmailJobDetail, EmailJobListItem, EmailSuppressionView } from "./responses";

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
 * problem off — every failure landing on one provider is the diagnosis — and it names an organization
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

/**
 * ## The field lists live in `responses.ts`
 *
 * Every view type below is `z.output` of the Zod object there, so there is one declaration of what a
 * client receives rather than an interface here and a hand-written mirror of it in every management
 * client. A field added to one and not the other does not compile.
 */

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
