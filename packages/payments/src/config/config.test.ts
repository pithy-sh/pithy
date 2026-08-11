// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import {
  entitlementsForProduct,
  grantableEntitlements,
  PaymentsConfig,
  type PaymentsConfigInput,
  type PaymentsProductInput,
  type PaymentsRailTogglesInput,
  type PaymentsStripeSettingsInput,
  productForProviderSku,
  providerProductId,
  railEnabled,
  resolveProduct,
} from "./config";

/** Where Stripe's hosted pages return to. Required whenever the Stripe rail is on. */
const STRIPE_RETURN_URLS = {
  successUrl: "https://acme.example/thanks?session={CHECKOUT_SESSION_ID}",
  cancelUrl: "https://acme.example/pricing",
  portalReturnUrl: "https://acme.example/account",
};

/** The catalog from issue #79's example, trimmed to what a test needs. Parsed fresh per test. */
function catalog(overrides: Partial<PaymentsConfigInput> = {}): PaymentsConfigInput {
  return {
    rails: { apple: true, google: true, stripe: true },
    stripe: STRIPE_RETURN_URLS,
    products: {
      pro_monthly: {
        type: "subscription",
        name: "Pro",
        entitlements: ["pro"],
        apple: { productId: "com.acme.pro.monthly" },
        google: { productId: "pro_monthly" },
        stripe: { priceId: "price_1Abc" },
      },
      remove_ads: {
        type: "non_consumable",
        name: "Remove ads",
        entitlements: ["ads_removed"],
        apple: { productId: "com.acme.removeads" },
        google: { productId: "remove_ads" },
      },
      coins_100: {
        type: "consumable",
        name: "100 coins",
        grants: { ledger: { currency: "coins", amount: 100 } },
        apple: { productId: "com.acme.coins100" },
        google: { productId: "coins_100" },
      },
    },
    ...overrides,
  };
}

describe("the catalog's pieces are typeable as written", () => {
  test("a product assembles from a price id without restating what the schema defaults", () => {
    // The shape that makes price ids swappable per environment: products built from a map, one
    // helper per rail. Typed as output, each piece would have to restate `entitlements` and
    // `clawback` — values the schema exists to supply.
    const plans = {
      pro_monthly: { name: "Pro", entitlement: "pro", priceId: "price_1Abc" },
      team_monthly: { name: "Team", entitlement: "team", priceId: "price_1Def" },
    };
    const products: Record<string, PaymentsProductInput> = Object.fromEntries(
      Object.entries(plans).map(([id, plan]) => [
        id,
        { type: "subscription", name: plan.name, entitlements: [plan.entitlement], stripe: { priceId: plan.priceId } },
      ]),
    );

    const rails: PaymentsRailTogglesInput = { stripe: true };
    const stripe: PaymentsStripeSettingsInput = STRIPE_RETURN_URLS;

    const config = PaymentsConfig.parse({ rails, products, stripe } satisfies PaymentsConfigInput);
    expect(config.rails).toEqual({ apple: false, google: false, stripe: true });
    expect(config.products.pro_monthly?.clawback).toBe(false);
    expect(config.products.team_monthly?.entitlements).toEqual(["team"]);
  });
});

describe("PaymentsConfig defaults", () => {
  test("mounts at /payments and grants access during grace, because that is the point of grace", () => {
    const config = PaymentsConfig.parse(catalog());
    expect(config.basePath).toBe("/payments");
    expect(config.graceGrantsAccess).toBe(true);
  });

  test("every rail is off until named, so an empty catalog composes without claiming a store", () => {
    const config = PaymentsConfig.parse({ products: {} });
    expect(config.rails).toEqual({ apple: false, google: false, stripe: false });
    expect(config.products).toEqual({});
  });

  test("a product grants no entitlements unless it says so — a consumable may only credit a balance", () => {
    const config = PaymentsConfig.parse(catalog());
    expect(config.products.coins_100?.entitlements).toEqual([]);
    expect(config.products.coins_100?.clawback).toBe(false);
  });

  test("an entitlement key is validated as a key, so a store SKU in that field fails at assembly", () => {
    expect(() =>
      PaymentsConfig.parse({
        rails: { apple: true },
        products: {
          pro: { type: "subscription", name: "Pro", entitlements: ["com.acme.pro"], apple: { productId: "a" } },
        },
      }),
    ).toThrow(/entitlement key/i);
  });
});

describe("PaymentsConfig cross-field rules", () => {
  test("a product naming a rail the project disabled fails, naming the rail and the product", () => {
    const result = PaymentsConfig.safeParse(catalog({ rails: { apple: true, google: false, stripe: true } }));
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message).join("\n")).toMatch(
      /Product "pro_monthly" declares a google SKU, but `rails.google` is off/,
    );
  });

  test("two products claiming one rail's SKU fail — a webhook could not tell which it bought", () => {
    const result = PaymentsConfig.safeParse({
      rails: { apple: true },
      products: {
        pro_monthly: { type: "subscription", name: "Pro", entitlements: ["pro"], apple: { productId: "com.acme.pro" } },
        pro_annual: {
          type: "subscription",
          name: "Pro year",
          entitlements: ["pro"],
          apple: { productId: "com.acme.pro" },
        },
      },
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message).join("\n")).toMatch(
      /Two products claim the apple SKU "com\.acme\.pro": pro_annual, pro_monthly/,
    );
  });

  test("the same SKU string on two different rails is fine — the rails are separate namespaces", () => {
    const result = PaymentsConfig.safeParse({
      rails: { apple: true, google: true },
      products: {
        pro_monthly: {
          type: "subscription",
          name: "Pro",
          entitlements: ["pro"],
          apple: { productId: "pro_monthly" },
          google: { productId: "pro_monthly" },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  test("a ledger grant on a subscription is legal — it fires once per billing period", () => {
    const result = PaymentsConfig.safeParse({
      rails: { stripe: true },
      stripe: STRIPE_RETURN_URLS,
      products: {
        pro_monthly: {
          type: "subscription",
          name: "Pro",
          entitlements: ["pro"],
          grants: { ledger: { currency: "coins", amount: 500 } },
          stripe: { priceId: "price_1Abc" },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  test("the Stripe rail without return URLs fails at assembly, not on the first checkout", () => {
    // Hosted Checkout and the Billing Portal cannot create a session without somewhere to return to. A deploy is
    // the moment to learn that; a 404 on a buyer's first checkout reads as a bug rather than as missing config.
    const result = PaymentsConfig.safeParse({
      rails: { stripe: true },
      products: {
        pro_monthly: { type: "subscription", name: "Pro", entitlements: ["pro"], stripe: { priceId: "price_1Abc" } },
      },
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message).join("\n")).toMatch(/`stripe` must declare/);
  });

  test("return URLs for a rail that is off fail too — the mirror of the per-product rule", () => {
    const result = PaymentsConfig.safeParse({ rails: { apple: true }, stripe: STRIPE_RETURN_URLS, products: {} });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message).join("\n")).toMatch(/`rails.stripe` is off/);
  });

  test("a return URL that is not an http(s) URL is refused", () => {
    // These reach a browser as a redirect target. `javascript:` is a URL as far as the parser is concerned, and
    // config is the last place to catch one.
    for (const successUrl of ["javascript:alert(1)", "not a url", "ftp://acme.example/ok"]) {
      const result = PaymentsConfig.safeParse({
        rails: { stripe: true },
        stripe: { ...STRIPE_RETURN_URLS, successUrl },
        products: {},
      });
      expect(result.success, successUrl).toBe(false);
    }
  });

  test("a ledger grant on a non-consumable fails — it is bought once and restored forever", () => {
    const result = PaymentsConfig.safeParse({
      rails: { apple: true },
      products: {
        starter_pack: {
          type: "non_consumable",
          name: "Starter pack",
          grants: { ledger: { currency: "coins", amount: 500 } },
          apple: { productId: "com.acme.starter" },
        },
      },
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message).join("\n")).toMatch(
      /Product "starter_pack" is a non_consumable with a `grants` clause/,
    );
  });

  test("a product on no rail at all fails — nothing could ever buy it", () => {
    const result = PaymentsConfig.safeParse({
      rails: { apple: true },
      products: { ghost: { type: "subscription", name: "Ghost", entitlements: ["pro"] } },
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message).join("\n")).toMatch(/Product "ghost" declares no rail/);
  });

  test("a product that grants nothing fails — a purchase with no effect is a catalog mistake", () => {
    const result = PaymentsConfig.safeParse({
      rails: { apple: true },
      products: { inert: { type: "consumable", name: "Inert", apple: { productId: "com.acme.inert" } } },
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message).join("\n")).toMatch(/Product "inert" grants nothing/);
  });

  test("one bad catalog reports every rule it breaks, so a config is fixed in one pass", () => {
    const result = PaymentsConfig.safeParse({
      rails: { apple: false },
      products: { ghost: { type: "non_consumable", name: "Ghost", apple: { productId: "com.acme.ghost" } } },
    });
    expect(result.success).toBe(false);
    // The disabled rail, and the product granting nothing. Zod collects both rather than short-circuiting.
    expect(result.error?.issues.length).toBeGreaterThanOrEqual(2);
  });
});

describe("catalog lookups", () => {
  const config = PaymentsConfig.parse(catalog());

  test("resolves a product by its logical id", () => {
    expect(resolveProduct(config, "pro_monthly")?.id).toBe("pro_monthly");
    expect(resolveProduct(config, "pro_monthly")?.product.type).toBe("subscription");
  });

  test("an unknown logical id resolves to undefined, so the caller raises its own 404", () => {
    expect(resolveProduct(config, "pro_quarterly")).toBeUndefined();
  });

  test("resolves a product by (rail, provider SKU) — what a webhook actually carries", () => {
    expect(productForProviderSku(config, "apple", "com.acme.pro.monthly")?.id).toBe("pro_monthly");
    expect(productForProviderSku(config, "google", "pro_monthly")?.id).toBe("pro_monthly");
    expect(productForProviderSku(config, "stripe", "price_1Abc")?.id).toBe("pro_monthly");
  });

  test("a SKU is looked up within its own rail only — Google's `pro_monthly` is not Apple's", () => {
    expect(productForProviderSku(config, "apple", "pro_monthly")).toBeUndefined();
    expect(productForProviderSku(config, "stripe", "com.acme.pro.monthly")).toBeUndefined();
  });

  test("a SKU no catalog product maps resolves to undefined", () => {
    expect(productForProviderSku(config, "apple", "com.acme.unknown")).toBeUndefined();
  });

  test("reads a product's SKU for one rail, and undefined for a rail it does not ship on", () => {
    const product = resolveProduct(config, "remove_ads")?.product;
    expect(product && providerProductId(product, "apple")).toBe("com.acme.removeads");
    expect(product && providerProductId(product, "stripe")).toBeUndefined();
  });

  test("entitlements for a product, and an empty list for one that grants none", () => {
    expect(entitlementsForProduct(config, "pro_monthly")).toEqual(["pro"]);
    expect(entitlementsForProduct(config, "coins_100")).toEqual([]);
    expect(entitlementsForProduct(config, "nope")).toEqual([]);
  });

  test("the grantable set is what the catalog sells plus what the adopter declared", () => {
    // The set a manual grant is checked against (#300). Deduplicated across products, because two
    // products granting one key is the whole point of the catalog's shape.
    expect([...grantableEntitlements(config)].sort()).toEqual(["ads_removed", "pro"]);
    const withDeclared = PaymentsConfig.parse({
      rails: { apple: true },
      manualEntitlements: ["founder", "pro"],
      products: {
        pro_monthly: {
          type: "subscription",
          name: "Pro",
          entitlements: ["pro"],
          apple: { productId: "com.acme.pro.monthly" },
        },
      },
    });
    expect([...grantableEntitlements(withDeclared)].sort()).toEqual(["founder", "pro"]);
  });

  test("a project selling nothing and declaring nothing defines no key at all", () => {
    // Empty is a real answer, not a missing one: every grant against it is refused, because there is no
    // vocabulary to grant in. The same statement the catalog read makes as `{ enabled: false }`.
    expect(grantableEntitlements(PaymentsConfig.parse({})).size).toBe(0);
  });

  test("a declared manual key must still be a well-formed entitlement key", () => {
    // The escape widens *which* keys are legal, never what a key may look like — gating code names these.
    expect(() => PaymentsConfig.parse({ manualEntitlements: ["Founder Tier!"] })).toThrow();
  });

  test("reports which rails are enabled", () => {
    expect(railEnabled(config, "apple")).toBe(true);
    expect(railEnabled(PaymentsConfig.parse({ products: {} }), "apple")).toBe(false);
  });
});
