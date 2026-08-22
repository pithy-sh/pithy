// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { JsonDate } from "@pithy-sh/core/src/data/codecs";
import { z } from "zod";

/**
 * A discount, normalized — and every field here is named for **what it means to a customer's bill**, not for
 * what either provider calls it.
 *
 * That is the whole design constraint, and it is not a style preference. Stripe and Lemon Squeezy agree on
 * the concept of a discount and disagree on nearly every field, in ways that are invisible until somebody is
 * charged the wrong amount:
 *
 * - **Duration.** Stripe's `duration_in_months` counts *months*. Lemon Squeezy's equivalent counts *billing
 *   periods*. On a monthly plan they coincide. On an annual one, `12` means a year on one rail and twelve
 *   years on the other — a decade of a discount nobody offered.
 * - **Expiry.** On one rail the date stops *redemption*: after it the code cannot be claimed, and anyone
 *   already holding it keeps their discount. On the other the same-looking field can stop *the discount
 *   itself*, changing an existing customer's next invoice.
 * - **Amount.** A fixed amount carries a currency and a percentage does not, and a fixed amount against a
 *   subscription in another currency is a provider error at *redemption* — so the failure arrives at the
 *   customer rather than at the adopter who created it.
 *
 * So this module models the customer-visible fact and each rail translates into its own vocabulary, with
 * fixtures pinning the *meaning* rather than the field name. Where a translation needs something neither
 * provider's create call carries — the plan's billing interval — it is required here rather than guessed,
 * because guessing is the defect.
 *
 * **Pithy never computes a discounted amount.** The provider is the authority on what is owed; a second
 * calculation here would be a second answer to the one question a customer checks against their statement.
 * Everything in this module describes a discount's *terms*, never its arithmetic.
 */

/** The longest a discount code may be. Both providers are more generous; this is a legibility bound. */
const MAX_CODE_LENGTH = 64;

/** A discount code, as a customer types it. Case is preserved — both providers match case-insensitively. */
export const DiscountCode = z
  .string()
  .min(1)
  .max(MAX_CODE_LENGTH)
  .regex(/^[A-Za-z0-9_-]+$/, "A discount code is letters, digits, underscores and dashes.")
  .describe(
    "The code a customer enters at checkout. Constrained to what both stores accept, so a code this project mints is redeemable on either rail.",
  );
export type DiscountCode = z.infer<typeof DiscountCode>;

/**
 * How much comes off — a percentage, or a fixed amount in a named currency.
 *
 * Discriminated rather than two optional fields, because the currency is meaningful for exactly one of them
 * and meaningless for the other. A percentage with a currency would be a value nothing could act on.
 */
export const DiscountAmount = z
  .discriminatedUnion("kind", [
    z
      .strictObject({
        kind: z.literal("percent").describe("A percentage off, which carries no currency."),
        percent: z
          .number()
          .positive()
          .max(100)
          .describe("How many percent off, 0 exclusive to 100 inclusive. 100 is a comped period, which is legal."),
      })
      .describe("A percentage off — the portable kind, which works whatever a subscription is priced in."),
    z
      .strictObject({
        kind: z.literal("fixed").describe("A fixed amount off, which is only meaningful in a stated currency."),
        amountMinor: z
          .number()
          .int()
          .positive()
          .describe("How much off, as an integer in the currency's minor unit. Never a float."),
        currency: z
          .string()
          .regex(/^[a-z]{3}$/, "An ISO 4217 currency code is three lowercase letters.")
          .describe(
            "The currency the amount is in. A fixed amount against a subscription priced in another currency is refused before creation, because at the provider it would fail at redemption — in front of the customer.",
          ),
      })
      .describe("A fixed amount off, in one currency and no other."),
  ])
  .describe(
    "How much a discount takes off a bill. Strict on both members: a currency on a percentage is a value nothing can act on, and silently dropping it would leave an adopter believing they had set something.",
  );
export type DiscountAmount = z.infer<typeof DiscountAmount>;

/**
 * How long the discount lasts, in **billing periods** — the unit the customer experiences.
 *
 * Periods rather than months, because a period is what a customer sees on their statement: "the first twelve
 * renewals are cheaper" means the same thing on a monthly plan and an annual one. Months are Stripe's
 * internal unit and mean something different on an annual plan; translating into them is the Stripe rail's
 * job, and {@link DiscountTerms.billingInterval} is what makes that translation possible rather than a guess.
 */
export const DiscountDuration = z
  .discriminatedUnion("kind", [
    z
      .object({ kind: z.literal("once").describe("One billing period, then list price.") })
      .describe("A single period's discount — a launch offer on the first invoice."),
    z
      .object({ kind: z.literal("forever").describe("Every period, for as long as the subscription runs.") })
      .describe("A permanent rate. Nothing lapses, so nothing surprises anyone later."),
    z
      .object({
        kind: z.literal("repeating").describe("A fixed number of billing periods, then list price."),
        billingPeriods: z
          .number()
          .int()
          .positive()
          .describe(
            "How many billing periods the discount applies to, counted the way a customer counts renewals. Twelve on a monthly plan is a year; twelve on an annual plan is twelve years.",
          ),
      })
      .describe("A rate that lapses — the one whose end date a customer must be told about."),
  ])
  .describe("How long a discount lasts, in billing periods.");
export type DiscountDuration = z.infer<typeof DiscountDuration>;

/** How often the plan this discount is for renews. Required only to translate a repeating duration. */
export const BillingInterval = z
  .enum(["month", "year"])
  .describe(
    "How often the subscription this discount is meant for renews. Required for a repeating discount, because Stripe counts its duration in months and Lemon Squeezy counts it in periods — so without it, `12` on an annual plan is a year on one rail and twelve years on the other.",
  );
export type BillingInterval = z.infer<typeof BillingInterval>;

/**
 * Everything that decides what a discount does. The shape both rails are created from.
 *
 * Deliberately not a mirror of either provider's create body: the fields it does not have are as considered
 * as the ones it does. There is no "applies to these products" — that is a commercial policy an adopter owns
 * — and no "first-time customers only", which the two stores model incompatibly enough that supporting it
 * would mean promising behavior on one rail we could not deliver on the other.
 */
export const DiscountTerms = z
  .object({
    code: DiscountCode.optional().describe(
      "The code to mint, or omit it and let the store generate one. Supplying it is what lets an adopter mint one code per applicant against their own record of who was offered it.",
    ),
    amount: DiscountAmount.describe("How much comes off."),
    duration: DiscountDuration.describe("How long it lasts, in billing periods."),
    billingInterval: BillingInterval.optional().describe(
      "How often the plan renews. Required when `duration` is `repeating`, and refused otherwise — a duration that does not lapse has nothing to count.",
    ),
    maxRedemptions: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "How many times the code may be claimed in total, or omit for unlimited. It guards the customer path and only the customer path: the store counts a redemption when a checkout or a transaction uses the code and refuses the next one past the limit, and it holds when a webhook never arrives because the count is the store's rather than ours. It does not guard an administrative application against an existing subscription. Measured against the Paddle sandbox on 2026-08-14: a code with `usage_limit: 1` was applied to two subscriptions with `times_used` still `0`, went to `1` only when a transaction billed under it completed, and refused the next transaction after that. Stripe and Lemon Squeezy are unmeasured, so assume the same of them. So a staff comp applied by updating a subscription is not stopped here, and an adopter's own record of who was offered a code is the only thing that would stop it.",
      ),
    redeemableUntil: JsonDate.optional().describe(
      "After this moment the code can no longer be *claimed*. It does not end a discount already applied: a customer who redeemed it yesterday keeps their rate for its full duration. Named for that meaning because the providers' own fields do not agree on it, and a fixture pins each rail against a code already redeemed.",
    ),
  })
  .describe("The terms of a discount, in customer-visible units, from which either rail can create one.")
  .check((ctx) => {
    const terms = ctx.value;

    // The one cross-field rule, and the reason it exists is the annual-plan mistranslation above.
    if (terms.duration.kind === "repeating" && terms.billingInterval === undefined) {
      ctx.issues.push({
        code: "custom",
        input: ctx.value,
        path: ["billingInterval"],
        message:
          "A repeating discount must state the plan's `billingInterval`. Stripe counts a duration in months and Lemon Squeezy counts it in billing periods, so without it the same number means a year on one rail and twelve years on the other.",
      });
    }

    if (terms.duration.kind !== "repeating" && terms.billingInterval !== undefined) {
      ctx.issues.push({
        code: "custom",
        input: ctx.value,
        path: ["billingInterval"],
        message:
          "`billingInterval` is only meaningful for a `repeating` duration. A discount that runs once or forever has no periods to count.",
      });
    }
  });
export type DiscountTerms = z.output<typeof DiscountTerms>;
export type DiscountTermsInput = z.input<typeof DiscountTerms>;

/** A discount as a store created it: the terms we asked for, plus what the store decided. */
export const CreatedDiscount = z
  .object({
    code: DiscountCode.describe("The code a customer enters — the one supplied, or the one the store generated."),
    providerDiscountId: z
      .string()
      .min(1)
      .describe("The store's own id for the object, so an adopter can find it in their dashboard."),
    terms: DiscountTerms.describe("The terms it was created with, echoed back as this package models them."),
  })
  .describe("A discount that now exists at a store.");
export type CreatedDiscount = z.output<typeof CreatedDiscount>;

/**
 * What a subscription is paying now, what it becomes, and when — the half that stops a bill changing
 * unannounced.
 *
 * A capability that can apply a discount but not report its end date has shipped the half that creates the
 * surprise: a discount that silently lapses is a customer's bill changing on a Tuesday with nothing having
 * told them, and from where they sit that is indistinguishable from a billing error.
 *
 * Every amount here comes from the provider. Nothing in this package multiplies a price by a percentage.
 */
export const SubscriptionPricing = z
  .object({
    currency: z
      .string()
      .nullable()
      .describe("The currency both amounts are in, or null when the store did not report one."),
    currentAmountMinor: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .describe("What the next invoice comes to under any discount in force, as the store computed it."),
    listAmountMinor: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .describe(
        "What it comes to once the discount ends — the list price. Equal to `currentAmountMinor` when no discount is in force.",
      ),
    discountCode: DiscountCode.nullable().describe(
      "The code in force, or null when the subscription is at list price.",
    ),
    discountEndsAt: JsonDate.nullable().describe(
      "When the current discount stops applying, or null — which means either no discount or one that runs forever. A screen must say which, so read it beside `discountCode`.",
    ),
  })
  .describe("What a subscription pays now, what it will pay, and when that changes.");
export type SubscriptionPricing = z.output<typeof SubscriptionPricing>;
