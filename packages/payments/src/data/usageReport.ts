// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import { z } from "zod";
import { PaymentsReportCadence } from "../config/config";
import { PaymentsRail } from "./rail";
import { PaymentsSubject } from "./subject";

/**
 * Where a reported period stands.
 *
 * - `sampling` — a `daily-peak` day. The row holds the day's high-water mark; a lower later answer never
 *   lowers it. A day is never sent itself: its period's report is the highest of its days, and the day rows
 *   are the audit of that number.
 * - `claimed` — a report is being sent, or was sent and not yet confirmed. Claimed **before** the store is
 *   called, so a second run arriving mid-call finds the row taken. A claim whose call failed stays claimed,
 *   and the next run sends it again **under the same idempotency key** — the row's id — so a call that did
 *   land and lost only its answer is recorded once by the store rather than billed twice.
 * - `reported` — the store accepted it. Nothing reports this period again.
 */
export const UsageReportStatus = z
  .enum(["sampling", "claimed", "reported"])
  .describe(
    "Where one row stands: a daily-peak day's sample, a period's report in flight, or a period reported and final.",
  );
export type UsageReportStatus = z.infer<typeof UsageReportStatus>;

/**
 * One reported period of one subscription — the row in `pithy_payments_usage_reports`, keyed
 * `UNIQUE (rail, providerSubscriptionId, period)`.
 *
 * **The key is the idempotency.** A replayed run, two runs racing, a Workflow step retried after the store
 * answered — each finds the row and sends nothing, because the period has one row and a row is claimed
 * before anything is sent.
 *
 * **The quantity is the adopter's, never a meter's.** It is the answer `resolveQuantity` gave, and nothing
 * here reads `pithy_payments_meter_counters`: the kit does not sell overage.
 */
export const PaymentsUsageReport = z
  .object({
    id: z.string().describe("The row's UUID."),
    rail: PaymentsRail.describe("The store the count is reported to."),
    providerSubscriptionId: z.string().describe("The store's own subscription id — `sub_…`."),
    purchaseId: z.string().describe("The purchase row of the period this report is about."),
    productId: z.string().describe("The catalog product being billed by quantity."),
    subjectType: PaymentsSubject.shape.subjectType.describe("Whether `subjectId` names a user or an organization."),
    subjectId: PaymentsSubject.shape.subjectId.describe("The subject the subscription belongs to."),
    cadence: PaymentsReportCadence.describe("How the product reports — once per period, or each day's peak."),
    period: z
      .string()
      .describe(
        "Which period this is: the billing period's end as ISO-8601 for a period's report, under either cadence; the UTC day `YYYY-MM-DD` for a `daily-peak` day's sample.",
      ),
    quantity: z.number().int().nonnegative().describe("The count reported, or for a sampling day the peak so far."),
    status: UsageReportStatus.describe("Where the period stands."),
    sampledAt: SQLiteDate.describe("When the resolver was last asked for this period."),
    reportedAt: SQLiteDate.nullable().describe("When the store accepted the report, or null until it has."),
    createdAt: SQLiteDate.describe("When the period was first seen."),
    updatedAt: SQLiteDate.describe("When the row last changed."),
  })
  .describe("One reported period of one subscription — the row in `pithy_payments_usage_reports`.");
export type PaymentsUsageReport = z.output<typeof PaymentsUsageReport>;
export type PaymentsUsageReportRow = z.input<typeof PaymentsUsageReport>;
