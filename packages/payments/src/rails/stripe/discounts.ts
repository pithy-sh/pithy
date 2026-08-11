// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import type { CreatedDiscount, DiscountTerms } from "../../data/discount";
import { PaymentsDiscountInvalidError, PaymentsProviderUnavailableError } from "../../error/errors";
import type { PaymentsStripeCredentials } from "../../secret/registry";
import type { ListedDiscount } from "../contract";
import { type StripeFormObject, type StripeHttpFetch, stripeHttpFetch, stripeJson } from "./api";

/**
 * Minting a discount at Stripe, from the normalized terms.
 *
 * Stripe models a discount as **two objects**: a Coupon, which carries the money and the duration, and a
 * Promotion Code, which is the string a customer types and carries the redemption limit and the redeem-by
 * date. Both are created here, in that order, because the second references the first.
 *
 * ## The two translations that decide whether a customer is charged correctly
 *
 * **Duration.** `DiscountDuration` counts **billing periods**, because that is what a customer experiences.
 * Stripe's `duration_in_months` counts **months**. On a monthly plan they coincide, which is exactly why the
 * mistranslation survives review: on an annual plan `12` means one year to the customer and twelve years to
 * Stripe. So the conversion multiplies by the plan's interval, and `billingInterval` is required on the
 * terms rather than assumed — `discounts.test.ts` pins an annual plan in both directions.
 *
 * **Expiry.** `redeemableUntil` means the code can no longer be *claimed*, and anyone already holding it
 * keeps their rate. Stripe's `redeem_by` on a Promotion Code is exactly that, and deliberately not the
 * Coupon's own `redeem_by`, which would be the same word applied one level up. A test asserts an existing
 * redemption survives the date.
 *
 * ## What Stripe decides and Pithy does not
 *
 * Whether a code is still usable, what a discounted invoice comes to, and whether a fixed amount can apply
 * to a given subscription. Pithy refuses a currency mismatch it can see before creation, because that
 * failure would otherwise arrive at the customer at redemption rather than at the adopter at creation — but
 * it computes no prices and re-checks no redemptions.
 */

/** What creating a discount needs: the key, and the transport to reach Stripe through. */
export interface StripeDiscountOptions {
  /** Stripe's credential block. Only `secretKey` is used here. */
  credentials: PaymentsStripeCredentials;
  /** The HTTP seam. Defaults to the runtime's `fetch`. */
  transport?: StripeHttpFetch;
}

/** A created Coupon, narrowed to its id. */
const StripeCoupon = z.object({ id: z.string().min(1) }).loose();

/** A created Promotion Code, narrowed to what an adopter needs back. */
const StripePromotionCode = z.object({ id: z.string().min(1), code: z.string().min(1) }).loose();

/**
 * How many months Stripe should be told, for a duration this package counts in billing periods.
 *
 * The whole of the annual-plan defect lives in this function, which is why it is one named thing with a test
 * against it rather than an expression inline.
 */
export function durationInMonths(billingPeriods: number, interval: "month" | "year"): number {
  return interval === "year" ? billingPeriods * 12 : billingPeriods;
}

/** Create a Coupon and a Promotion Code for it, and return the code a customer will type. */
export async function createStripeDiscount(
  terms: DiscountTerms,
  options: StripeDiscountOptions,
): Promise<CreatedDiscount> {
  const transport = options.transport ?? stripeHttpFetch;

  const coupon: StripeFormObject =
    terms.amount.kind === "percent"
      ? { percent_off: terms.amount.percent }
      : { amount_off: terms.amount.amountMinor, currency: terms.amount.currency };

  // `once` and `forever` are Stripe's own words for the same ideas; only `repeating` needs converting.
  coupon.duration = terms.duration.kind;
  if (terms.duration.kind === "repeating") {
    coupon.duration_in_months = durationInMonths(terms.duration.billingPeriods, terms.billingInterval ?? "month");
  }

  const created = await stripeJson(transport, "/coupons", {
    what: "a discount",
    secretKey: options.credentials.secretKey,
    form: coupon,
  });
  const parsedCoupon = StripeCoupon.safeParse(created);
  if (!parsedCoupon.success) {
    throw new PaymentsProviderUnavailableError({ detail: "Stripe created a coupon and returned no id." });
  }

  const promotion: StripeFormObject = { coupon: parsedCoupon.data.id };
  if (terms.code !== undefined) promotion.code = terms.code;
  if (terms.maxRedemptions !== undefined) promotion.max_redemptions = terms.maxRedemptions;
  // Seconds since the epoch, and on the Promotion Code rather than the Coupon: this date stops the code
  // being *claimed*, and a customer who already redeemed it keeps their rate for its full duration.
  if (terms.redeemableUntil !== undefined) {
    promotion.redeem_by = Math.floor(terms.redeemableUntil.getTime() / 1000);
  }

  const madeCode = await stripeJson(transport, "/promotion_codes", {
    what: "a discount code",
    secretKey: options.credentials.secretKey,
    form: promotion,
  });
  const parsedCode = StripePromotionCode.safeParse(madeCode);
  if (!parsedCode.success) {
    throw new PaymentsDiscountInvalidError({
      detail: `Stripe created coupon ${parsedCoupon.data.id} but would not attach a promotion code to it.`,
    });
  }

  return { code: parsedCode.data.code, providerDiscountId: parsedCode.data.id, terms };
}

/** Stripe's promotion-code list, narrowed to what a management pane shows. */
const StripePromotionList = z
  .object({
    data: z.array(
      z
        .object({
          id: z.string().min(1),
          code: z.string().min(1),
          times_redeemed: z.number().nullish(),
          coupon: z
            .object({
              percent_off: z.number().nullish(),
              amount_off: z.number().nullish(),
              currency: z.string().nullish(),
            })
            .loose()
            .nullish(),
        })
        .loose(),
    ),
  })
  .loose();

/** The promotion codes this account holds, newest first. */
export async function listStripeDiscounts(options: StripeDiscountOptions): Promise<readonly ListedDiscount[]> {
  const found = await stripeJson(options.transport ?? stripeHttpFetch, "/promotion_codes", {
    what: "the discount codes",
    secretKey: options.credentials.secretKey,
    query: { limit: DISCOUNT_PAGE },
  });
  const parsed = StripePromotionList.safeParse(found);
  if (!parsed.success) return [];
  return parsed.data.data.map((promotion) => ({
    code: promotion.code,
    providerDiscountId: promotion.id,
    amount:
      promotion.coupon?.percent_off != null
        ? `${promotion.coupon.percent_off}%`
        : `${promotion.coupon?.amount_off ?? 0} ${promotion.coupon?.currency ?? ""}`.trim(),
    redemptions: promotion.times_redeemed ?? null,
  }));
}

/** One page of codes. A discount list is small by nature; this bounds it without inventing pagination. */
const DISCOUNT_PAGE = 100;
