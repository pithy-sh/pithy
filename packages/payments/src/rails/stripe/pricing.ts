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
        promotion_code: z.unknown().nullish(),
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

  // `/v1/invoices/create_preview`, not `/v1/invoices/upcoming`. The latter is what every older integration
  // guide shows and it is **gone** in the API version this rail pins (`2025-04-30.basil`) — so calling it
  // 404s, `absentOn404` swallows the 404, and every amount below comes back null. A pricing read that
  // silently reports nothing is worse than one that fails, because a screen renders the nothing.
  const upcoming = await stripeJson(transport, "/invoices/create_preview", {
    what: `subscription ${subscriptionId} next invoice`,
    secretKey: options.credentials.secretKey,
    form: { subscription: subscriptionId },
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
    // The code a customer typed, never the `promo_…` id. `SubscriptionPricing.discountCode` is typed as a
    // `DiscountCode` and is rendered on a billing screen; showing an opaque id there is showing the
    // customer a value that is not theirs and that they cannot match to the code they entered. Stripe
    // returns the id unless the discount is expanded, so an unexpanded one reports null rather than a lie.
    discountCode: promotionCode(subscription.discount?.promotion_code),
    // Seconds since the epoch on Stripe's side. Null means no discount, or one that runs forever — a screen
    // must read it beside `discountCode` to know which, which `SubscriptionPricing` says out loud.
    discountEndsAt: typeof end === "number" ? new Date(end * 1000) : null,
  };
}

/**
 * The customer-facing code off Stripe's `promotion_code` field, or null.
 *
 * Stripe returns either the id (`promo_…`) or, when expanded, the object carrying `code`. Only the second
 * is a code a customer would recognise; a bare id is reported as null, because "no code shown" is honest
 * and "PROMO_1QxYz" on a billing screen is not.
 */
function promotionCode(value: unknown): string | null {
  if (typeof value === "string") return value.startsWith("promo_") ? null : value;
  if (typeof value === "object" && value !== null) {
    const code = (value as { code?: unknown }).code;
    return typeof code === "string" && code !== "" ? code : null;
  }
  return null;
}
