// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { SQLiteBoolean, SQLiteDate, sqliteJson } from "@pithy-sh/core/src/data/codecs";
import { Locale } from "@pithy-sh/core/src/i18n/locale";
import { z } from "zod";
import { EmailJobStatus, SendMode, TemplateCategory } from "./enums";

/**
 * The template input variables, stored as a JSON column. The per-template Zod payload schema
 * validates these before a job is enqueued; the row keeps the validated object so the send Workflow
 * can re-render without the caller present. A bag of strings/unknowns at the row level — the template
 * id plus this payload reconstruct the email.
 */
export const EmailJobPayload = z
  .record(z.string(), z.unknown())
  .describe(
    "The validated template input variables for this job, re-rendered by the send Workflow. Empty once `payloadRedactedAt` is set — a transactional job's inputs are dropped when the message goes out.",
  );
export type EmailJobPayload = z.output<typeof EmailJobPayload>;

/**
 * What the `payload` column holds once a job's inputs are spent.
 *
 * An empty object, encoded through the same codec every other write uses rather than written as a
 * `"{}"` literal — a column this schema could not read back would turn a delivered job into a row that
 * throws when an operator opens it. The fact that it *was* redacted is `payloadRedactedAt`; this is
 * only what is left where the variables were.
 */
export const SPENT_PAYLOAD = sqliteJson(EmailJobPayload).encode({});

/**
 * One row in `pithy_email_jobs` — the spine of the capability. Every email is a row first: a request
 * handler only ever enqueues one, and the actual send always runs inside a Workflow. `z.output` is the
 * app shape (Dates, booleans); `z.input` is the SQLite row (ms-epoch, 0|1, JSON string).
 */
export const EmailJob = z
  .object({
    id: z
      .string()
      .describe(
        "UUID primary key. Text, not autoincrement, so a job id embedded in a tracking link cannot be enumerated.",
      ),
    toAddress: z
      .string()
      .describe("The recipient's email address. Lowercased and checked against the suppression list before sending."),
    recipientKey: z
      .string()
      .describe(
        "The recipient under `normalizeAddress` — the one form every comparison in the kit is against, and the only column anything matches a recipient on. `toAddress` deliberately keeps what the caller typed, because an operator diagnosing a send needs to see the string that was actually addressed; that makes it useless as a key, since `Ada@example.com` and `ada@example.com` are one mailbox and two rows. Doing the folding in SQL instead would not work: SQLite's `lower()` is ASCII-only while `normalizeAddress` is `toLowerCase()`, so the two disagree on exactly the addresses nobody tests with. The same value `pithy_email_events.recipient` is keyed on, so a job and its events agree on who the person is.",
      ),
    fromAddress: z.string().describe("The sender address. Must use a domain onboarded onto Cloudflare Email Service."),
    fromName: z.string().describe("The sender display name recipients see in their inbox."),
    subject: z.string().describe("The rendered subject line."),
    template: z.string().describe("The template id (e.g. `magicLink`, `newsletter`) used to render this email."),
    category: TemplateCategory.describe(
      "The template's category — drives unsubscribe enforcement and tracking defaults.",
    ),
    payload: sqliteJson(EmailJobPayload).describe(
      "The validated template input variables, as a JSON column. Emptied when the message is delivered, for every template whose category is `transactional` — see `payloadRedactedAt`.",
    ),
    payloadRedactedAt: SQLiteDate.nullish().describe(
      "When this job's inputs were dropped, or null while it still holds them. A magic link's payload *is* the sign-in link, so keeping it after delivery is a second, permanent copy of a credential in a table nobody thinks of as holding secrets. Null and an empty payload mean different things — the first is a job enqueued with no variables, the second is one whose variables were spent — which is why this is a timestamp and not the absence of data.",
    ),
    status: EmailJobStatus.describe("The job's lifecycle state."),
    mode: SendMode.describe("How this job's send time was determined."),
    attempts: z.number().int().describe("How many send attempts have been made; incremented on each Workflow try."),
    batchId: z
      .string()
      .nullish()
      .describe(
        "The send batch holding this job — the id of the send Workflow instance dispatched for it, minted by whoever claimed it. Null for a job nothing has claimed. This *is* the claim: liveness belongs to the batch, not to a row, so the scheduler asks the Workflow runtime whether this instance is still running rather than inferring it from how long ago the row was written.",
      ),
    sendAt: SQLiteDate.describe("The absolute time this job should send. Equal to creation time for immediate sends."),
    timezone: z.string().nullish().describe("The recipient's IANA timezone for `timezone` mode; null otherwise."),
    localTime: z
      .string()
      .nullish()
      .describe("The recipient-local time-of-day (e.g. `10:00`) for `timezone` mode; null otherwise."),
    campaignId: z
      .string()
      .nullish()
      .describe("The marketing campaign this job belongs to, for click/open attribution; null for transactional."),
    locale: Locale.nullish().describe(
      "The language this message is written in, as a BCP-47 tag; null when the recipient never chose one. **Null is not `en`** — it means nothing was chosen, so the render falls back to the kit's English rather than asserting English was picked, the same distinction `pithy_auth_users.locale` draws. It lives on the row because the two renders happen in different places at different times: the subject at enqueue, inside a request that knows the reader, and the body at send, inside a Workflow with no request on it at all. Without a stored locale those two could agree only by accident, and an operator opening a send log had nothing that explained why a subject read the way it did.",
    ),
    correlation: z
      .string()
      .nullish()
      .describe(
        "What this message was *about*, as the caller names it — the discriminator for a template that carries more than one kind of message. Opaque here: this capability never parses it, never renders it, and never puts it on a header or a link. Set at enqueue, matched by `sentSince`, indexed with `createdAt`. **Not `campaignId`**, which is documented marketing-only and is not merely a naming preference: `campaignId` is copied onto every `pithy_email_events` row, grouped by `campaignStats`, and signed into the click/open tracking token that travels in the URL of a delivered email — so a transactional discriminator put there would land in campaign analytics and in a string the recipient's mail client fetches. This column goes nowhere but this row. Null for a template whose id already says everything about what the message is, which is most of them.",
      ),
    openTracking: SQLiteBoolean.describe("Whether an open-tracking pixel was injected into the rendered HTML."),
    clickTracking: SQLiteBoolean.describe("Whether links were rewritten to tracked click-callback URLs."),
    messageId: z
      .string()
      .nullish()
      .describe(
        "The Email Service message id returned on send — the handle that ties an inbound bounce back to this job.",
      ),
    error: z
      .string()
      .nullish()
      .describe("The last error code/message recorded on a failed or retried send; null when healthy."),
    bounceCode: z
      .string()
      .nullish()
      .describe("The SMTP or Email Service code from a bounce/complaint; null unless the job bounced."),
    bounceType: z
      .string()
      .nullish()
      .describe(
        "The classification of a bounce (`hard`/`soft`/`complaint`/`auto_reply`); null unless the job bounced.",
      ),
    replyTo: z
      .string()
      .nullish()
      .describe(
        "The `Reply-To` address, when this job should be answered somewhere other than `fromAddress` — a support inbox replying from a no-reply sender is the case this exists for. Null for an ordinary send.",
      ),
    inReplyTo: z
      .string()
      .nullish()
      .describe(
        "The `In-Reply-To` header value, angle brackets included — the message this one answers. Null unless this job is a reply.",
      ),
    references: z
      .string()
      .nullish()
      .describe(
        "The `References` header value, angle-bracketed and space-separated. Stored as the wire string rather than a JSON array because that is exactly what goes on the header, and re-deriving it at send time is a second chance to get threading wrong. Null unless this job is a reply.",
      ),
    createdAt: SQLiteDate.describe("When the job row was created."),
    updatedAt: SQLiteDate.describe("When the job row was last written."),
    sentAt: SQLiteDate.nullish().describe("When the send succeeded; null until then."),
  })
  .describe("One email job in `pithy_email_jobs` — the auditable, retryable record of a single email.");
export type EmailJob = z.output<typeof EmailJob>;
