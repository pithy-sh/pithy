// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import type { CreatedDiscount, DiscountTerms } from "../../data/discount";
import { PaymentsDiscountInvalidError } from "../../error/errors";
import type { PaymentsLemonSqueezyCredentials } from "../../secret/registry";
import type { ListedDiscount } from "../contract";
import { type LemonSqueezyHttpFetch, lemonSqueezyHttpFetch, lemonSqueezyJson } from "./api";

/**
 * Minting a discount at Lemon Squeezy, from the normalized terms.
 *
 * One object rather than Stripe's two: a Discount carries the money, the duration, the redemption limit and
 * the expiry together, and the code is a field on it rather than a separate object.
 *
 * ## The two translations that decide whether a customer is charged correctly
 *
 * **Duration.** Lemon Squeezy counts in **billing periods** — `duration_in_months` is its field name, and
 * the name is a trap, because the store applies the number to renewals rather than to months. That happens
 * to be the unit `DiscountDuration` already uses, so the number passes through unchanged. **This is the rail
 * where the value is *not* converted, and Stripe is the one where it is** — which is precisely why neither
 * rail's field name was allowed to become the normalized one. `discounts.test.ts` pins an annual plan on
 * both rails and asserts the two produce the same customer-visible term from different numbers.
 *
 * **Expiry.** `redeemableUntil` means the code can no longer be *claimed*. Lemon Squeezy's `expires_at`
 * stops redemption and leaves an existing subscriber's discount running, which is the same meaning — so it
 * maps directly, and a test pins that a code already redeemed keeps its rate past the date.
 *
 * ## Amount, and the currency that arrives at the customer
 *
 * A fixed amount carries a currency; Lemon Squeezy applies it against a store whose subscriptions have their
 * own. A mismatch is not refused at creation by the store — it fails at *redemption*, in front of whoever
 * typed the code. `createDiscount` on this rail therefore refuses a fixed amount in a currency the store
 * does not use before sending anything, naming both currencies, which is the only moment the adopter is
 * still the one reading the error.
 */

/** What creating a discount needs: the credentials, the store's currency, and the transport. */
export interface LemonSqueezyDiscountOptions {
  /** The rail's credentials. `apiKey` creates; `storeId` says which store it belongs to. */
  credentials: PaymentsLemonSqueezyCredentials;
  /**
   * The currency this store prices in, when it is known.
   *
   * Supplied so a fixed amount in another currency is refused here rather than at redemption. Absent means
   * the check cannot be made and the store's own judgement stands — better than inventing a currency.
   */
  storeCurrency?: string;
  /** The HTTP seam. Defaults to the runtime's `fetch`. */
  transport?: LemonSqueezyHttpFetch;
}

/** A created discount, narrowed to what an adopter needs back. */
const LemonSqueezyDiscount = z
  .object({
    data: z
      .object({
        id: z.string().min(1),
        attributes: z.object({ code: z.string().min(1) }).loose(),
      })
      .loose(),
  })
  .loose();

/** Create a discount and return the code a customer will type. */
export async function createLemonSqueezyDiscount(
  terms: DiscountTerms,
  options: LemonSqueezyDiscountOptions,
): Promise<CreatedDiscount> {
  if (
    terms.amount.kind === "fixed" &&
    options.storeCurrency !== undefined &&
    options.storeCurrency.toLowerCase() !== terms.amount.currency.toLowerCase()
  ) {
    // Refused before anything is sent. At the store this would be accepted and then fail when somebody
    // redeems it — so the adopter who can fix it would never see the error, and the customer who cannot
    // would.
    throw new PaymentsDiscountInvalidError({
      message: "That discount is in a currency this store does not sell in.",
      action: `Create it in ${options.storeCurrency.toUpperCase()}, or use a percentage instead.`,
      detail: `A fixed discount of ${terms.amount.amountMinor} ${terms.amount.currency.toUpperCase()} cannot apply to a store selling in ${options.storeCurrency.toUpperCase()}. Lemon Squeezy accepts the object and refuses it at redemption, in front of the customer.`,
    });
  }

  const attributes: Record<string, unknown> = {
    name: terms.code ?? "Discount",
    amount_type: terms.amount.kind === "percent" ? "percent" : "fixed",
    amount: terms.amount.kind === "percent" ? terms.amount.percent : terms.amount.amountMinor,
    // `once` | `forever` | `repeating`, the same three words. Only the number beneath differs.
    duration: terms.duration.kind,
    is_limited_redemptions: terms.maxRedemptions !== undefined,
  };
  if (terms.code !== undefined) attributes.code = terms.code;
  if (terms.duration.kind === "repeating") {
    // **Not converted.** The field is called `duration_in_months` and counts billing periods; see the module
    // doc. Converting here is the annual-plan defect, committed on the other rail.
    attributes.duration_in_months = terms.duration.billingPeriods;
  }
  if (terms.maxRedemptions !== undefined) attributes.max_redemptions = terms.maxRedemptions;
  if (terms.redeemableUntil !== undefined) attributes.expires_at = terms.redeemableUntil.toISOString();

  const created = await lemonSqueezyJson(options.transport ?? lemonSqueezyHttpFetch, "/discounts", {
    what: "a discount",
    apiKey: options.credentials.apiKey,
    body: {
      data: {
        type: "discounts",
        attributes,
        relationships: { store: { data: { type: "stores", id: options.credentials.storeId } } },
      },
    },
  });

  const parsed = LemonSqueezyDiscount.safeParse(created);
  if (!parsed.success) {
    throw new PaymentsDiscountInvalidError({
      detail: "Lemon Squeezy created a discount and returned no code for it.",
    });
  }
  return { code: parsed.data.data.attributes.code, providerDiscountId: parsed.data.data.id, terms };
}

/** Lemon Squeezy's discount list, narrowed to what a management pane shows. */
const LemonSqueezyDiscountList = z
  .object({
    data: z.array(
      z
        .object({
          id: z.string().min(1),
          attributes: z
            .object({
              code: z.string().min(1),
              amount: z.number().nullish(),
              amount_type: z.string().nullish(),
              duration: z.string().nullish(),
            })
            .loose(),
        })
        .loose(),
    ),
  })
  .loose();

/** The discount codes this store holds. */
export async function listLemonSqueezyDiscounts(
  options: LemonSqueezyDiscountOptions,
): Promise<readonly ListedDiscount[]> {
  const found = await lemonSqueezyJson(options.transport ?? lemonSqueezyHttpFetch, "/discounts", {
    what: "the discount codes",
    apiKey: options.credentials.apiKey,
    query: { "filter[store_id]": options.credentials.storeId },
  });
  const parsed = LemonSqueezyDiscountList.safeParse(found);
  if (!parsed.success) return [];
  return parsed.data.data.map((discount) => ({
    code: discount.attributes.code,
    providerDiscountId: discount.id,
    amount:
      discount.attributes.amount_type === "percent"
        ? `${discount.attributes.amount ?? 0}%`
        : `${discount.attributes.amount ?? 0} ${options.storeCurrency ?? ""}`.trim(),
    // Lemon Squeezy does not report a redemption count on the discount object.
    redemptions: null,
  }));
}
