// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability, PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { resolveClientProjection } from "@pithy-sh/core/src/capability/client";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { ledger } from "@pithy-sh/ledger/src/capability";
import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { isPaymentsCapability, PAYMENTS_MIGRATION_ORDER, payments } from "./capability";
import {
  PaymentsClawbackFailedError,
  PaymentsEntitlementRequiredError,
  PaymentsEnvironmentMismatchError,
  PaymentsInvalidReceiptError,
  PaymentsProductNotFoundError,
  PaymentsProviderUnavailableError,
  PaymentsRailNotConfiguredError,
  PaymentsReceiptAlreadyOwnedError,
  PaymentsVerificationFailedError,
  PaymentsWebhookUnverifiedError,
} from "./error/errors";
import { paymentsWorkflows } from "./workflows/specs";

const CATALOG = {
  rails: { apple: true, stripe: true },
  stripe: {
    successUrl: "https://acme.example/thanks?session={CHECKOUT_SESSION_ID}",
    cancelUrl: "https://acme.example/pricing",
    portalReturnUrl: "https://acme.example/account",
  },
  products: {
    pro_monthly: {
      type: "subscription" as const,
      name: "Pro",
      entitlements: ["pro"],
      apple: { productId: "com.acme.pro.monthly" },
      stripe: { priceId: "price_1Abc" },
    },
  },
};

/**
 * The capability's identity, and the three names derived from it that outlive any refactor: the table
 * prefix, the composed migration key, and the error-code domain. CLAUDE.md requires all three to carry the
 * same `<capability>` segment, and requires the composed key to be **stable forever** — a rename after
 * release makes Kysely read applied migrations as unapplied and re-run them. These assertions are what stop
 * them moving.
 */
describe("payments()", () => {
  test("names itself so the migration namespace, table prefix, and error domain line up", () => {
    expect(payments(CATALOG).name).toBe("payments");
  });

  test("requires the app D1 binding, and the reconcile Workflow only optionally", () => {
    // `optional: true` is load-bearing rather than cosmetic. The Workflow lives in a prebuilt worker that
    // exists only once `pithy payments provision` has run, and a required binding would make `pithy add
    // payments` produce a Worker that refuses to boot until somebody has touched a Cloudflare account.
    expect(payments(CATALOG).requiredBindings).toEqual([
      { type: "d1", name: "DB", optional: false },
      { type: "workflow", name: "PAYMENTS_RECONCILE", optional: true },
    ]);
  });

  test("the workflow binding is derived from the spec, so a rename cannot leave the two disagreeing", () => {
    const binding = payments(CATALOG).requiredBindings?.find((entry) => entry.type === "workflow");
    expect(binding?.name).toBe(paymentsWorkflows.reconcile.binding);
  });

  test("declares its one durable job, so `c.var.workflows.trigger` types the key", () => {
    expect(Object.keys(payments(CATALOG).workflows ?? {})).toEqual(["reconcile"]);
  });

  test("the manifest's requiredBindings match the capability's — nothing else checks that they do", async () => {
    const manifest = (await import("../pithy.manifest.json", { with: { type: "json" } })).default;
    expect(manifest.requiredBindings.map((b) => `${b.type}:${b.name}`)).toEqual(
      payments(CATALOG).requiredBindings.map((b) => `${b.type}:${b.name}`),
    );
  });

  test("the manifest's peerCapabilities match dependsOn — the two must not drift", async () => {
    const manifest = (await import("../pithy.manifest.json", { with: { type: "json" } })).default;
    expect(manifest.peerCapabilities).toEqual(payments(CATALOG).dependsOn);
  });

  test("the manifest names the capability and its migration namespace the same as the code", async () => {
    const manifest = (await import("../pithy.manifest.json", { with: { type: "json" } })).default;
    expect(manifest.name).toBe(payments(CATALOG).name);
    expect(manifest.migrationNamespace).toBe(payments(CATALOG).name);
    expect(manifest.package).toBe("@pithy-sh/payments");
  });

  test("depends on secrets, and only on secrets — auth and ledger are seams, so a missing one denies", () => {
    // A secret read that cannot resolve is a wiring failure and must stop the Worker booting. A missing
    // auth capability is different: every route denies, which is the correct outcome and needs no edge.
    expect(payments(CATALOG).dependsOn).toEqual(["secrets"]);
  });

  test("declares itself the entitlement provider, so `pithy doctor` reports no false gap", () => {
    // `findEntitlementGap` keys on this flag. Without it, every project composing payments would be told
    // its `requireEntitlement()` calls have no provider — the exact opposite of the truth.
    expect(payments(CATALOG).providesEntitlements).toBe(true);
  });

  test("installs one middleware — the resolver that replaces core's fail-closed default", () => {
    expect(payments(CATALOG).middleware).toHaveLength(1);
  });

  test("declares its secret registry, so `sharedSecretsStore` can resolve the rails' credentials", () => {
    // A read of a name no composed capability declared throws, so this is the wiring the routes depend on.
    expect(Object.keys(payments(CATALOG).secretRegistry ?? {})).toEqual(["payments-provider-credentials"]);
  });

  test("contributes its routes, mounted under the configured basePath", () => {
    const app = new Hono<PithyHonoEnv>();
    payments({ ...CATALOG, basePath: "/billing" }).routes?.(app);
    const paths = [...new Set(app.routes.map((route) => route.path))].sort();
    expect(paths).toEqual([
      // The management surface (#247), under `admin/` because the player surface already owns
      // `/billing/entitlements` and `/billing/purchases`.
      "/billing/admin/entitlements",
      "/billing/admin/entitlements/:userId",
      "/billing/admin/purchases",
      "/billing/admin/subscriptions",
      "/billing/checkout",
      "/billing/entitlements",
      "/billing/entitlements/grant",
      "/billing/entitlements/revoke",
      "/billing/portal",
      "/billing/purchases",
      "/billing/restore",
      "/billing/webhooks/apple",
      "/billing/webhooks/google",
      "/billing/webhooks/stripe",
    ]);
  });

  test("prefixes every table it provides with pithy_payments_", () => {
    const tables = Object.keys(payments(CATALOG).databases?.app?.tables ?? {});
    expect(tables.sort()).toEqual([
      "pithyPaymentsEntitlements",
      "pithyPaymentsProviderAccounts",
      "pithyPaymentsPurchases",
      "pithyPaymentsWebhookEvents",
    ]);
    // CamelCasePlugin snake-cases each to `pithy_payments_*`; the prefix is what keeps them out of an
    // adopter's own namespace, so every table must carry it, not just the ones a reader remembers.
    for (const table of tables) expect(table.startsWith("pithyPayments")).toBe(true);
  });

  test("ships its migrations under stable local keys, at its allocated order", () => {
    const spec = payments(CATALOG).databases?.app;
    expect(Object.keys(spec?.migrations ?? {})).toEqual(["0001_purchases", "0002_control_plane_reads"]);
    expect(spec?.migrationOrder).toBe(PAYMENTS_MIGRATION_ORDER);
    expect(PAYMENTS_MIGRATION_ORDER).toBe(1000);
  });

  test("composes to 1000_payments_<key> — the applied-migration names, stable forever", async () => {
    const capability = payments(CATALOG);
    const spec = capability.databases?.app;
    const registry = createMigrationRegistry([
      {
        database: "app",
        namespace: capability.name,
        order: spec?.migrationOrder ?? -1,
        migrations: spec?.migrations ?? {},
      },
    ]);
    expect(Object.keys(await (registry.app?.getMigrations() ?? Promise.resolve({})))).toEqual([
      "1000_payments_0001_purchases",
      "1000_payments_0002_control_plane_reads",
    ]);
  });

  test("throws only payments/* error codes", () => {
    const thrown = [
      new PaymentsInvalidReceiptError(),
      new PaymentsVerificationFailedError(),
      new PaymentsWebhookUnverifiedError(),
      new PaymentsRailNotConfiguredError(),
      new PaymentsProductNotFoundError(),
      new PaymentsEnvironmentMismatchError(),
      new PaymentsReceiptAlreadyOwnedError(),
      new PaymentsProviderUnavailableError(),
      new PaymentsEntitlementRequiredError(),
      new PaymentsClawbackFailedError(),
    ];
    for (const error of thrown) expect(error.payload.code.startsWith("payments/")).toBe(true);
  });

  test("carries its parsed catalog, and the guard recognizes it", () => {
    const capability = payments(CATALOG);
    expect(isPaymentsCapability(capability)).toBe(true);
    expect(capability.paymentsConfig.products.pro_monthly?.entitlements).toEqual(["pro"]);
    expect(capability.paymentsConfig.basePath).toBe("/payments");
  });

  test("composes with no arguments at all — an empty catalog is a legal starting point", () => {
    const capability = payments();
    expect(capability.paymentsConfig.products).toEqual({});
    expect(capability.paymentsConfig.rails).toEqual({ apple: false, google: false, stripe: false });
  });

  test("rejects an impossible catalog at assembly, not on the first webhook", () => {
    // A SKU for a rail that is off.
    expect(() => payments({ rails: { apple: false }, products: CATALOG.products })).toThrow();
    // A ledger grant on a non-consumable.
    expect(() =>
      payments({
        rails: { apple: true },
        products: {
          pack: {
            type: "non_consumable",
            name: "Pack",
            grants: { ledger: { currency: "coins", amount: 5 } },
            apple: { productId: "com.acme.pack" },
          },
        },
      }),
    ).toThrow();
  });
});

/**
 * The client projection — `virtual:pithy/payments`, and the one place a decision about what a browser
 * may know is made.
 *
 * This suite is named in issue #79's definition of done, and it has three halves. An **exact-key lock**,
 * because a projection grows by someone adding a key and the review that would have caught it is this
 * test. A **negative sweep** over the serialized result seeded with every credential shape the three
 * rails deal in, so a future edit that reached for a secret fails here rather than in a bundle. And one
 * **positive assertion**, because a projection that leaked nothing by projecting nothing would pass a
 * negative sweep perfectly.
 */
const CLIENT_CATALOG = {
  rails: { apple: true, google: true, stripe: true },
  stripe: {
    successUrl: "https://acme.example/thanks?session={CHECKOUT_SESSION_ID}",
    cancelUrl: "https://acme.example/pricing",
    portalReturnUrl: "https://acme.example/account",
  },
  products: {
    pro_monthly: {
      type: "subscription" as const,
      name: "Pro",
      entitlements: ["pro"],
      apple: { productId: "com.acme.pro.monthly" },
      google: { productId: "pro_monthly" },
      stripe: { priceId: "price_1Abc" },
    },
    remove_ads: {
      type: "non_consumable" as const,
      name: "Remove ads",
      entitlements: ["ads_removed"],
      apple: { productId: "com.acme.removeads" },
    },
    coin_pack: {
      type: "consumable" as const,
      name: "Coin pack",
      grants: { ledger: { currency: "coins", amount: 100 } },
      google: { productId: "coin_pack" },
    },
  },
};

/**
 * Every credential shape the three rails carry, and the binding name the data lives behind.
 *
 * None of these can reach the projection today, and that is the point worth stating: they live in the
 * secrets store, so the closure resolving the projection cannot see them even if it tried. The sweep
 * guards the future — the edit that adds `credentials` "just for the sitekey", or reaches for `env`.
 */
const NEVER_IN_A_BUNDLE = [
  "sk_live_51NxAcmeSecretKeyValueHere",
  "whsec_9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c",
  "57246542-96fe-1a63-e053-0824d011072a",
  '{"type":"service_account","private_key":"-----BEGIN PRIVATE KEY-----"}',
  "-----BEGIN PRIVATE KEY-----",
  "DB",
];

describe("payments().client — virtual:pithy/payments", () => {
  const projection = resolveClientProjection(payments(CLIENT_CATALOG), { environment: "prod" });

  test("projects exactly five keys, and per product exactly five more", () => {
    expect(Object.keys(projection).sort()).toEqual(["basePath", "enabled", "environment", "products", "rails"]);
    for (const product of projection.products as Record<string, unknown>[]) {
      expect(Object.keys(product).sort()).toEqual(["entitlements", "id", "name", "stripePriceId", "type"]);
    }
  });

  test("no credential-shaped value crosses it", () => {
    const serialized = JSON.stringify(projection);
    for (const secret of NEVER_IN_A_BUNDLE) expect(serialized, secret).not.toContain(secret);
  });

  test("what is meant to cross does cross — a sweep over nothing would pass perfectly", () => {
    const serialized = JSON.stringify(projection);
    // The Stripe price id is publishable by design: it is what a Checkout Session names.
    expect(serialized).toContain("price_1Abc");
    // The catalog a paywall renders, and the keys a route guard checks.
    expect(serialized).toContain("Remove ads");
    expect(serialized).toContain("ads_removed");
    expect(serialized).toContain("/payments");
  });

  test("the grants block never crosses — a currency code and an amount describe the economy", () => {
    const serialized = JSON.stringify(projection);
    expect(serialized).not.toContain("grants");
    expect(serialized).not.toContain("coins");
    expect(serialized).not.toContain("amount");
    // The product itself still renders; only what it fulfils behind the scenes is withheld.
    expect(serialized).toContain("Coin pack");
  });

  test("a product's own store SKUs stay server-side; only the Stripe price is publishable", () => {
    const serialized = JSON.stringify(projection);
    expect(serialized).not.toContain("com.acme.pro.monthly");
    expect(serialized).not.toContain("com.acme.removeads");
  });

  test("null, never undefined — the projection is inlined with JSON.stringify", () => {
    const products = projection.products as { id: string; stripePriceId: string | null }[];
    const adsOnly = products.find((product) => product.id === "remove_ads");
    expect(adsOnly?.stripePriceId).toBeNull();
    expect(JSON.stringify(projection)).not.toContain("undefined");
  });

  test("carries the enabled rails, so a paywall knows which products it can actually sell", () => {
    expect(projection.rails).toEqual({ apple: true, google: true, stripe: true });
    const mobileOnly = resolveClientProjection(
      payments({ rails: { apple: true }, products: { remove_ads: CLIENT_CATALOG.products.remove_ads } }),
      { environment: "dev" },
    );
    expect(mobileOnly.rails).toEqual({ apple: true, google: false, stripe: false });
  });

  test("names the environment the bundle was built for", () => {
    expect(projection.environment).toBe("prod");
    expect(resolveClientProjection(payments(CLIENT_CATALOG), { environment: "staging" }).environment).toBe("staging");
  });

  test("an empty catalog is { enabled: false } — there is no paywall to render", () => {
    // A screen branches on `enabled` rather than guarding, so "composed but with nothing to sell" has to
    // be the same shape as "not composed at all".
    expect(resolveClientProjection(payments(), { environment: "dev" })).toEqual({ enabled: false });
  });

  test("an uncomposed capability is { enabled: false } too", () => {
    expect(resolveClientProjection(undefined, { environment: "dev" })).toEqual({ enabled: false });
  });
});

/**
 * The `compose` hook: the one cross-capability check payments performs, and the one it cannot do at
 * construction time because a capability sees only itself there.
 *
 * `openLedger` validates nothing. Crediting `coins` in a project whose ledger declares only `gems` opens a
 * real account row nobody can ever reach — `GET /ledger/coins` 404s on the currency, so the money is
 * unreachable and the player is told their purchase worked. That is a typo in `pithy.config.ts`, and the only
 * place to catch a typo is a deploy.
 */
const GRANTING_CATALOG = {
  rails: { apple: true },
  products: {
    coins_100: {
      type: "consumable" as const,
      name: "100 coins",
      grants: { ledger: { currency: "coins", amount: 100 } },
      apple: { productId: "com.acme.coins100" },
    },
  },
};

const compose = (capability: ReturnType<typeof payments>, peers: Capability[]) =>
  capability.compose?.({ capabilities: [capability, ...peers] });

/** The refusal's internal context, where the product ids and currency codes belong — never in `message`. */
function composeDetail(capability: ReturnType<typeof payments>, peers: Capability[]): string {
  try {
    compose(capability, peers);
  } catch (cause) {
    if (cause instanceof PithyError) return `${cause.payload.action} ${cause.payload.detail}`;
    throw cause;
  }
  throw new Error("compose did not refuse");
}

describe("payments().compose", () => {
  test("accepts a grant whose currency the composed ledger declares", () => {
    const capability = payments(GRANTING_CATALOG);
    const peer = ledger({ currencies: [{ code: "coins", name: "Coins" }] });
    expect(() => compose(capability, [peer])).not.toThrow();
  });

  test("refuses a grant currency the ledger does not declare, naming the product and the currency", () => {
    const capability = payments(GRANTING_CATALOG);
    const peer = ledger({ currencies: [{ code: "gems", name: "Gems" }] });
    expect(() => compose(capability, [peer])).toThrow(PithyError);
    const detail = composeDetail(capability, [peer]);
    expect(detail).toContain("coins_100");
    expect(detail).toContain("coins");
    // And what the ledger *does* declare, so the fix does not need a second look at pithy.config.ts.
    expect(detail).toContain("gems");
  });

  test("refuses a grants clause with no ledger composed at all", () => {
    // Not a silent skip. The catalog has promised a balance credit, and nothing can perform it.
    const detail = composeDetail(payments(GRANTING_CATALOG), []);
    expect(detail).toContain("@pithy-sh/ledger");
    expect(detail).toContain("coins_100");
  });

  test("needs no ledger when nothing in the catalog grants a balance", () => {
    expect(() => compose(payments(CATALOG), [])).not.toThrow();
  });

  test("reports every mismatched product at once, not the first", () => {
    // An operator fixing one typo per deploy is a bad afternoon.
    const capability = payments({
      rails: { apple: true },
      products: {
        coins_100: {
          type: "consumable",
          name: "100 coins",
          grants: { ledger: { currency: "coins", amount: 100 } },
          apple: { productId: "com.acme.coins100" },
        },
        gems_10: {
          type: "consumable",
          name: "10 gems",
          grants: { ledger: { currency: "gemz", amount: 10 } },
          apple: { productId: "com.acme.gems10" },
        },
      },
    });
    const detail = composeDetail(capability, [ledger({ currencies: [{ code: "gems", name: "Gems" }] })]);
    expect(detail).toContain("coins_100");
    expect(detail).toContain("gems_10");
  });
});
