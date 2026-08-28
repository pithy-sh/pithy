// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import type * as z from "zod";
import { PaymentsConfig } from "../config/config";
import { PAYMENTS_HOSTED_RAILS, PAYMENTS_RAILS, type PaymentsRail } from "../data/rail";
import { PaymentsRailNotConfiguredError } from "../error/errors";
import { PaymentsDiscountResponse } from "../http/responses";
import { AdminDiscountsQuery, CheckoutRequest, DiscountCreateRequest } from "../http/schemas";
import { PaymentsProviderCredentials } from "../secret/registry";
import { isCheckoutRail, isDiscountRail, isSubscriptionRail } from "./contract";
import { implementedRails, resolveRailProvider } from "./providers";

const CREDENTIALS = PaymentsProviderCredentials.parse({
  apple: {
    bundleId: "com.acme.app",
    keyId: "2X9R4HXF34",
    issuerId: "57246542-96fe-1a63-e053-0824d011072a",
    privateKey: "-----BEGIN PRIVATE KEY-----\nMIG…\n-----END PRIVATE KEY-----",
  },
  google: {
    packageName: "com.acme.app",
    serviceAccountEmail: "pithy-play@acme-42.iam.gserviceaccount.com",
    privateKey: "-----BEGIN PRIVATE KEY-----\nMIG…\n-----END PRIVATE KEY-----",
    pubsubAudience: "https://acme.example/payments/webhooks/google",
  },
  stripe: {
    secretKey: "sk_test_pithyTestKeyNotARealOne00",
    webhookSecret: "whsec_pithyTestSigningSecretNotARealOne00",
  },
  lemonSqueezy: {
    apiKey: "lsq_pithyTestKeyNotARealOne00",
    webhookSecret: "lsqSigningSecretNotARealOne00",
    storeId: "42",
  },
  paddle: {
    apiKey: "pithyTestApiKeyNotARealOne00",
    webhookSecret: "pdl_ntfset_pithyTestNotARealOne00",
  },
});

const config = (rails: Record<string, boolean>) =>
  PaymentsConfig.parse({
    billingSubject: "user",
    rails,
    ...(rails.stripe
      ? {
          stripe: {
            successUrl: "https://acme.example/thanks",
            cancelUrl: "https://acme.example/pricing",
            portalReturnUrl: "https://acme.example/account",
          },
        }
      : {}),
    ...(rails.lemonSqueezy ? { lemonSqueezy: { successUrl: "https://acme.example/thanks" } } : {}),
    ...(rails.paddle
      ? {
          paddle: {
            clientToken: "test_pithyClientTokenNotARealOne",
            environment: "sandbox",
            successUrl: "https://acme.example/thanks",
          },
        }
      : {}),
    products: {
      pro_monthly: {
        type: "subscription",
        name: "Pro",
        entitlements: ["pro"],
        ...(rails.apple ? { apple: { productId: "com.acme.pro.monthly" } } : {}),
        ...(rails.google ? { google: { productId: "pro_monthly" } } : {}),
        ...(rails.stripe ? { stripe: { priceId: "price_1Abc" } } : {}),
        ...(rails.lemonSqueezy ? { lemonSqueezy: { variantId: "123456" } } : {}),
        ...(rails.paddle ? { paddle: { priceId: "pri_01hv8wPithyTestNotAReal" } } : {}),
      },
    },
  });

describe("resolveRailProvider", () => {
  test("resolves a rail that is enabled, implemented, and provisioned", () => {
    expect(resolveRailProvider("apple", config({ apple: true }), CREDENTIALS).rail).toBe("apple");
    expect(resolveRailProvider("google", config({ google: true }), CREDENTIALS).rail).toBe("google");
    expect(resolveRailProvider("stripe", config({ stripe: true }), CREDENTIALS).rail).toBe("stripe");
  });

  /**
   * `PAYMENTS_HOSTED_RAILS` against the rails that actually implement {@link isCheckoutRail}.
   *
   * The list is written by hand — it has to be, because a browser screen reads it and cannot construct a
   * rail provider to find out. What makes it more than a restatement is the other side of this
   * comparison: every rail in the enum is *built* here, from real credentials and a real config, and
   * asked at runtime whether it carries `createCheckoutSession` and `createPortalSession`. A rail added
   * to the enum with a checkout module and not to the list fails here, and so does the reverse.
   *
   * It is also the gate on the question #336 asked: are "sells in a browser" and "mints a portal we can
   * link to" the same set? They are, and not by coincidence — `CheckoutRail` declares both methods, so a
   * rail cannot have one without the other. The day that stops being true, the interface splits, this
   * comparison goes red, and *that* is when a second name is earned.
   */
  test("the hosted-rail list is exactly the rails that implement CheckoutRail", () => {
    const initiating = PAYMENTS_RAILS.filter((rail) =>
      isCheckoutRail(resolveRailProvider(rail, config({ [rail]: true }), CREDENTIALS)),
    );
    expect([...initiating].sort()).toEqual([...PAYMENTS_HOSTED_RAILS].sort());
    // A floor, so a `PAYMENTS_RAILS` that stopped enumerating cannot make two empty lists agree.
    expect(PAYMENTS_RAILS.length).toBe(5);
    expect(initiating.length).toBeGreaterThan(0);
    expect(initiating.length).toBeLessThan(PAYMENTS_RAILS.length);
  });

  /**
   * The gate on the wiring, and there is no hand-written list on the other side of it.
   *
   * `PAYMENTS_HOSTED_RAILS` exists because a browser screen reads it and cannot construct a rail provider to
   * find out what it implements. Nothing reads "which rails manage subscriptions" yet, so a second literal
   * would be a mirror with nothing to mirror — a line to keep in step for no reader. What is needed is this:
   * every rail is built from real credentials and asked at runtime, so a `paddleRail` that declared four of
   * the five methods, or a fifth rail that quietly grew them, fails here.
   *
   * Stated as an equality rather than a truth about Paddle alone, so the guard is proven able to answer no.
   */
  test("paddle is the only rail that can manage a subscription from the server", () => {
    const managing = PAYMENTS_RAILS.filter((rail) =>
      isSubscriptionRail(resolveRailProvider(rail, config({ [rail]: true }), CREDENTIALS)),
    );
    expect(managing).toEqual(["paddle"]);
    // A floor, so a `PAYMENTS_RAILS` that stopped enumerating cannot make this pass by asking nobody.
    expect(PAYMENTS_RAILS.length).toBe(5);
  });

  test("the store rails hear about purchases and do not make them", () => {
    // The asymmetry the contract refuses to paper over: a purchase inside StoreKit or Play Billing has
    // already happened by the time the server sees a receipt, so there is no session to create and no
    // portal to mint. `/checkout` and `/portal` narrow on this.
    expect(isCheckoutRail(resolveRailProvider("apple", config({ apple: true }), CREDENTIALS))).toBe(false);
    expect(isCheckoutRail(resolveRailProvider("google", config({ google: true }), CREDENTIALS))).toBe(false);
  });

  test("each rail gets only its own credential block", () => {
    // A rail that could see another's credentials is a rail that could send them somewhere. The factory takes
    // one block, and `railCredentials` is what refuses when it is absent.
    const thrown = catchError(() =>
      resolveRailProvider(
        "google",
        config({ google: true }),
        PaymentsProviderCredentials.parse({ apple: CREDENTIALS.apple }),
      ),
    );
    expect(thrown?.payload.detail).toContain("google rail has no credentials");
  });

  test("a rail that is off in config is a 404", () => {
    const thrown = catchError(() => resolveRailProvider("apple", config({ stripe: true }), CREDENTIALS));
    expect(thrown).toBeInstanceOf(PaymentsRailNotConfiguredError);
    expect(thrown?.payload.status).toBe(404);
    expect(thrown?.payload.detail).toContain("off in this project's config");
  });

  test("a rail this build does not implement is the same 404 to a client, and distinguishable to an operator", () => {
    // Every rail in the union is implemented now, so this branch is only reachable through a config claiming one
    // that is not — which is exactly the shape of a future rail added to the enum before its module lands. Kept
    // and exercised rather than deleted: the day the sixth rail is half-added, this is the refusal it gets.
    const unimplemented = {
      ...config({ apple: true }),
      rails: { apple: false, google: false, stripe: false, lemonSqueezy: false, paddle: false, amazon: true },
    };
    const thrown = catchError(() =>
      resolveRailProvider("amazon" as PaymentsRail, unimplemented as PaymentsConfig, CREDENTIALS),
    );
    expect(thrown).toBeInstanceOf(PaymentsRailNotConfiguredError);
    expect(thrown?.payload.detail).toContain("implements apple, google, stripe, lemonSqueezy, paddle");
  });

  test("an enabled, implemented rail with no credentials is a 404 too", () => {
    const thrown = catchError(() =>
      resolveRailProvider("apple", config({ apple: true }), PaymentsProviderCredentials.parse({})),
    );
    expect(thrown).toBeInstanceOf(PaymentsRailNotConfiguredError);
    expect(thrown?.payload.detail).toContain("no credentials");
  });

  test("no refusal tells a client which of config, build, or provisioning is missing", () => {
    // Three different causes, one public message. `detail` carries the difference and the HTTP codec strips it.
    const unimplemented = {
      ...config({ apple: true }),
      rails: { apple: false, google: false, stripe: false, lemonSqueezy: false, paddle: false, amazon: true },
    };
    const messages = new Set(
      [
        catchError(() => resolveRailProvider("apple", config({ stripe: true }), CREDENTIALS)),
        catchError(() => resolveRailProvider("amazon" as PaymentsRail, unimplemented as PaymentsConfig, CREDENTIALS)),
        catchError(() => resolveRailProvider("apple", config({ apple: true }), PaymentsProviderCredentials.parse({}))),
      ].map((error) => error?.payload.message),
    );
    expect(messages.size).toBe(1);
  });
});

describe("implementedRails", () => {
  test("names what this build can serve — all five rails", () => {
    // The list is the honest answer to "which rails work". A rail added to config that is not here refuses
    // rather than half-working, and this assertion is what makes adding one a deliberate edit.
    expect(implementedRails()).toEqual(["apple", "google", "stripe", "lemonSqueezy", "paddle"]);
    // And the set is exactly the enum: a rail nameable in config with no factory behind it would report
    // itself available and then fail, which is worse than reporting itself absent.
    expect([...implementedRails()].sort()).toEqual([...PAYMENTS_RAILS].sort());
  });
});

/** The thrown `PithyError`, or undefined. Keeps each case a single readable line. */
function catchError(run: () => unknown): PaymentsRailNotConfiguredError | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    return error as PaymentsRailNotConfiguredError;
  }
}

describe("the lemonSqueezy factory hands the rail what only config knows", () => {
  test("the store's currency, so the fixed-amount discount guard is not dead code", () => {
    // The guard in `discounts.ts` skips its check when the currency is unknown, so a factory that never
    // supplied it left a refusal that could not fire — and a fixed discount in the wrong currency would
    // have failed at redemption, in front of the customer.
    const config = PaymentsConfig.parse({
      billingSubject: "user",
      rails: { lemonSqueezy: true },
      lemonSqueezy: { successUrl: "https://acme.test/thanks", storeCurrency: "usd" },
      products: { pro: { type: "subscription", name: "Pro", entitlements: ["pro"], lemonSqueezy: { variantId: "1" } } },
    });
    expect(config.lemonSqueezy?.storeCurrency).toBe("usd");
  });
});

/**
 * Every schema that names a rail, held against the rails that can actually serve it.
 *
 * **The failure this exists for.** Four schemas wrote their rail out by hand — `CheckoutRequest`,
 * `AdminDiscountsQuery`, `DiscountCreateRequest`, `PaymentsDiscountResponse` — and Paddle shipped a
 * checkout module, a portal, `createDiscount` and `listDiscounts` without reaching any of them. The rail
 * worked everywhere except the four places a caller has to name it, so `POST /payments/checkout` with
 * `rail: "paddle"` was a 400 on a rail that sells, and a discount could not be minted at the one store
 * that is a merchant of record for it. Nothing was red: a literal has no other side.
 *
 * **So the other side is the provider itself.** Every rail in the enum is *built* here, from real
 * credentials and a real config, and asked at runtime which interfaces it carries — the shape
 * `PAYMENTS_HOSTED_RAILS` is already held to two tests above. A sixth rail with a checkout module and no
 * line in `CheckoutRequest` fails here, and so does a rail named in a schema that cannot serve the route
 * behind it.
 *
 * **Discounts are asked separately from checkout, and today the two answers match.** They are one enum
 * because a second literal would be a mirror with nothing to mirror. The day a rail mints codes and sells
 * nothing — or sells and mints nothing — these two expectations disagree, the enum splits, and that is the
 * moment a second name is earned rather than a judgment call.
 */
describe("the schemas that name a rail", () => {
  /** Which rails a schema's rail field parses. Asked one literal at a time, so an optional field answers too. */
  function accepted(field: z.ZodType): PaymentsRail[] {
    return PAYMENTS_RAILS.filter((rail) => field.safeParse(rail).success);
  }

  /** Every rail, built for real, filtered by what it structurally implements. */
  function implementing(guard: (provider: ReturnType<typeof resolveRailProvider>) => boolean): PaymentsRail[] {
    return PAYMENTS_RAILS.filter((rail) => guard(resolveRailProvider(rail, config({ [rail]: true }), CREDENTIALS)));
  }

  test("the gate is asking real providers and real schemas, not empty lists", () => {
    // Anti-vacuous, both halves. A `safeParse` that never succeeded and a guard that never matched would
    // make every assertion below compare two empty arrays.
    expect(PAYMENTS_RAILS.length).toBe(5);
    expect(implementing(isCheckoutRail).length).toBeGreaterThan(0);
    expect(implementing(isDiscountRail).length).toBeGreaterThan(0);
    expect(accepted(CheckoutRequest.shape.rail).length).toBeGreaterThan(0);
    // And each is a strict subset: a list that had quietly become "all five" would agree with anything.
    expect(implementing(isCheckoutRail).length).toBeLessThan(PAYMENTS_RAILS.length);
    expect(implementing(isDiscountRail).length).toBeLessThan(PAYMENTS_RAILS.length);
  });

  test("`POST /checkout` accepts exactly the rails that can create a checkout", () => {
    expect(accepted(CheckoutRequest.shape.rail)).toEqual(implementing(isCheckoutRail));
  });

  test("both discount routes accept exactly the rails that can mint a discount", () => {
    // `isDiscountRail` and not `isCheckoutRail`: the route resolves a provider and narrows on the first,
    // so a schema built from the second would be an accepted rail refused one line later.
    expect(accepted(AdminDiscountsQuery.shape.rail)).toEqual(implementing(isDiscountRail));
    expect(accepted(DiscountCreateRequest.shape.rail)).toEqual(implementing(isDiscountRail));
  });

  test("the minted-discount response names exactly the rails that could have minted it", () => {
    // The response is the mirror of the request, and it drifted with it: a rail a caller may name and the
    // reply cannot spell is a 500 on a successful mint.
    expect(accepted(PaymentsDiscountResponse.shape.rail)).toEqual(implementing(isDiscountRail));
  });

  test("no schema names a store rail — a purchase inside Apple or Google is not one this server starts", () => {
    // The floor under the equalities above, stated as an attack rather than derived from them. Apple and
    // Google reach every one of these routes as a 400, which is the refusal, and it is what an equality
    // between two lists that both grew wrong would not catch.
    for (const field of [
      CheckoutRequest.shape.rail,
      AdminDiscountsQuery.shape.rail,
      DiscountCreateRequest.shape.rail,
      PaymentsDiscountResponse.shape.rail,
    ]) {
      expect(field.safeParse("apple").success).toBe(false);
      expect(field.safeParse("google").success).toBe(false);
    }
  });
});
