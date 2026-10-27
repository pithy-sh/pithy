// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import { SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import { z } from "zod";

/**
 * The `pithy_audit_sinks` table (#824) — one row per declared sink, written by the shipping consumer and read by
 * the manifest's health keys. It holds what the queue cannot be asked: when the sink last took a delivery, when it
 * last refused one, how many events are waiting on a retry, and how many were given up on.
 *
 * A row per **sink**, keyed by the name it is declared under, so a health read is a primary-key lookup per declared
 * sink — bounded by the config, never by the trail. A sink renamed or removed leaves its row behind, read by
 * nothing, and a sink declared again under the same name picks its counts back up.
 *
 * It records delivery, never the trail: no event, no value, no response body from the receiver.
 */
export const AuditSinkStateRow = z
  .object({
    sink: z.string().describe("The sink's name, as `audit({ sinks })` declares it. Primary key."),
    lastDeliveredAt: SQLiteDate.nullable().describe(
      "When the sink last accepted a delivery. Ms-epoch in SQLite, a `Date` in app code; null until the first.",
    ),
    lastFailedAt: SQLiteDate.nullable().describe(
      "When the sink last refused a delivery or could not be reached; null until the first failure.",
    ),
    retrying: z
      .number()
      .int()
      .min(0)
      .describe("How many events are waiting on a retry to this sink: its backlog of failed deliveries."),
    deadLettered: z
      .number()
      .int()
      .min(0)
      .describe(
        "How many events exhausted their retries and went to the dead-letter queue, since the sink was first declared.",
      ),
  })
  .describe("One sink's delivery state: its last delivery, its last failure, its backlog, and what it gave up on.");
export type AuditSinkStateRow = z.output<typeof AuditSinkStateRow>;
