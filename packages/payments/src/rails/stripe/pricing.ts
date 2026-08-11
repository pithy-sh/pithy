// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import type { SubscriptionPricing } from "../../data/discount";
import type { PaymentsPurchase } from "../../data/purchase";
import type { PaymentsStripeCredentials } from "../../secret/registry";
import { type StripeHttpFetch, stripeHttpFetch, stripeJson } from "./api";

/**
 * What a Stripe subscription pays now, what it becomes, and when.
 *
 * Read from the store rather than computed. Stripe carries the discount on the subscription and the
 * arithmetic on an upcoming invoice, so both are asked for and neither is derived: Pithy never multiplies a
 * price by a percentage, here or anywhere.
 *
 * **`discountEndsAt` is the field this exists for.** Stripe reports a repeating discount's `end` on the
 * subscription's discount object, and that date is what a customer must be told — a rate that lapses with
 * nothing having said so is, from their seat, a billing error.
 */

/** What reading pricing needs. */
export interface StripePricingOptions {
  /** Stripe's credential block. Only `secretKey` is used here. */
  credentials: PaymentsStripeCredentials;
  /** The HTTP seam. Defaults to the runtime's `fetch`. */
  transport?: StripeHttpFetch;
}

/** A subscription, narrowed to the discount in force. */
const DiscountedSubscription = z
  .object({
    currency: z.string().nullish(),
    discount: z
      .object({
        end: z.number().nullish(),
        promotion_code: z.string().nullish(),
        coupon: z.object({ name: z.string().nullish() }).loose().nullish(),
      })
      .loose()
      .nullish(),
    items: z
      .object({ data: z.array(z.object({ price: z.object({ unit_amount: z.number().nullish() }).loose() }).loose()) })
      .loose()
      .nullish(),
  })
  .loose();

/** The upcoming invoice, which is Stripe's own answer to "what comes off and what is left". */
const UpcomingInvoice = z
  .object({ currency: z.string().nullish(), total: z.number().nullish(), subtotal: z.number().nullish() })
  .loose();

/** Read what this subscription pays, or `undefined` when Stripe has nothing to say. */
export async function readStripePricing(
  purchase: PaymentsPurchase,
  options: StripePricingOptions,
): Promise<SubscriptionPricing | undefined> {
  // A Stripe subscription row's family key is the `sub_…` it belongs to; a one-off has none and has no
  // renewal to price.
  const subscriptionId = purchase.originalTransactionId;
  if (subscriptionId === null || !subscriptionId.startsWith("sub_")) return undefined;

  const transport = options.transport ?? stripeHttpFetch;
  const found = await stripeJson(transport, `/subscriptions/${encodeURIComponent(subscriptionId)}`, {
    what: `subscription ${subscriptionId} pricing`,
    secretKey: options.credentials.secretKey,
    absentOn404: true,
  });
  if (found === undefined) return undefined;

  const parsed = DiscountedSubscription.safeParse(found);
  if (!parsed.success) return undefined;
  const subscription = parsed.data;

  const upcoming = await stripeJson(transport, "/invoices/upcoming", {
    what: `subscription ${subscriptionId} next invoice`,
    secretKey: options.credentials.secretKey,
    query: { subscription: subscriptionId },
    absentOn404: true,
  });
  const invoice = upcoming === undefined ? undefined : UpcomingInvoice.safeParse(upcoming);
  const amounts = invoice?.success === true ? invoice.data : undefined;

  // The list price falls back to the item's own unit amount when there is no upcoming invoice to read —
  // a subscription cancelled at period end has none, and its list price is still a fact.
  const listed = subscription.items?.data[0]?.price.unit_amount ?? null;
  const end = subscription.discount?.end;

  return {
    currency: amounts?.currency ?? subscription.currency ?? null,
    currentAmountMinor: amounts?.total ?? null,
    listAmountMinor: amounts?.subtotal ?? listed,
    discountCode: subscription.discount?.promotion_code ?? null,
    // Seconds since the epoch on Stripe's side. Null means no discount, or one that runs forever — a screen
    // must read it beside `discountCode` to know which, which `SubscriptionPricing` says out loud.
    discountEndsAt: typeof end === "number" ? new Date(end * 1000) : null,
  };
}
