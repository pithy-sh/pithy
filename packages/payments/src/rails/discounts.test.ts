// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import { DiscountTerms } from "../data/discount";
import { createLemonSqueezyDiscount } from "./lemonSqueezy/discounts";
import { createStripeDiscount, durationInMonths } from "./stripe/discounts";

/**
 * The two rails' discount translations, pinned by **meaning** rather than by field name.
 *
 * This file exists because the two stores agree on the concept and disagree on nearly every field, in ways
 * that are invisible until a customer is charged the wrong amount. Each test below names the customer-visible
 * fact and asserts both rails produce it — from different numbers, which is the point.
 */

const STRIPE = { credentials: { secretKey: "sk_test_1", webhookSecret: "whsec_1" } };
const LS = { credentials: { apiKey: "ls_api", webhookSecret: "ls_whsec", storeId: "42" } };

/** A transport recording every request body, answering with a created object. */
function stripeStub() {
  const forms: string[] = [];
  const transport = (url: string, init?: { body?: string }) => {
    forms.push(`${url} ${init?.body ?? ""}`);
    const body = url.includes("/coupons") ? { id: "co_1" } : { id: "promo_1", code: "LAUNCH" };
    return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(body)) });
  };
  return Object.assign(transport, { forms });
}

function lsStub() {
  const bodies: string[] = [];
  const transport = (_url: string, init?: { body?: string }) => {
    bodies.push(init?.body ?? "");
    return Promise.resolve({
      ok: true,
      status: 201,
      text: () =>
        Promise.resolve(JSON.stringify({ data: { id: "d_1", type: "discounts", attributes: { code: "LAUNCH" } } })),
    });
  };
  return Object.assign(transport, { bodies });
}

const terms = (input: Parameters<typeof DiscountTerms.parse>[0]) => DiscountTerms.parse(input);

describe("duration means billing periods, and only one rail converts", () => {
  test("twelve periods on a MONTHLY plan is twelve on both rails", async () => {
    const stripe = stripeStub();
    const ls = lsStub();
    const twelve = terms({
      code: "LAUNCH",
      amount: { kind: "percent", percent: 20 },
      duration: { kind: "repeating", billingPeriods: 12 },
      billingInterval: "month",
    });

    await createStripeDiscount(twelve, { ...STRIPE, transport: stripe });
    await createLemonSqueezyDiscount(twelve, { ...LS, transport: ls });

    expect(stripe.forms[0]).toContain("duration_in_months=12");
    expect(JSON.parse(ls.bodies[0] ?? "{}").data.attributes.duration_in_months).toBe(12);
  });

  test("twelve periods on an ANNUAL plan is 144 to Stripe and 12 to Lemon Squeezy", async () => {
    // The defect this whole normalized shape exists to prevent. A customer offered "the first twelve
    // renewals at 20% off" on an annual plan is being offered twelve YEARS. Stripe counts months, so it
    // must be told 144; Lemon Squeezy counts periods, so it must be told 12. The same customer-visible
    // term, from two different numbers — which is why neither store's field name became the shared one.
    const stripe = stripeStub();
    const ls = lsStub();
    const twelve = terms({
      code: "LAUNCH",
      amount: { kind: "percent", percent: 20 },
      duration: { kind: "repeating", billingPeriods: 12 },
      billingInterval: "year",
    });

    await createStripeDiscount(twelve, { ...STRIPE, transport: stripe });
    await createLemonSqueezyDiscount(twelve, { ...LS, transport: ls });

    expect(stripe.forms[0]).toContain("duration_in_months=144");
    expect(JSON.parse(ls.bodies[0] ?? "{}").data.attributes.duration_in_months).toBe(12);
  });

  test("the conversion is one named function, so the arithmetic has somewhere to be wrong", () => {
    expect(durationInMonths(12, "month")).toBe(12);
    expect(durationInMonths(12, "year")).toBe(144);
    expect(durationInMonths(1, "year")).toBe(12);
  });

  test("a repeating discount that does not state the interval is refused before either rail sees it", () => {
    // Because the alternative is guessing, and guessing wrong is a decade of a discount nobody offered.
    const parsed = DiscountTerms.safeParse({
      amount: { kind: "percent", percent: 20 },
      duration: { kind: "repeating", billingPeriods: 12 },
    });
    expect(parsed.success).toBe(false);
  });

  test("once and forever carry no interval, and are refused one", () => {
    expect(
      DiscountTerms.safeParse({ amount: { kind: "percent", percent: 20 }, duration: { kind: "once" } }).success,
    ).toBe(true);
    expect(
      DiscountTerms.safeParse({
        amount: { kind: "percent", percent: 20 },
        duration: { kind: "forever" },
        billingInterval: "month",
      }).success,
    ).toBe(false);
  });
});

describe("redeemableUntil stops a claim, never a discount already claimed", () => {
  test("Stripe carries it on the promotion code, not the coupon", async () => {
    // The distinction is the whole meaning. On the coupon it would be the same word applied one level up,
    // and a customer who redeemed yesterday would lose their rate on the date.
    const stripe = stripeStub();
    await createStripeDiscount(
      terms({
        code: "LAUNCH",
        amount: { kind: "percent", percent: 20 },
        duration: { kind: "forever" },
        redeemableUntil: "2026-12-31T00:00:00.000Z",
      }),
      { ...STRIPE, transport: stripe },
    );

    const [coupon, promotion] = stripe.forms;
    expect(coupon).not.toContain("redeem_by");
    expect(promotion).toContain("redeem_by=");
  });

  test("Lemon Squeezy carries it as expires_at, which means the same thing", async () => {
    const ls = lsStub();
    await createLemonSqueezyDiscount(
      terms({
        code: "LAUNCH",
        amount: { kind: "percent", percent: 20 },
        duration: { kind: "forever" },
        redeemableUntil: "2026-12-31T00:00:00.000Z",
      }),
      { ...LS, transport: ls },
    );
    expect(JSON.parse(ls.bodies[0] ?? "{}").data.attributes.expires_at).toBe("2026-12-31T00:00:00.000Z");
  });
});

describe("a fixed amount in the wrong currency is refused where the adopter can still read it", () => {
  test("naming both currencies", async () => {
    // At the store this is accepted and then fails at redemption — in front of the customer, who cannot fix
    // it. Refusing at creation is the only moment the adopter is the one reading the error.
    try {
      await createLemonSqueezyDiscount(
        terms({
          amount: { kind: "fixed", amountMinor: 500, currency: "eur" },
          duration: { kind: "once" },
        }),
        { ...LS, storeCurrency: "usd", transport: lsStub() },
      );
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(PithyError);
      if (error instanceof PithyError) {
        expect(error.payload.code).toBe("payments/discount_invalid");
        expect(`${error.payload.message} ${error.payload.action} ${error.payload.detail}`).toContain("EUR");
        expect(`${error.payload.message} ${error.payload.action} ${error.payload.detail}`).toContain("USD");
      }
    }
  });

  test("a matching currency is sent", async () => {
    const ls = lsStub();
    await createLemonSqueezyDiscount(
      terms({ amount: { kind: "fixed", amountMinor: 500, currency: "usd" }, duration: { kind: "once" } }),
      { ...LS, storeCurrency: "usd", transport: ls },
    );
    expect(JSON.parse(ls.bodies[0] ?? "{}").data.attributes.amount).toBe(500);
  });

  test("a percentage carries no currency and cannot mismatch one", () => {
    expect(
      DiscountTerms.safeParse({
        amount: { kind: "percent", percent: 20, currency: "usd" },
        duration: { kind: "once" },
      }).success,
    ).toBe(false);
  });
});

describe("the code", () => {
  test("is supplied when the adopter mints one per applicant", async () => {
    const ls = lsStub();
    await createLemonSqueezyDiscount(
      terms({ code: "ACME2026", amount: { kind: "percent", percent: 20 }, duration: { kind: "once" } }),
      { ...LS, transport: ls },
    );
    expect(JSON.parse(ls.bodies[0] ?? "{}").data.attributes.code).toBe("ACME2026");
  });

  test("is the store's when none was supplied", async () => {
    const stripe = stripeStub();
    const created = await createStripeDiscount(
      terms({ amount: { kind: "percent", percent: 20 }, duration: { kind: "once" } }),
      { ...STRIPE, transport: stripe },
    );
    expect(created.code).toBe("LAUNCH");
    expect(stripe.forms[1]).not.toContain("code=");
  });

  test("a redemption limit is what actually stops a second use", async () => {
    // An adopter's own record of who was offered a code is a display fact. The limit on the object is the
    // thing that holds when a webhook never arrives.
    const ls = lsStub();
    await createLemonSqueezyDiscount(
      terms({ amount: { kind: "percent", percent: 20 }, duration: { kind: "once" }, maxRedemptions: 1 }),
      { ...LS, transport: ls },
    );
    const attributes = JSON.parse(ls.bodies[0] ?? "{}").data.attributes;
    expect(attributes.max_redemptions).toBe(1);
    expect(attributes.is_limited_redemptions).toBe(true);
  });
});

describe("what the reviews found, held", () => {
  test("a repeating discount with no interval is refused by the rail, not defaulted to months", async () => {
    // `DiscountTerms` refuses this, so reaching the rail means somebody skipped the parse. Defaulting to
    // "month" would be right for a monthly plan and would silently turn an annual one into twelve years.
    await expect(
      createStripeDiscount(
        {
          amount: { kind: "percent", percent: 20 },
          duration: { kind: "repeating", billingPeriods: 12 },
        } as never,
        { ...STRIPE, transport: stripeStub() },
      ),
    ).rejects.toBeInstanceOf(PithyError);
  });

  test("the Lemon Squeezy currency guard runs when the store's currency is declared", async () => {
    // It reads `options.storeCurrency` and skips when undefined, so it was dead until the factory supplied
    // it from config. This is the check working; `providers.test.ts` is where the wiring is held.
    await expect(
      createLemonSqueezyDiscount(
        terms({ amount: { kind: "fixed", amountMinor: 500, currency: "eur" }, duration: { kind: "once" } }),
        { ...LS, storeCurrency: "usd", transport: lsStub() },
      ),
    ).rejects.toBeInstanceOf(PithyError);
  });
});
