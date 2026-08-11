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
            first_subscription_item: z.object({ price_id: z.number().optional() }).loose().nullish(),
          })
          .loose(),
      })
      .loose(),
  })
  .loose();

/**
 * The subscription's invoices — a **collection**, which is what `/v1/subscription-invoices` returns.
 *
 * `data` is an array. Parsing it as a single resource is the defect this replaced: `safeParse` failed
 * silently, every amount fell back to null, and `GET /payments/pricing` reported nothing for every Lemon
 * Squeezy subscriber while looking like it had worked.
 */
const PricedInvoices = z
  .object({
    data: z.array(
      z
        .object({
          attributes: z
            .object({
              currency: z.string().nullish(),
              subtotal: z.number().nullish(),
              total: z.number().nullish(),
              discount_total: z.number().nullish(),
              created_at: z.string().nullish(),
            })
            .loose(),
        })
        .loose(),
    ),
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

  // The store's own figures, from its most recent invoice for this subscription. A filtered collection on
  // `/v1/subscription-invoices` — there is no `/subscriptions/{id}/invoices` sub-resource, and asking for
  // one 404s into a silently empty answer.
  const invoices = await lemonSqueezyJson(transport, "/subscription-invoices", {
    what: `subscription ${id} invoices`,
    apiKey: options.credentials.apiKey,
    query: { "filter[subscription_id]": id, "page[size]": "1", sort: "-created_at" },
    absentOn404: true,
  });
  const priced = invoices === undefined ? undefined : PricedInvoices.safeParse(invoices);
  const amounts = priced?.success === true ? priced.data.data[0]?.attributes : undefined;

  return {
    currency: amounts?.currency ?? null,
    currentAmountMinor: amounts?.total ?? null,
    // The list price is the subtotal before the discount came off. Where the store reports no discount the
    // two coincide, which is exactly what `SubscriptionPricing` says an undiscounted subscription looks like.
    listAmountMinor: amounts?.subtotal ?? amounts?.total ?? null,
    discountCode: null,
    // **Null, always, on this rail — and that is the honest answer rather than a gap.**
    //
    // `SubscriptionPricing.discountEndsAt` means "the date this rate stops". Lemon Squeezy expresses a
    // repeating discount's remaining life in billing *periods* on the discount object, and does not publish
    // the resulting date on the subscription. The previous code returned `renews_at` whenever the last
    // invoice carried any discount at all, which reported the **next renewal** as the end date for a
    // discount running for another eleven periods — telling a customer their bill changes next month when
    // it does not, which is the same class of surprise this field exists to prevent, pointed the other way.
    //
    // Null is documented as "no discount, or one that runs forever". A screen reads it beside
    // `discountCode`; both null on this rail means "we cannot say", which is true.
    discountEndsAt: null,
  };
}
