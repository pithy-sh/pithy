// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { EntitlementKey } from "@pithy-sh/core/src/entitlement/entitlement";
import { z } from "zod";
import { PAYMENTS_RAILS, type PaymentsRail } from "../data/rail";

/**
 * The payments capability's config — the catalog, and the thin surface an adopter owns in
 * `pithy.config.ts`. Every field is `.describe()`d: the descriptions feed the self-documenting CLI
 * (CLAUDE.md §Config).
 *
 * **The catalog lives here, not in D1.** A product's entitlement mapping is policy: it should be
 * diffable in git and it should not be mutable at runtime. The cost is that a new SKU requires a
 * deploy, which is the correct trade — a table an attacker or a mis-click can edit decides who is
 * entitled to what.
 *
 * The load-bearing distinction the shape encodes is that **a product is not an entitlement**.
 * `pro_monthly` and `pro_annual` are two products, in three rails' catalogs, granting one entitlement —
 * `pro`. Gating code names the entitlement; only this file ever names a SKU.
 *
 * A product declares rails selectively. `remove_ads` shipping on mobile only is expressed by omitting
 * the `stripe` block, not by a flag — so the config reads as the catalog it is.
 */

/** The longest a display name may be. Long enough for a real product title, short enough to render. */
const MAX_NAME_LENGTH = 120;

/** The longest a provider SKU or price id may be. Apple's reverse-DNS ids are the long end of this. */
const MAX_SKU_LENGTH = 200;

/** A ledger currency code, matching `@pithy-sh/ledger`'s own: lowercase, digits, and dashes. */
const CURRENCY_CODE_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** The longest a return URL may be. Generous against a long path with a template token in the query. */
const MAX_URL_LENGTH = 2048;

/** A page in the adopter's own app that a hosted Stripe flow returns a browser to. */
const ReturnUrl = z.url({ protocol: /^https?$/ }).max(MAX_URL_LENGTH);

export const PaymentsRailToggles = z
  .object({
    apple: z
      .boolean()
      .default(false)
      .describe("Whether App Store purchases are accepted. Credentials come from the secrets store, never config."),
    google: z
      .boolean()
      .default(false)
      .describe("Whether Google Play purchases are accepted. Credentials come from the secrets store, never config."),
    stripe: z
      .boolean()
      .default(false)
      .describe(
        "Whether Stripe purchases are accepted, through hosted Checkout and the Billing Portal. Pithy never owns payment UI, SCA, tax, or proration.",
      ),
  })
  .describe("Which payment rails this project accepts. A rail that is off refuses its routes and its webhook.");
export type PaymentsRailToggles = z.infer<typeof PaymentsRailToggles>;

export const PaymentsProductType = z
  .enum(["consumable", "non_consumable", "subscription"])
  .describe(
    "What kind of thing the product is: a consumable spent after purchase, a non-consumable owned forever and restorable, or a subscription that renews and can lapse.",
  );
export type PaymentsProductType = z.infer<typeof PaymentsProductType>;

export const PaymentsAppleProduct = z
  .object({
    productId: z
      .string()
      .min(1)
      .max(MAX_SKU_LENGTH)
      .describe("The App Store Connect product identifier, usually reverse-DNS — `com.acme.pro.monthly`."),
  })
  .describe("How this product is listed on the App Store. Omit the block to ship without the Apple rail.");
export type PaymentsAppleProduct = z.infer<typeof PaymentsAppleProduct>;

export const PaymentsGoogleProduct = z
  .object({
    productId: z
      .string()
      .min(1)
      .max(MAX_SKU_LENGTH)
      .describe("The Play Console product or base-plan id — `pro_monthly`."),
  })
  .describe("How this product is listed on Google Play. Omit the block to ship without the Google rail.");
export type PaymentsGoogleProduct = z.infer<typeof PaymentsGoogleProduct>;

export const PaymentsStripeProduct = z
  .object({
    priceId: z
      .string()
      .min(1)
      .max(MAX_SKU_LENGTH)
      .describe(
        "The Stripe Price id — `price_1Abc`. Publishable by design: it is what a Checkout Session names, so it may reach a browser.",
      ),
  })
  .describe("How this product is priced in Stripe. Omit the block to ship without the Stripe rail.");
export type PaymentsStripeProduct = z.infer<typeof PaymentsStripeProduct>;

export const PaymentsStripeSettings = z
  .object({
    successUrl: ReturnUrl.describe(
      "Where hosted Checkout returns a buyer who paid. Put `{CHECKOUT_SESSION_ID}` in the query and Stripe fills it in, so the page can post it to /payments/purchases and show the entitlement at once instead of waiting for the webhook.",
    ),
    cancelUrl: ReturnUrl.describe("Where hosted Checkout returns a buyer who backed out. Usually the paywall."),
    portalReturnUrl: ReturnUrl.describe("Where the Billing Portal returns a subscriber who is done managing."),
  })
  .describe(
    "Where Stripe's hosted pages send a browser back to. Config, not request input: a client that could name a return URL could send a paying customer to a page it controls.",
  );
export type PaymentsStripeSettings = z.infer<typeof PaymentsStripeSettings>;

export const PaymentsLedgerGrant = z
  .object({
    currency: z
      .string()
      .regex(CURRENCY_CODE_PATTERN, "A currency code is lowercase, digits, and dashes.")
      .describe("The `@pithy-sh/ledger` currency to credit — must be one that capability's config declares."),
    amount: z
      .number()
      .int()
      .positive()
      .describe("How much to credit, as an integer in the currency's minor unit. Never a float, never zero."),
  })
  .describe("A balance credit performed on fulfillment, once per provider transaction.");
export type PaymentsLedgerGrant = z.infer<typeof PaymentsLedgerGrant>;

export const PaymentsGrants = z
  .object({
    ledger: PaymentsLedgerGrant.optional().describe(
      "Credit a `@pithy-sh/ledger` balance when this product is fulfilled. The only point of contact between the two capabilities, and opt-in — most products never touch a balance.",
    ),
  })
  .describe("What a purchase fulfills beyond its entitlements. Absent for the products that only unlock a feature.");
export type PaymentsGrants = z.infer<typeof PaymentsGrants>;

export const PaymentsProduct = z
  .object({
    type: PaymentsProductType.describe("What kind of product this is. Decides how a renewal and a restore behave."),
    name: z
      .string()
      .min(1)
      .max(MAX_NAME_LENGTH)
      .describe(
        "The display name a paywall renders — `Pro`, `Remove ads`. Required: it is the one product field a browser is given, and a paywall with no copy renders nothing.",
      ),
    entitlements: z
      .array(EntitlementKey)
      .default([])
      .describe(
        "The entitlement keys this product grants. Many products across many rails may grant one key, which is the whole point — gating code names the key, never this product. Empty for a product that only credits a balance.",
      ),
    apple: PaymentsAppleProduct.optional().describe("The Apple listing, if this product ships on the App Store."),
    google: PaymentsGoogleProduct.optional().describe("The Google listing, if this product ships on Google Play."),
    stripe: PaymentsStripeProduct.optional().describe("The Stripe price, if this product is sold through Stripe."),
    grants: PaymentsGrants.optional().describe(
      "What this purchase fulfills beyond its entitlements. Opt-in per product; a subscription's grant fires once per billing period, since each renewal is a distinct provider transaction.",
    ),
    clawback: z
      .boolean()
      .default(false)
      .describe(
        "Whether a refund attempts to debit back what `grants` credited. Off by default: the user may already have spent it, and a clawback that would overdraw is refused by the ledger rather than routed around. A failed clawback is recorded and queryable, not an exception.",
      ),
  })
  .describe("One logical catalog product — what it is, what it grants, and how each store lists it.");
export type PaymentsProduct = z.infer<typeof PaymentsProduct>;

export const PaymentsConfig = z
  .object({
    rails: PaymentsRailToggles.default({ apple: false, google: false, stripe: false }).describe(
      "Which stores this project sells through. Every rail is off until named.",
    ),
    products: z
      .record(z.string(), PaymentsProduct)
      .default({})
      .describe(
        "The catalog, keyed by logical product id — the id that lands in every purchase row. Keys are yours and outlive any store's SKU, so renaming a SKU in a console never rewrites history.",
      ),
    stripe: PaymentsStripeSettings.optional().describe(
      "Where Stripe's hosted Checkout and Billing Portal return the browser. Required when the Stripe rail is on — the two routes cannot create a session without them.",
    ),
    basePath: z
      .string()
      .default("/payments")
      .describe("Where the payments routes mount, webhooks included. Register the webhook URLs to match."),
    graceGrantsAccess: z
      .boolean()
      .default(true)
      .describe(
        "Whether a subscription in its billing-retry grace period still grants its entitlements. True, because that is the point of grace — a failed card should not lock a paying subscriber out mid-period. Once grace is exhausted the purchase moves to on_hold, which never grants.",
      ),
  })
  .describe("Configuration for the payments capability — the cross-rail product catalog and where it mounts.")
  .check((ctx) => {
    const config = ctx.value;
    const entries = Object.entries(config.products);

    // Stripe's hosted flows cannot be created without somewhere to return to, and a deploy is the moment to
    // find that out. The alternative is a project that ships, sells nothing through Stripe, and reports it as
    // a 404 on the first checkout — which reads as a bug rather than as a missing three lines of config.
    if (config.rails.stripe && config.stripe === undefined) {
      ctx.issues.push({
        code: "custom",
        input: ctx.value,
        path: ["stripe"],
        message:
          "The Stripe rail is on, so `stripe` must declare `successUrl`, `cancelUrl`, and `portalReturnUrl`. Hosted Checkout and the Billing Portal have nowhere to return a browser without them.",
      });
    }

    // The mirror of the per-product rule: return URLs for a rail that is off describe a flow nothing can reach.
    if (!config.rails.stripe && config.stripe !== undefined) {
      ctx.issues.push({
        code: "custom",
        input: ctx.value,
        path: ["stripe"],
        message: "`stripe` declares return URLs, but `rails.stripe` is off. Enable the rail, or drop the block.",
      });
    }

    for (const [id, product] of entries) {
      // A SKU for a rail the project turned off can never be bought, and the webhook that would carry it
      // is refused. Silently ignoring the block would leave a catalog that reads as selling something it
      // does not.
      for (const rail of PAYMENTS_RAILS) {
        if (product[rail] !== undefined && !config.rails[rail]) {
          ctx.issues.push({
            code: "custom",
            input: ctx.value,
            path: ["products", id, rail],
            message: `Product "${id}" declares a ${rail} SKU, but \`rails.${rail}\` is off. Enable the rail, or drop the block — a product ships without a rail by omission.`,
          });
        }
      }

      // A product on no rail is unreachable: a webhook resolves a product by its rail SKU, and there is
      // none to match.
      if (!PAYMENTS_RAILS.some((rail) => product[rail] !== undefined)) {
        ctx.issues.push({
          code: "custom",
          input: ctx.value,
          path: ["products", id],
          message: `Product "${id}" declares no rail. Give it an \`apple\`, \`google\`, or \`stripe\` block — nothing could buy it otherwise.`,
        });
      }

      // A purchase that neither unlocks a feature nor credits a balance does nothing at all. That is a
      // catalog mistake worth catching on deploy rather than as a support ticket after the first sale.
      if (product.entitlements.length === 0 && product.grants?.ledger === undefined) {
        ctx.issues.push({
          code: "custom",
          input: ctx.value,
          path: ["products", id],
          message: `Product "${id}" grants nothing. Give it \`entitlements\`, a \`grants\` clause, or both.`,
        });
      }

      // A `grants` clause credits once per provider transaction. A non-consumable has exactly one, and is
      // restorable forever — so the credit would either fire again on every restore (minting currency) or
      // fire once and make the restore a lie. A subscription is fine: each renewal is its own transaction,
      // so the grant fires per period. A one-time currency purchase is a `consumable`.
      if (product.type === "non_consumable" && product.grants !== undefined) {
        ctx.issues.push({
          code: "custom",
          input: ctx.value,
          path: ["products", id, "grants"],
          message: `Product "${id}" is a non_consumable with a \`grants\` clause. A non-consumable is bought once and restored forever, so a balance credit would fire again on every restore. Make it a consumable, or drop the grant.`,
        });
      }
    }

    // A webhook carries a rail and a SKU, and nothing else that identifies what was bought. Two products
    // claiming one SKU on one rail would make that resolution ambiguous, so it is refused at assembly.
    // The same string on two different rails is fine — the rails are separate namespaces.
    for (const rail of PAYMENTS_RAILS) {
      const owners = new Map<string, string[]>();
      for (const [id, product] of entries) {
        const sku = providerProductId(product, rail);
        if (sku === undefined) continue;
        owners.set(sku, [...(owners.get(sku) ?? []), id]);
      }
      for (const [sku, claimants] of owners) {
        if (claimants.length < 2) continue;
        ctx.issues.push({
          code: "custom",
          input: ctx.value,
          path: ["products"],
          message: `Two products claim the ${rail} SKU "${sku}": ${claimants.sort().join(", ")}. A webhook resolves a product by its rail SKU, so a duplicate makes that resolution ambiguous.`,
        });
      }
    }
  });
export type PaymentsConfig = z.output<typeof PaymentsConfig>;
export type PaymentsConfigInput = z.input<typeof PaymentsConfig>;

/**
 * A catalog product and the logical id it is keyed by. Both halves travel together because every write
 * needs the id — a purchase row stores `productId`, not the product — and every read needs the product.
 */
export interface PaymentsCatalogEntry {
  /** The logical product id — the key in `products`, and what lands in a purchase row. */
  id: string;
  /** The catalog entry itself. */
  product: PaymentsProduct;
}

/** The provider SKU this product is listed under on `rail`, or undefined when it does not ship there. */
export function providerProductId(product: PaymentsProduct, rail: PaymentsRail): string | undefined {
  if (rail === "stripe") return product.stripe?.priceId;
  return rail === "apple" ? product.apple?.productId : product.google?.productId;
}

/** The product with this logical id, or undefined. Ids come from config, so an unknown one is a 404. */
export function resolveProduct(config: PaymentsConfig, id: string): PaymentsCatalogEntry | undefined {
  const product = config.products[id];
  return product === undefined ? undefined : { id, product };
}

/**
 * The product a rail's own SKU maps to — the lookup every provider event needs, since a webhook carries
 * the store's identifier and never a Pithy product id. Scoped to one rail: the same string can be a
 * different product on a different store, and `PaymentsConfig`'s duplicate check is what guarantees the
 * answer is unique within a rail.
 */
export function productForProviderSku(
  config: PaymentsConfig,
  rail: PaymentsRail,
  sku: string,
): PaymentsCatalogEntry | undefined {
  for (const [id, product] of Object.entries(config.products)) {
    if (providerProductId(product, rail) === sku) return { id, product };
  }
  return undefined;
}

/** The entitlement keys a product grants, or an empty list for an unknown product or one that grants none. */
export function entitlementsForProduct(config: PaymentsConfig, id: string): readonly string[] {
  return config.products[id]?.entitlements ?? [];
}

/** Whether a rail is enabled for this project. A disabled rail refuses its routes and its webhook. */
export function railEnabled(config: PaymentsConfig, rail: PaymentsRail): boolean {
  return config.rails[rail];
}
