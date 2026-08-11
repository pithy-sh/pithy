// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import type { SubscriptionPricing } from "../../data/discount";
import type { PaymentsPurchase } from "../../data/purchase";
import type { PaymentsLemonSqueezyCredentials } from "../../secret/registry";
import { type LemonSqueezyHttpFetch, lemonSqueezyHttpFetch, lemonSqueezyJson } from "./api";

/**
 * What a Lemon Squeezy subscription pays now, what it becomes, and when.
 *
 * Read from the store rather than computed: the subscription object carries the discounted total for the
 * next renewal, the list total, and the discount in force. Pithy multiplies nothing — a second calculation
 * here would be a second answer to the one question a customer checks against their statement.
 *
 * Only a `subscription:` row can be asked. A money row records one closed period and has no "next", and an
 * order has no renewal at all, so both answer `undefined` — the same "nothing to say about this purchase"
 * the refresh path uses.
 */

/** What reading pricing needs. */
export interface LemonSqueezyPricingOptions {
  /** The rail's credentials. */
  credentials: PaymentsLemonSqueezyCredentials;
  /** The HTTP seam. Defaults to the runtime's `fetch`. */
  transport?: LemonSqueezyHttpFetch;
}

/** A subscription, narrowed to what pricing needs. `.loose()` — the store adds fields. */
const PricedSubscription = z
  .object({
    data: z
      .object({
        attributes: z
          .object({
            renews_at: z.string().nullish(),
            first_subscription_item: z.object({ price_id: z.number().optional() }).loose().nullish(),
          })
          .loose(),
      })
      .loose(),
  })
  .loose();

/** A subscription invoice preview — the store's own arithmetic for the next renewal. */
const PricedInvoice = z
  .object({
    data: z
      .object({
        attributes: z
          .object({
            currency: z.string().nullish(),
            subtotal: z.number().nullish(),
            total: z.number().nullish(),
            discount_total: z.number().nullish(),
          })
          .loose(),
      })
      .loose(),
  })
  .loose();

/** Read what this subscription pays, or `undefined` when the store has nothing to say. */
export async function readLemonSqueezyPricing(
  purchase: PaymentsPurchase,
  options: LemonSqueezyPricingOptions,
): Promise<SubscriptionPricing | undefined> {
  const key = purchase.providerTransactionId;
  if (!key.startsWith("subscription:")) return undefined;
  const id = key.slice("subscription:".length);

  const transport = options.transport ?? lemonSqueezyHttpFetch;
  const body = await lemonSqueezyJson(transport, `/subscriptions/${encodeURIComponent(id)}`, {
    what: `subscription ${id} pricing`,
    apiKey: options.credentials.apiKey,
    absentOn404: true,
  });
  if (body === undefined) return undefined;

  const subscription = PricedSubscription.safeParse(body);
  if (!subscription.success) return undefined;

  // The store's own figures for what the next renewal comes to, discounted and undiscounted.
  const invoice = await lemonSqueezyJson(transport, `/subscriptions/${encodeURIComponent(id)}/invoices`, {
    what: `subscription ${id} next invoice`,
    apiKey: options.credentials.apiKey,
    absentOn404: true,
  });
  const priced = invoice === undefined ? undefined : PricedInvoice.safeParse(invoice);
  const amounts = priced?.success === true ? priced.data.data.attributes : undefined;

  const renews = subscription.data.data.attributes.renews_at;
  return {
    currency: amounts?.currency ?? null,
    currentAmountMinor: amounts?.total ?? null,
    // The list price is the subtotal before the discount came off. Where the store reports no discount the
    // two coincide, which is exactly what `SubscriptionPricing` says an undiscounted subscription looks like.
    listAmountMinor: amounts?.subtotal ?? amounts?.total ?? null,
    discountCode: null,
    // Lemon Squeezy expresses a repeating discount's remaining life in periods rather than as a date, so the
    // renewal date is the honest answer to "when does this change" only when a discount is actually ending.
    // Absent that, null — which `SubscriptionPricing` documents as "no discount, or one that runs forever".
    discountEndsAt: (amounts?.discount_total ?? 0) > 0 && renews ? new Date(renews) : null,
  };
}
