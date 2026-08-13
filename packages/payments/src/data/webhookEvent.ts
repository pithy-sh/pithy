// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { SQLiteDate, sqliteJson } from "@pithy-sh/core/src/data/codecs";
import { z } from "zod";
import { PaymentsRail } from "./rail";

/** A received notification body, as the rail delivered it. Only the envelope is fixed; shapes differ. */
const NotificationPayload = z
  .record(z.string(), z.unknown())
  .describe("The notification body as received, before any rail-specific interpretation.");

/**
 * One received provider notification — the row in `pithy_payments_webhook_events`, keyed
 * `UNIQUE (rail, providerEventId)`.
 *
 * All three providers deliver at-least-once and retry, so a redelivery is expected and must be recognized
 * rather than reprocessed. This is the replay source, and it is what makes "why didn't this renew"
 * answerable: `receivedAt` says whether the notification arrived at all, `processedAt` whether it was
 * projected, and `error` why not.
 */
export const PaymentsWebhookEvent = z
  .object({
    id: z.string().describe("The row's UUID."),
    rail: PaymentsRail.describe("Which store delivered the notification."),
    providerEventId: z
      .string()
      .describe(
        "The rail's own event id. `UNIQUE (rail, providerEventId)` — a redelivery is recognized, not reprocessed.",
      ),
    payload: sqliteJson(NotificationPayload).describe(
      "The notification body, Zod-validated on write and on read. The replay source, so it is stored whole.",
    ),
    receivedAt: SQLiteDate.describe("When the notification arrived. Present even for one that never processed."),
    processedAt: SQLiteDate.nullable().describe(
      "When the notification was projected, or null while it has not been. Null with an old `receivedAt` is the drift signal.",
    ),
    error: z
      .string()
      .nullable()
      .describe(
        "Why processing failed, or null. Internal text: it is read by an operator and never rendered to a client.",
      ),
    attempts: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        "How many times a repair pass has tried this event and failed. Optional because the webhook path neither retries nor counts, and the column defaults to 0 for it; the sweep uses it to bound how long one unprojectable event may hold the stream up before it is quarantined.",
      ),
    createdAt: SQLiteDate.describe("When this row was written."),
  })
  .describe("One received provider notification — the row in `pithy_payments_webhook_events`, the replay source.");
export type PaymentsWebhookEvent = z.output<typeof PaymentsWebhookEvent>;
export type PaymentsWebhookEventRow = z.input<typeof PaymentsWebhookEvent>;
