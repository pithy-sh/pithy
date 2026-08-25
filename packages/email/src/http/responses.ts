// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { EmailJobStatus, SendMode, SuppressionReason, TemplateCategory } from "../data/enums";

/**
 * What the email management routes return, as Zod objects a management client can validate against.
 *
 * `schemas.ts` bounds what a caller may send; this file states what it gets back. Both halves are
 * runtime values for the same reason: a management client reading a customer's Worker is crossing a
 * trust boundary and must validate what comes back, and a TypeScript interface is erased before it
 * can help. Every client that had only an interface hand-wrote a mirror of these, and the mirror
 * drifted the first time a field landed here.
 *
 * **No codecs, and no transform anywhere in this file.** These describe JSON on the wire, so parsing
 * one hands back exactly what went in — which is what lets `responses.test.ts` compare a parsed value
 * with the projection's output and fail on a field either side forgot.
 *
 * The projections live in `view.ts`, which documents *why* the list masks a recipient and the detail
 * does not, and why `payload` appears in neither. This file is the shape; that file is the argument.
 *
 * **A field added here later is `.optional()`, not merely `.nullable()`.** This module is read across a
 * version boundary — a management client validates a response with this schema against a customer's
 * Worker at whatever kit version it is on — so an additive required key fails `safeParse` for everyone
 * below that release and takes the whole pane with it (#450). Absent then means *this Worker cannot
 * say*, which is a different fact from `null`.
 */

/** Where a page resumes, or the end of the list. */
const NextCursor = z
  .string()
  .nullable()
  .describe("Where the next page resumes. Null at the end of the list. Opaque — pass it back verbatim.");

/** One job as the list shows it: enough to scan, not enough to harvest. */
export const EmailJobListItem = z
  .object({
    id: z.string().describe("The job id — what the detail and retry routes take."),
    recipient: z
      .string()
      .describe("The recipient, masked (`ad***@example.com`). The detail route has the whole address."),
    template: z
      .string()
      .describe("The template that produced this email. Structural, so it names the kind of mail with no content."),
    category: TemplateCategory.describe("`transactional` or `marketing`."),
    // Says what the tag *is*, and nothing about where it lives: this one declaration is also the
    // detail's, so a sentence placing the field on the list would be false on the route that inherits
    // it. Why the tag earns the list at all is argued in `view.ts`, which is where an argument belongs.
    locale: z
      .string()
      .nullable()
      .optional()
      .describe(
        "The language this message was written in, as a BCP-47 tag; null when the recipient never chose one and it went out in the kit's English, and absent when the Worker that answered predates the field (#450).",
      ),
    status: EmailJobStatus.describe("The lifecycle state."),
    mode: SendMode.describe("How the send time was decided."),
    attempts: z.number().int().describe("How many send attempts have been made."),
    campaignId: z.string().nullable().describe("The campaign this belongs to; null for transactional mail."),
    bounceType: z
      .string()
      .nullable()
      .describe(
        "How a bounce was classified (`hard` | `soft` | `complaint` | `auto_reply`), when one arrived. A loose string rather than the enum, because the column is one: a response schema that narrowed what the table admits would reject a row this Worker can legitimately hold, and the place to close that is the column, not the wire.",
      ),
    failed: z
      .boolean()
      .describe(
        "Whether the row carries an error, without carrying it — a provider error routinely embeds the recipient, so the text is on the detail route.",
      ),
    sendAt: z.iso.datetime().describe("When this job is (or was) due to send, ISO-8601."),
    createdAt: z.iso.datetime().describe("When the row was created, ISO-8601. The list's sort key."),
    sentAt: z.iso.datetime().nullable().describe("When the send succeeded, ISO-8601; null until then."),
  })
  .describe("One email job as the send log lists it. The recipient is masked and no rendered content appears.");
export type EmailJobListItem = z.output<typeof EmailJobListItem>;

/**
 * One job in full.
 *
 * Re-described after `.omit()`/`.extend()`: each builds a new schema, and a description does not
 * follow it.
 *
 * `locale` is **not** re-declared below. It is on the list item, so the detail inherits it and there is
 * one sentence describing the tag rather than two free to drift — and the fact the detail's own copy
 * used to carry, that null means nobody chose, is the fact the list needs most.
 */
export const EmailJobDetail = EmailJobListItem.omit({ recipient: true, failed: true })
  .extend({
    toAddress: z.string().describe("The recipient, in full. Disclosed one job at a time, and audited as such."),
    subject: z
      .string()
      .describe("The rendered subject line — the one piece of rendered content a send cannot be diagnosed without."),
    fromAddress: z.string().describe("The sending identity — the adopter's own configuration."),
    fromName: z.string().describe("The sender display name recipients saw."),
    messageId: z.string().nullable().describe("The Email Service message id a later bounce is attributed through."),
    error: z.string().nullable().describe("The last error recorded against this job; null when healthy."),
    bounceCode: z.string().nullable().describe("The SMTP or Email Service code from a bounce; null unless it bounced."),
    timezone: z.string().nullable().describe("The recipient's IANA timezone, for a `timezone`-mode send."),
    localTime: z.string().nullable().describe("The recipient-local time-of-day, for a `timezone`-mode send."),
    openTracking: z.boolean().describe("Whether an open-tracking pixel was injected."),
    clickTracking: z.boolean().describe("Whether links were rewritten to tracked callbacks."),
    updatedAt: z.iso.datetime().describe("When the row was last written, ISO-8601."),
  })
  .describe("One email job in full. Never the template payload — that is the sign-in link and the OTP.");
export type EmailJobDetail = z.output<typeof EmailJobDetail>;

/** One suppressed address, as a management client sees it. */
export const EmailSuppressionView = z
  .object({
    id: z.number().int().describe("The row's surrogate key — the handle the audit trail names."),
    email: z.string().describe("The blocked address, in full. The record is the address, so there is nothing to mask."),
    reason: SuppressionReason.describe("Why it is blocked: hard bounce, complaint, unsubscribe, or a manual block."),
    environment: z
      .string()
      .nullable()
      .describe("The environment the triggering job came from; the block itself applies everywhere."),
    jobId: z.string().nullable().describe("The job that triggered it, when one did."),
    detail: z.string().nullable().describe("Free-form context — the bounce code, or what an operator typed."),
    createdAt: z.iso.datetime().describe("When the address was blocked, ISO-8601."),
    expiresAt: z.iso.datetime().nullable().describe("When a temporary block lifts, ISO-8601; null when permanent."),
    active: z
      .boolean()
      .describe(
        "Whether the block is in force right now. Computed here, so no client re-implements the comparison the send path already makes.",
      ),
  })
  .describe("One suppressed address, with the block's provenance and whether it is in force.");
export type EmailSuppressionView = z.output<typeof EmailSuppressionView>;

/** `GET {base}/jobs`. */
export const EmailJobsResponse = z
  .object({
    jobs: z.array(EmailJobListItem).describe("The page, newest first."),
    nextCursor: NextCursor,
  })
  .describe("A page of the send log.");
export type EmailJobsResponse = z.output<typeof EmailJobsResponse>;

/** `GET {base}/jobs/:id`. */
export const EmailJobResponse = z
  .object({ job: EmailJobDetail.describe("The job, whole recipient included.") })
  .describe("One email job in full.");
export type EmailJobResponse = z.output<typeof EmailJobResponse>;

/** `POST {base}/jobs/:id/retry`. */
export const EmailJobRetryResponse = z
  .object({
    job: EmailJobDetail.describe("The job as the retry left it."),
    dispatched: z
      .boolean()
      .describe(
        "Whether a send Workflow actually started. False when no sender is bound — the row is queued, and nothing was mailed.",
      ),
  })
  .describe("The retried job, and whether a send actually started.");
export type EmailJobRetryResponse = z.output<typeof EmailJobRetryResponse>;

/** `GET {base}/suppressions`. */
export const EmailSuppressionsResponse = z
  .object({
    suppressions: z.array(EmailSuppressionView).describe("The page, newest first."),
    nextCursor: NextCursor,
  })
  .describe("A page of the suppression list.");
export type EmailSuppressionsResponse = z.output<typeof EmailSuppressionsResponse>;

/** `POST {base}/suppressions`. */
export const EmailSuppressResponse = z
  .object({
    suppression: EmailSuppressionView.nullable().describe(
      "The row as stored, read back so the response is the truth rather than the request echoed. Null only if the read-back found nothing.",
    ),
  })
  .describe("The address as the suppression list now holds it.");
export type EmailSuppressResponse = z.output<typeof EmailSuppressResponse>;

/**
 * `POST {base}/suppressions/remove`.
 *
 * The address is echoed because the caller sent it, normalized so the client learns which row was
 * addressed rather than guessing at the lowercasing. Nothing about the block that was lifted appears:
 * that is in the audit trail, where reading it needs its own grant.
 */
export const EmailUnsuppressResponse = z
  .object({
    email: z.string().describe("The address, normalized the way the suppression list stores it."),
    removed: z.boolean().describe("Whether a row was removed. False when the address was not on the list."),
  })
  .describe("Which address was unblocked, and whether there was anything to unblock.");
export type EmailUnsuppressResponse = z.output<typeof EmailUnsuppressResponse>;
