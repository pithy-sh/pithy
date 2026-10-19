// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import type { PaymentsRail } from "./rail";

/**
 * When a subscription's current billing period began — where payments knows, and only there.
 *
 * **The rails disagree about what a row is.** Stripe and Apple write a row per billing period, so a row's
 * `purchasedAt` is its period's start. Paddle writes one state row per subscription and moves it forward at
 * each renewal, so its `purchasedAt` is when the subscription was created — and the period it is in is in the
 * stored subscription's `current_billing_period`. Google and Lemon Squeezy rows carry the subscription's
 * start too, and no stored field states the current period's.
 *
 * So this answers for the first three and says nothing for the last two. A meter keyed on a `purchasedAt`
 * that never moves would never start a new period — a customer's allowance used up once, forever — which is
 * why an unknown start is `undefined` and the caller falls back to the calendar month rather than guessing.
 */

/** The slice of a Paddle subscription this reads. */
const PaddleBillingPeriod = z
  .object({
    current_billing_period: z
      .object({ starts_at: z.string().describe("When the period began, ISO-8601.") })
      .nullish()
      .describe("The period being billed."),
  })
  .loose()
  .describe("The billing period a stored Paddle subscription is in.");

/** The current period's start for one subscription row, or undefined where the row does not state one. */
export function knownPeriodStart(row: {
  rail: PaymentsRail;
  purchasedAt: Date;
  payload: Record<string, unknown>;
}): Date | undefined {
  switch (row.rail) {
    case "stripe":
    case "apple":
      return row.purchasedAt;
    case "paddle": {
      const parsed = PaddleBillingPeriod.safeParse(row.payload);
      const starts = parsed.success ? parsed.data.current_billing_period?.starts_at : undefined;
      if (starts === undefined) return undefined;
      const at = new Date(starts);
      return Number.isNaN(at.getTime()) ? undefined : at;
    }
    case "google":
    case "lemonSqueezy":
      return undefined;
  }
}
