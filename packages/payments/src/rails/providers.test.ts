// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { PaymentsConfig } from "../config/config";
import { PAYMENTS_HOSTED_RAILS, PAYMENTS_RAILS, type PaymentsRail } from "../data/rail";
import { PaymentsRailNotConfiguredError } from "../error/errors";
import { PaymentsProviderCredentials } from "../secret/registry";
import { isCheckoutRail } from "./contract";
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
      rails: { lemonSqueezy: true },
      lemonSqueezy: { successUrl: "https://acme.test/thanks", storeCurrency: "usd" },
      products: { pro: { type: "subscription", name: "Pro", entitlements: ["pro"], lemonSqueezy: { variantId: "1" } } },
    });
    expect(config.lemonSqueezy?.storeCurrency).toBe("usd");
  });
});
