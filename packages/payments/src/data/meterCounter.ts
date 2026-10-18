// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import { z } from "zod";
import { PaymentsSubject } from "./subject";

/**
 * How much of one meter one subject used in one period — the row in `pithy_payments_meter_counters`, keyed
 * `UNIQUE (subjectType, subjectId, meter, periodStart)`.
 *
 * **A counter, not a scan.** Counting a period's emails by reading the jobs table would be a range scan on
 * every send, and it would count rows the email capability prunes. One row per period, incremented in the
 * same statement that checks the limit, is both cheaper and the only shape a concurrent burst cannot walk
 * past.
 *
 * **A new period starts at zero with nothing to reset it.** The period's start is half the key, so the first
 * charge of a new period lands on a row that does not exist yet. There is no cron, no sweep, no reset job.
 *
 * **It refuses and never bills.** Nothing reads this table to report usage to a store: the kit does not sell
 * overage, and a meter joined to a bill would make every counter a money path.
 */
export const PaymentsMeterCounter = z
  .object({
    id: z.string().describe("The row's UUID."),
    subjectType: PaymentsSubject.shape.subjectType.describe("Whether `subjectId` names a user or an organization."),
    subjectId: PaymentsSubject.shape.subjectId.describe("The subject whose usage this counts."),
    meter: z.string().describe("The meter counted — `emails`."),
    periodStart: SQLiteDate.describe(
      "When the period this row counts began: the subscription's billing period where payments knows one, the calendar month (UTC) where it does not.",
    ),
    used: z.number().int().nonnegative().describe("How many were charged against the meter in this period."),
    createdAt: SQLiteDate.describe("When the period's first charge landed."),
    updatedAt: SQLiteDate.describe("When the period's last charge landed."),
  })
  .describe("One subject's usage of one meter in one period — the row in `pithy_payments_meter_counters`.");
export type PaymentsMeterCounter = z.output<typeof PaymentsMeterCounter>;
export type PaymentsMeterCounterRow = z.input<typeof PaymentsMeterCounter>;
