// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { PaymentsProviderUnavailableError } from "../../error/errors";
import type { UsageReporter, UsageReportRequest } from "../../usage/reporter";
import { type PaddleEnvironment, type PaddleHttpFetch, paddleHttpFetch, paddleJson } from "./api";

/**
 * Reporting a count to Paddle: one one-time charge per reported period, on the subscription's next bill.
 *
 * **One per billing period, whatever the cadence.** Every charge is its own line on the bill, so a charge
 * per day would bill the sum of the days. The pass sends a `daily-peak` product's period once, at the
 * highest day it sampled (`usage/pass.ts`).
 *
 * `POST /subscriptions/{id}/charge` with `effective_from: "next_billing_period"` and one item — the product's
 * one-time per-unit price at the reported quantity. Paddle adds it to the next renewal's transaction.
 *
 * **It never rewrites the subscription's items.** That is the licensed-seat model, and the rail refuses to
 * rewrite an items array for anything but a single line. A charge adds; it changes nothing that is there,
 * so the recurring line keeps its quantity whatever is reported. The period's row id travels as the
 * idempotency key, so a report sent twice is one charge.
 */

/** As much of Paddle's answer as proves the charge landed on this subscription. */
const PaddleChargedSubscription = z
  .object({ id: z.string().describe("The subscription the charge was added to.") })
  .loose()
  .describe("The subscription Paddle answers a one-time charge with.");

/** The Paddle reporter, over the API key, the account and a transport. */
export function paddleUsageReporter(options: {
  apiKey: string;
  environment: PaddleEnvironment;
  transport?: PaddleHttpFetch;
}): UsageReporter {
  const transport = options.transport ?? paddleHttpFetch;
  return {
    async report(request: UsageReportRequest): Promise<void> {
      const priceId = request.billing.paddle?.priceId;
      if (priceId === undefined) {
        throw new PaymentsProviderUnavailableError({
          detail: `Paddle usage for ${request.providerSubscriptionId} has no price to charge it at.`,
        });
      }
      const answer = await paddleJson(
        transport,
        `/subscriptions/${encodeURIComponent(request.providerSubscriptionId)}/charge`,
        {
          what: "a one-time usage charge",
          apiKey: options.apiKey,
          environment: options.environment,
          method: "POST",
          body: { effective_from: "next_billing_period", items: [{ price_id: priceId, quantity: request.quantity }] },
          idempotencyKey: request.idempotencyKey,
        },
      );
      const charged = PaddleChargedSubscription.safeParse(answer?.data);
      if (!charged.success || charged.data.id !== request.providerSubscriptionId) {
        throw new PaymentsProviderUnavailableError({
          detail: `Paddle answered the usage charge for ${request.providerSubscriptionId} with a different subscription.`,
        });
      }
    },
  };
}
