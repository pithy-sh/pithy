// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import { z } from "zod";
import { PaymentsRail } from "./rail";

/**
 * Where a resumable sweep of a provider's stream left off — the row in `pithy_payments_sync_cursors`,
 * keyed `UNIQUE (rail, name)`.
 *
 * **This is not a copy of a provider's data**, and the distinction matters enough to state: the row holds
 * one opaque resume token and two timestamps. No amount, no customer, no event body. The alternative to
 * storing it is re-reading ninety days of somebody else's event stream on every run, which is worse for
 * them as well as for us.
 *
 * One rail may sweep more than one stream, so the key is `(rail, name)` rather than the rail alone. Paddle
 * has exactly one today — {@link PADDLE_EVENTS_CURSOR} — and the second column is what stops a second one
 * needing a migration.
 */
export const PaymentsSyncCursor = z
  .object({
    id: z.string().describe("The row's UUID."),
    rail: PaymentsRail.describe("Which store's stream this cursor points into."),
    name: z
      .string()
      .describe("Which of that store's streams. One rail may have several, so the name is part of the key."),
    cursor: z
      .string()
      .nullable()
      .describe(
        "The provider's own resume token — Paddle's `evt_…` — or null for a stream never swept. Null is a real state and means 'start at the oldest event the provider still retains', not 'unknown'.",
      ),
    updatedAt: SQLiteDate.describe(
      "When the cursor last advanced. Read against the provider's retention window: a cursor older than it can never be caught up, and the sweep reports that gap rather than restarting from the beginning.",
    ),
    createdAt: SQLiteDate.describe("When this row was written."),
  })
  .describe("Where a resumable sweep of a provider's event stream left off. One opaque token, and nothing else.");
export type PaymentsSyncCursor = z.output<typeof PaymentsSyncCursor>;
export type PaymentsSyncCursorRow = z.input<typeof PaymentsSyncCursor>;

/** The name of Paddle's events-stream cursor. One per rail per stream; this rail has one. */
export const PADDLE_EVENTS_CURSOR = "events";
