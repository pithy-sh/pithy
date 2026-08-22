// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import type { CreatedDiscount, DiscountTerms } from "../../data/discount";
import { PaymentsDiscountInvalidError } from "../../error/errors";
import type { PaymentsPaddleCredentials } from "../../secret/registry";
import type { ListedDiscount } from "../contract";
import { type PaddleEnvironment, type PaddleHttpFetch, paddleHttpFetch, paddleJson } from "./api";

/**
 * Minting a discount at Paddle, from the normalized terms.
 *
 * One object, like Lemon Squeezy's and unlike Stripe's pair: a Paddle discount carries the money, the
 * duration, the redemption limit, the expiry and the code together.
 *
 * ## The two translations that decide whether a customer is charged correctly
 *
 * **Duration.** `recur: false` is `once`. `recur: true` with `maximum_recurring_intervals: null` is
 * `forever`. `recur: true` with a number is `repeating`, and **Paddle counts billing periods** — the same
 * unit `DiscountDuration` already uses, so the number passes through unconverted. This is the second rail
 * where it does not convert; Stripe is the one where it must, because `duration_in_months` counts months.
 * Round-tripped live: `recur: true, maximum_recurring_intervals: 12` came back as `12` on a percentage
 * discount, which is twelve renewals and not twelve months.
 *
 * **Expiry.** `redeemableUntil` means the code can no longer be *claimed*. Paddle's `expires_at` stops
 * redemption and leaves an existing subscriber's discount running, which is the same meaning — so it maps
 * directly.
 *
 * ## The charset, which is Paddle's and narrower than the shared schema's
 *
 * `DiscountCode` allows `[A-Za-z0-9_-]` up to 64 characters and promises "a code this project mints is
 * redeemable on either rail". Paddle enforces `^[a-zA-Z0-9]{1,32}$` — verified live, where
 * `PITHY_RECON-25` was refused with a bare `"Invalid request."` and nothing else.
 *
 * **The shared schema is not narrowed, and the refusal lands here instead.** Narrowing `DiscountCode`
 * would be a behavior change for every Stripe and Lemon Squeezy adopter, refusing codes those rails
 * accept today, in service of a rail they do not run. So this rail checks its own rule and says what it
 * is — the adopter reads a sentence naming the two characters Paddle will not take, rather than an
 * opaque 400 from Paddle. `DiscountCode`'s promise is now conditional, and `docs/paddle.md` says so.
 *
 * ## Amount, and the currency that arrives at the customer
 *
 * `currency_code` is **uppercase** at Paddle where `DiscountAmount.currency` is lowercase — verified
 * live. A fixed amount in a currency no restricted price uses is refused at creation naming both, because
 * at Paddle it would fail at redemption, in front of whoever typed the code.
 *
 * Paddle sends and takes amounts as **strings** in the currency's lowest denomination, including for the
 * zero-decimal currencies: ¥725 is `"725"`, not `"72500"`. Nothing here scales.
 */

/** What creating or listing a discount needs. */
export interface PaddleDiscountOptions {
  /** The rail's credentials. */
  credentials: PaymentsPaddleCredentials;
  /** Which Paddle account to reach. */
  environment: PaddleEnvironment;
  /**
   * The currency this project's Paddle catalog prices in, when the project declared one.
   *
   * Only used to refuse a fixed discount in another currency before it reaches Paddle. Absent means the
   * check cannot be made and Paddle's own judgment stands — better than inventing a currency.
   */
  storeCurrency?: string;
  /** The HTTP seam. Defaults to the runtime's `fetch`. */
  transport?: PaddleHttpFetch;
}

/** What Paddle accepts as a discount code. Narrower than the shared schema's — see the module doc. */
export const PADDLE_DISCOUNT_CODE = /^[a-zA-Z0-9]{1,32}$/;

/** A discount as Paddle returns it. */
const PaddleDiscount = z
  .object({
    id: z.string().min(1).describe("The discount — `dsc_…`."),
    code: z.string().nullish().describe("The code a customer types, or null for one applicable only by id."),
    type: z.string().nullish().describe("`percentage` or `flat`."),
    amount: z.string().nullish().describe("The figure, as a string: a percentage, or a lowest-denomination amount."),
    currency_code: z.string().nullish().describe("Uppercase ISO 4217, on a flat discount."),
    times_used: z.number().nullish().describe("How many times it has been claimed."),
  })
  .loose()
  .describe("A Paddle discount, as much of one as this package reads back.");

/** Create a discount and return the code a customer will type. */
export async function createPaddleDiscount(
  terms: DiscountTerms,
  options: PaddleDiscountOptions,
): Promise<CreatedDiscount> {
  if (terms.code !== undefined && !PADDLE_DISCOUNT_CODE.test(terms.code)) {
    // Refused here rather than by Paddle, because Paddle's own refusal is the string "Invalid request."
    // with no field named — an adopter reading that has nothing to act on.
    throw new PaymentsDiscountInvalidError({
      message: "Paddle won't take that code.",
      action: "Use letters and digits only, up to 32 characters — no dashes and no underscores.",
      detail: `Paddle enforces ^[a-zA-Z0-9]{1,32}$ on a discount code and refused "${terms.code}" with a bare "Invalid request.". The shared \`DiscountCode\` schema is deliberately wider, because narrowing it would refuse codes the Stripe and Lemon Squeezy rails accept today.`,
    });
  }

  if (
    terms.amount.kind === "fixed" &&
    options.storeCurrency !== undefined &&
    options.storeCurrency.toLowerCase() !== terms.amount.currency.toLowerCase()
  ) {
    throw new PaymentsDiscountInvalidError({
      message: "That discount is in a currency this catalog does not sell in.",
      action: `Create it in ${options.storeCurrency.toUpperCase()}, or use a percentage instead.`,
      detail: `A fixed discount of ${terms.amount.amountMinor} ${terms.amount.currency.toUpperCase()} cannot apply to prices in ${options.storeCurrency.toUpperCase()}. Paddle accepts the object and refuses it at redemption, in front of the customer.`,
    });
  }

  const body: Record<string, unknown> = {
    // Paddle requires a description, and it is the internal label an adopter finds the discount by.
    description: terms.code ?? "Pithy discount",
    type: terms.amount.kind === "percent" ? "percentage" : "flat",
    // A string, in the currency's lowest denomination, and never scaled. A percentage is a string too.
    amount: terms.amount.kind === "percent" ? String(terms.amount.percent) : String(terms.amount.amountMinor),
    // `recur: false` is `once`; `true` is `forever` unless a count narrows it. **Not converted** — Paddle
    // counts billing periods, which is the unit the normalized terms already use.
    recur: terms.duration.kind !== "once",
    // A code supplied means a customer may type it; one minted without a code is applicable only by id.
    enabled_for_checkout: terms.code !== undefined,
  };
  if (terms.amount.kind === "fixed") body.currency_code = terms.amount.currency.toUpperCase();
  if (terms.code !== undefined) body.code = terms.code;
  if (terms.duration.kind === "repeating") body.maximum_recurring_intervals = terms.duration.billingPeriods;
  if (terms.maxRedemptions !== undefined) body.usage_limit = terms.maxRedemptions;
  if (terms.redeemableUntil !== undefined) body.expires_at = terms.redeemableUntil.toISOString();

  const answer = await paddleJson(options.transport ?? paddleHttpFetch, "/discounts", {
    what: "a discount",
    apiKey: options.credentials.apiKey,
    environment: options.environment,
    body,
  });

  const parsed = PaddleDiscount.safeParse(answer?.data);
  const code = parsed.success ? parsed.data.code : null;
  if (!parsed.success || typeof code !== "string" || code === "") {
    throw new PaymentsDiscountInvalidError({
      detail: "Paddle created a discount and returned no code for it.",
    });
  }

  return { code, providerDiscountId: parsed.data.id, terms };
}

/** Every discount this account holds, newest first. Never reaches a browser — see {@link ListedDiscount}. */
export async function listPaddleDiscounts(options: PaddleDiscountOptions): Promise<readonly ListedDiscount[]> {
  const answer = await paddleJson(options.transport ?? paddleHttpFetch, "/discounts", {
    what: "the discount list",
    apiKey: options.credentials.apiKey,
    environment: options.environment,
    query: [
      ["order_by", "created_at[DESC]"],
      ["per_page", "200"],
    ],
  });

  const parsed = z.array(PaddleDiscount).safeParse(answer?.data);
  if (!parsed.success) return [];

  return parsed.data
    .filter((discount): discount is typeof discount & { code: string } => typeof discount.code === "string")
    .map((discount) => ({
      code: discount.code,
      providerDiscountId: discount.id,
      // Paddle's own figures, rendered rather than recomputed. A percentage carries no currency and a flat
      // amount is a lowest-denomination integer — neither is divided by anything here.
      amount:
        discount.type === "percentage"
          ? `${discount.amount ?? "?"}%`
          : `${discount.amount ?? "?"} ${(discount.currency_code ?? "").toLowerCase()}`.trim(),
      redemptions: typeof discount.times_used === "number" ? discount.times_used : null,
    }));
}
