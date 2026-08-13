// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import type { Capability, PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { resolveClientProjection } from "@pithy-sh/core/src/capability/client";
import { CapabilityManifest } from "@pithy-sh/core/src/capability/manifest";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { unpublishedIn } from "@pithy-sh/core/src/projection/published";
import { ledger } from "@pithy-sh/ledger/src/capability";
import type { SecretRegistryEntry } from "@pithy-sh/secrets/src/registry";
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
import { PAYMENTS_PROVIDER_SECRET, paymentsSecretsRegistry } from "./secret/registry";
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
      // The management surface (#247, #300), under `admin/` because the player surface already owns
      // `/billing/entitlements` and `/billing/purchases`.
      "/billing/admin/catalog",
      "/billing/admin/discounts",
      "/billing/admin/entitlements",
      "/billing/admin/entitlements/:userId",
      "/billing/admin/purchases",
      "/billing/admin/subscriptions",
      "/billing/checkout",
      "/billing/entitlements",
      "/billing/entitlements/grant",
      "/billing/entitlements/revoke",
      "/billing/portal",
      "/billing/pricing",
      "/billing/purchases",
      "/billing/restore",
      "/billing/webhooks/apple",
      "/billing/webhooks/google",
      "/billing/webhooks/lemon-squeezy",
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
    expect(Object.keys(spec?.migrations ?? {})).toEqual(["0001_purchases"]);
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
    expect(capability.paymentsConfig.rails).toEqual({
      apple: false,
      google: false,
      stripe: false,
      lemonSqueezy: false,
    });
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

describe("pithy.manifest.json — declared secrets", () => {
  const manifest = CapabilityManifest.parse(
    JSON.parse(readFileSync(new URL("../pithy.manifest.json", import.meta.url), "utf8")),
  );

  test("every registry entry is in the manifest, and says where it comes from and how it is replaced", () => {
    // The gate this capability had none of. `pithy doctor`, `pithy secrets ls` and a management
    // dashboard read the manifest without executing this package, so a declaration the manifest omits
    // is a declaration nothing downstream can act on — and a secret declaring neither axis renders as
    // *nothing is known* rather than *nothing can help*.
    //
    // Stated as the invariant, never as a filtered comparison. Building the expected list from the
    // entries that declare both axes and comparing it to the manifest cannot fail for the one case it
    // exists to catch: an entry declaring neither is dropped from both sides at once and the comparison
    // passes green. That is the shape #324 replaced in auth and email; here there was nothing at all.
    const entries: [string, SecretRegistryEntry][] = Object.entries(paymentsSecretsRegistry);
    expect(manifest.secrets.map((secret) => secret.name)).toEqual(entries.map(([name]) => name));
    for (const [name, entry] of entries) {
      expect(entry.origin, `${name} declares no origin`).toBeDefined();
      expect(entry.rotation, `${name} declares no rotation`).toBeDefined();
      expect(manifest.secrets.find((secret) => secret.name === name)).toEqual({
        name,
        origin: entry.origin,
        rotation: entry.rotation,
      });
    }
  });

  test("names what each rail's block needs, because one bundle has four issuers and one issuer field", () => {
    // The honest floor for a bundle. `issuer` holds one value and this secret is assembled from up to
    // four consoles, so the field is `other` and the page named is the one that lists all four.
    const declared = manifest.secrets.find((secret) => secret.name === PAYMENTS_PROVIDER_SECRET);
    expect(declared?.origin.kind).toBe("obtained");
    expect(declared?.rotation.kind).toBe("manual");
    expect(declared?.origin.kind === "obtained" && declared.origin.documentation).toMatch(/^https:\/\//);
  });

  test("mints nothing — a generated Stripe key authenticates against nothing", () => {
    expect(manifest.devSecrets).toEqual([]);
  });
});

/**
 * The client projection — `virtual:pithy/payments`, and the one place a decision about what a browser
 * may know is made.
 *
 * This suite is named in issue #79's definition of done, and it has three halves. An **exact-key lock**,
 * because a projection grows by someone adding a key and the review that would have caught it is this
 * test. A **positive invariant** over the serialized result — every leaf is one of the facts a browser
 * may know, and every key is one written out by hand — so a future edit that reached for a secret fails
 * here rather than in a bundle. And a **vacuity check**, because a projection that leaked nothing by
 * projecting nothing would pass either of those perfectly.
 *
 * The middle half used to be a list of credential shapes that must not appear: a Stripe live key, a
 * webhook secret, an Apple issuer id, a Google service-account document. It was replaced rather than
 * extended. A negative list is complete only against the values somebody thought of, and a projection
 * widens by gaining a *field* — the event no value list can observe. Those shapes are all still refused,
 * strictly: none of them is a product id, a kind, a display name, an entitlement key, a hosted-checkout
 * identifier, a rail flag or a base path, so any of them crossing is a leaf the sweep reports.
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
      // The store SKUs are deliberately unlike the product id. They were `pro_monthly` and `coin_pack`,
      // which are also the ids — so no sweep could tell an Apple or Play SKU that crossed from a product
      // id that was meant to, and the two most obvious forbidden values were invisible to any check.
      apple: { productId: "com.acme.pro.monthly" },
      google: { productId: "acme.pro.monthly.v1" },
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
      // A currency code and an amount describe the economy, so neither crosses. The amount is the
      // numeric sentinel and `clawback` the boolean one — a flag is the cheapest way to widen a
      // projection, and `true` is a value the leaf half can never police on its own.
      grants: { ledger: { currency: "coins", amount: 4242 } },
      clawback: true,
      google: { productId: "acme.coin.pack.v1" },
    },
  },
};

/**
 * Every key the client projection may carry, at any depth. Fifteen: the envelope's five, the four rail
 * flags, and a product's six.
 *
 * **Written out, never `Object.keys(...)` of the projection or its type.** A gate that reads its own
 * subject cannot fail when the subject changes — deriving the permitted set from the thing being policed
 * widens the permission in the same commit that widens the projection, and the test whose whole job is
 * to catch that passes. Adding a key to a browser bundle means editing this line, deliberately, beside
 * the sentence saying why it is short.
 */
const PUBLISHED_CLIENT_KEYS = [
  "enabled",
  "environment",
  "rails",
  "basePath",
  "products",
  "apple",
  "google",
  "stripe",
  "lemonSqueezy",
  "id",
  "type",
  "entitlements",
  "name",
  "stripePriceId",
  "lemonSqueezyVariantId",
];

describe("payments().client — virtual:pithy/payments", () => {
  const projection = resolveClientProjection(payments(CLIENT_CATALOG), { environment: "prod" });

  test("projects exactly five keys, and per product exactly six more", () => {
    expect(Object.keys(projection).sort()).toEqual(["basePath", "enabled", "environment", "products", "rails"]);
    for (const product of projection.products as Record<string, unknown>[]) {
      expect(Object.keys(product).sort()).toEqual([
        "entitlements",
        "id",
        "lemonSqueezyVariantId",
        "name",
        "stripePriceId",
        "type",
      ]);
    }
  });

  test("nothing but what a browser may know crosses it, whatever a field is called", () => {
    // The invariant, stated rather than enumerated. Two halves, because either alone permits the mistake:
    // a value the catalog carries must not appear under *any* key, and a key must be one of the fifteen
    // named by hand — the second is what stops a field arriving with a value from somewhere else, and it
    // is the only half that can police a boolean or a null.
    //
    // Serialized and re-parsed on purpose: `JSON.stringify` is how this reaches a bundle, so what the
    // sweep walks is exactly what an adopter's users receive.
    const inlined: unknown = JSON.parse(JSON.stringify(projection));

    const published: (string | number | boolean | null)[] = [
      // The envelope: composed, which environment it was built for, and where the routes are.
      true,
      false,
      null,
      "prod",
      "/payments",
    ];
    for (const [id, product] of Object.entries(CLIENT_CATALOG.products)) {
      published.push(id, product.type, product.name);
      for (const key of "entitlements" in product ? product.entitlements : []) published.push(key);
      // The one hosted-checkout identifier a browser legitimately names: a Stripe price id is what a
      // Checkout Session is opened with. The store SKUs above are not, and that is the whole line.
      if ("stripe" in product) published.push(product.stripe.priceId);
    }
    const escaped = unpublishedIn(inlined, { leaves: published, keys: PUBLISHED_CLIENT_KEYS });
    expect(
      escaped,
      `These reached an adopter's users and are not a product's id, kind, display name, entitlement key or hosted-checkout id:\n  ${escaped.join("\n  ")}`,
    ).toEqual([]);
  });

  test("the catalog really carries everything the sweep is meant to refuse", () => {
    // A gate over nothing passes perfectly. The config the assertion above reads must genuinely hold the
    // store SKUs, a ledger currency and amount, three return URLs and a flag, or that test proves nothing.
    const serialized = JSON.stringify(CLIENT_CATALOG);
    for (const withheld of [
      "com.acme.pro.monthly",
      "acme.pro.monthly.v1",
      "com.acme.removeads",
      "acme.coin.pack.v1",
      "coins",
      "4242",
      "https://acme.example/pricing",
      // A boolean the catalog carries and the bundle must not. The leaf half is blind to this whole JSON
      // type by construction, so the catalog holds one and the key half has something to be measured by.
      '"clawback":true',
    ]) {
      expect(serialized, withheld).toContain(withheld);
    }
  });

  test("what is meant to cross does cross — a sweep over nothing would pass perfectly", () => {
    const serialized = JSON.stringify(projection);
    // The Stripe price id is publishable by design: it is what a Checkout Session names.
    expect(serialized).toContain("price_1Abc");
    // The catalog a paywall renders, and the keys a route guard checks.
    expect(serialized).toContain("Remove ads");
    expect(serialized).toContain("ads_removed");
    expect(serialized).toContain("/payments");
    // The product a browser must still be able to show, whose economics it must not learn.
    expect(serialized).toContain("Coin pack");
  });

  test("null, never undefined — the projection is inlined with JSON.stringify", () => {
    const products = projection.products as { id: string; stripePriceId: string | null }[];
    const adsOnly = products.find((product) => product.id === "remove_ads");
    expect(adsOnly?.stripePriceId).toBeNull();
    expect(JSON.stringify(projection)).not.toContain("undefined");
  });

  test("carries the enabled rails, so a paywall knows which products it can actually sell", () => {
    expect(projection.rails).toEqual({ apple: true, google: true, stripe: true, lemonSqueezy: false });
    const mobileOnly = resolveClientProjection(
      payments({ rails: { apple: true }, products: { remove_ads: CLIENT_CATALOG.products.remove_ads } }),
      { environment: "dev" },
    );
    expect(mobileOnly.rails).toEqual({ apple: true, google: false, stripe: false, lemonSqueezy: false });
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
