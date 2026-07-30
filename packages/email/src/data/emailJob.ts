// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { SQLiteBoolean, SQLiteDate, sqliteJson } from "@pithy-sh/core/src/data/codecs";
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
  .describe("The validated template input variables for this job, re-rendered by the send Workflow.");
export type EmailJobPayload = z.output<typeof EmailJobPayload>;

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
    fromAddress: z.string().describe("The sender address. Must use a domain onboarded onto Cloudflare Email Service."),
    fromName: z.string().describe("The sender display name recipients see in their inbox."),
    subject: z.string().describe("The rendered subject line."),
    template: z.string().describe("The template id (e.g. `magicLink`, `newsletter`) used to render this email."),
    category: TemplateCategory.describe(
      "The template's category — drives unsubscribe enforcement and tracking defaults.",
    ),
    payload: sqliteJson(EmailJobPayload).describe("The validated template input variables, as a JSON column."),
    status: EmailJobStatus.describe("The job's lifecycle state."),
    mode: SendMode.describe("How this job's send time was determined."),
    attempts: z.number().int().describe("How many send attempts have been made; incremented on each Workflow try."),
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
    createdAt: SQLiteDate.describe("When the job row was created."),
    updatedAt: SQLiteDate.describe("When the job row was last written."),
    sentAt: SQLiteDate.nullish().describe("When the send succeeded; null until then."),
  })
  .describe("One email job in `pithy_email_jobs` — the auditable, retryable record of a single email.");
export type EmailJob = z.output<typeof EmailJob>;
