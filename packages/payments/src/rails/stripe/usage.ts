// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { PaymentsProviderUnavailableError } from "../../error/errors";
import type { UsageReporter, UsageReportRequest } from "../../usage/reporter";
import { type StripeHttpFetch, stripeHttpFetch, stripeJson } from "./api";

/**
 * Reporting a count to Stripe: one Billing Meter event per reported period.
 *
 * `POST /v1/billing/meter_events` with the meter's `event_name`, the customer, the count as `value`, and the
 * period's row id as `identifier` — which Stripe enforces as unique, so a report sent twice is one event. The
 * subscription's metered price reads the meter, and the meter's own aggregation over the period — a setting
 * on the meter in Stripe, not here — is what the invoice bills. Summed, one `period-end` report bills its
 * count and a month of `daily-peak` reports bills seat-days.
 *
 * The timestamp is the report's own `at`, which the pass dates inside the period it bills, so the event
 * lands on that period's invoice.
 */

/** What Stripe answers for a recorded meter event — as much as proves it recorded this one. */
const StripeMeterEvent = z
  .object({
    object: z.literal("billing.meter_event").describe("Always `billing.meter_event`."),
    event_name: z.string().describe("The meter the event was recorded against."),
    identifier: z.string().describe("The idempotency identifier the event was recorded under."),
  })
  .loose()
  .describe("A Stripe Billing Meter event, as Stripe answers its creation.");

/** The Stripe reporter, over the secret key and a transport. */
export function stripeUsageReporter(options: { secretKey: string; transport?: StripeHttpFetch }): UsageReporter {
  const transport = options.transport ?? stripeHttpFetch;
  return {
    async report(request: UsageReportRequest): Promise<void> {
      const meter = request.billing.stripe?.meterEventName;
      if (meter === undefined || request.providerCustomerId === undefined) {
        throw new PaymentsProviderUnavailableError({
          detail: `Stripe usage for ${request.providerSubscriptionId} has no ${meter === undefined ? "meter event name" : "customer"} to report against.`,
        });
      }
      const answer = await stripeJson(transport, "/billing/meter_events", {
        what: "a meter event",
        secretKey: options.secretKey,
        form: {
          event_name: meter,
          identifier: request.idempotencyKey,
          timestamp: Math.floor(request.at.getTime() / 1000),
          payload: { stripe_customer_id: request.providerCustomerId, value: String(request.quantity) },
        },
      });
      const event = StripeMeterEvent.safeParse(answer);
      if (!event.success || event.data.identifier !== request.idempotencyKey) {
        throw new PaymentsProviderUnavailableError({
          detail: `Stripe answered the meter event for ${request.providerSubscriptionId} with something that is not that event.`,
        });
      }
    },
  };
}
