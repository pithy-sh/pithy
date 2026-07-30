// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import { z } from "zod";
import { EmailEventType } from "./enums";

/**
 * One row in `pithy_email_events` — a per-recipient event for history and campaign attribution. The
 * send path, the click/open/unsubscribe callbacks, and the inbound bounce handler all append here.
 * `z.output` is the app shape; `z.input` is the SQLite row.
 */
export const EmailEvent = z
  .object({
    id: z.number().int().describe("Surrogate primary key, autoincremented by SQLite."),
    jobId: z.string().describe("The `pithy_email_jobs.id` this event belongs to."),
    recipient: z.string().describe("The recipient address the event is about."),
    type: EmailEventType.describe(
      "What happened: sent, open, click, bounce, complaint, unsubscribe, suppressed, or failed.",
    ),
    linkLabel: z
      .string()
      .nullish()
      .describe("For a `click` event, the link's identity/label as declared at render; null otherwise."),
    linkUrl: z
      .string()
      .nullish()
      .describe("For a `click` event, the destination URL that was followed; null otherwise."),
    campaignId: z
      .string()
      .nullish()
      .describe("The marketing campaign this event is attributed to; null for transactional."),
    detail: z
      .string()
      .nullish()
      .describe(
        "Free-form context — a bounce code, the user agent on an open, the suppression reason; null when not applicable.",
      ),
    createdAt: SQLiteDate.describe("When the event was recorded."),
  })
  .describe("One per-recipient email event in `pithy_email_events`.");
export type EmailEvent = z.output<typeof EmailEvent>;
