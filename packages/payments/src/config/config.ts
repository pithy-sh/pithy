// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { EntitlementKey } from "@pithy-sh/core/src/entitlement/entitlement";
import { SIGNED_WEBHOOK_MAX_TOLERANCE_SECONDS } from "@pithy-sh/core/src/http/webhookWindow";
import { z } from "zod";
import { PAYMENTS_RAILS, PaymentsRail } from "../data/rail";
import { PaymentsSubjectType } from "../data/subject";
import {
  type DeclarationProblem,
  declarationProblems,
  declaredQuotaNames,
  PaymentsAllowanceDefaults,
  PaymentsEntitlementDeclaration,
} from "./allowances";

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
    lemonSqueezy: z
      .boolean()
      .default(false)
      .describe(
        "Whether Lemon Squeezy purchases are accepted, through hosted checkout and the customer portal. Lemon Squeezy is the merchant of record: it handles global sales tax, EU VAT, invoicing and dunning, and it issues refunds on its own. Credentials come from the secrets store, never config.",
      ),
    paddle: z
      .boolean()
      .default(false)
      .describe(
        "Whether Paddle purchases are accepted, through an overlay, an inline frame, or Paddle's hosted page. Paddle is the merchant of record: it handles global sales tax, EU VAT, invoicing and dunning, and it issues refunds on its own. The API key and the webhook secret come from the secrets store; the publishable client token is config, because it is designed to reach a browser.",
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

export const PaymentsLemonSqueezyProduct = z
  .object({
    variantId: z
      .string()
      .min(1)
      .max(MAX_SKU_LENGTH)
      .describe(
        "The Lemon Squeezy variant id — `123456`. A variant is Lemon Squeezy's price-equivalent, so this sits exactly where Stripe's `priceId` does. Publishable by design: it is what a hosted checkout names.",
      ),
  })
  .describe("How this product is sold through Lemon Squeezy. Omit the block to ship without that rail.");
export type PaymentsLemonSqueezyProduct = z.infer<typeof PaymentsLemonSqueezyProduct>;

export const PaymentsLemonSqueezySettings = z
  .object({
    successUrl: ReturnUrl.describe(
      "Where hosted checkout returns a buyer who paid. Unlike Stripe there is no session token to substitute — a Lemon Squeezy purchase is only ever heard about through its webhook, so this page shows a pending state rather than posting a receipt.",
    ),
    storeCurrency: z
      .string()
      .regex(CURRENCY_CODE_PATTERN, "A currency code is lowercase, digits, and dashes.")
      .optional()
      .describe(
        "The currency this Lemon Squeezy store sells in, lowercase ISO 4217 — `usd`. Optional, and the only thing it does is let a fixed-amount discount in another currency be refused when it is created rather than when a customer redeems it. Lemon Squeezy accepts the mismatched object and fails at redemption, so without this the error arrives at the buyer instead of at you.",
      ),
  })
  .describe(
    "Where Lemon Squeezy's hosted checkout sends a browser back to. Config, not request input: a client that could name a return URL could send a paying customer to a page it controls. Build it on `PUBLIC_ORIGIN` and never on a literal. One URL, where Stripe takes three, and both absences are the store's rather than an omission here: Lemon Squeezy's checkout has no cancel destination — a buyer who backs out closes the tab or uses the back button — and its customer portal is a signed, expiring link with nowhere to return to.",
  );
export type PaymentsLemonSqueezySettings = z.infer<typeof PaymentsLemonSqueezySettings>;

export const PaymentsPaddleProduct = z
  .object({
    priceId: z
      .string()
      .min(1)
      .max(MAX_SKU_LENGTH)
      .describe(
        "The Paddle Price id — `pri_01hv8w…`. Publishable by design: it is what a transaction and `Paddle.Checkout.open` both name, so it may reach a browser.",
      ),
  })
  .describe("How this product is priced in Paddle. Omit the block to ship without the Paddle rail.");
export type PaymentsPaddleProduct = z.infer<typeof PaymentsPaddleProduct>;

export const PaymentsPaddleSettings = z
  .strictObject({
    checkout: z
      .enum(["overlay", "inline", "hosted"])
      .default("overlay")
      .describe(
        "How checkout is presented. `overlay` opens Paddle.js over your own page; `inline` renders it in a container the screen provides; `hosted` redirects to Paddle's own page and **requires a default payment link set in the Paddle dashboard** — without one Paddle refuses to create the transaction at all, account-wide, so `pithy doctor` asks before a buyer finds out.",
      ),
    clientToken: z
      .string()
      .min(1)
      .describe(
        "Paddle's publishable client token — `live_…` or `test_…`. Config and not a secret, the same call `stripe.priceId` gets and for the same reason: it is designed to reach a browser, and putting it behind the secrets store would suggest verification depended on its secrecy. The API key and the webhook signing secret are secrets and are not here.",
      ),
    environment: z
      .enum(["sandbox", "production"])
      .describe(
        "Which Paddle account this project sells through. Paddle Billing partitions sandbox from live by account — separate host, separate key, separate notification destinations — so this decides both the API host and every purchase's recorded environment. There is no `mode` field on a Paddle payload that could contradict it.",
      ),
    successUrl: ReturnUrl.describe(
      "Where a buyer lands after paying. Used as `settings.successUrl` for Paddle.js and as the redirect target in `hosted` mode. Build it on `PUBLIC_ORIGIN`, never on a literal.",
    ),
    cancelUrl: ReturnUrl.optional().describe(
      "Where a buyer who backs out lands, in `hosted` mode. Optional, because an overlay a buyer closes leaves them exactly where they were.",
    ),
    // The ceiling is deliberately **not** a `.max()` here, and the reason is blast radius rather than
    // taste. This schema is parsed at module scope — `payments()` calls `PaymentsConfig.parse` — so a
    // refusal on this one field takes the whole Worker down: every route, including the ones that have
    // never heard of Paddle. A project that had legitimately set a wider window would have discovered
    // that on a patch upgrade, as a dead deployment rather than a dead endpoint. The window is enforced
    // where it is used instead, in `verifyPaddleSignature`, which is on the only path that compares it
    // and cannot be reached around; a bad number there costs the Paddle webhook route and nothing else,
    // and Paddle keeps redelivering while it is fixed. Fail closed, for one route.
    webhookFreshnessSeconds: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        `How many seconds either side of now a delivery's \`ts\` may be dated. Omitted uses 300, deliberately not the 5 Paddle's own SDKs use: replay protection here is the webhook table's \`UNIQUE (rail, providerEventId)\`, which is absolute, and a five-second window adds nothing to that while turning ordinary clock skew into a dropped renewal. Bounded at ${SIGNED_WEBHOOK_MAX_TOLERANCE_SECONDS} because a freshness window is a replay window: every second of it is a second longer a captured delivery keeps working. That bound is enforced by the verifier rather than by this schema, so a number past it refuses the Paddle webhook route with \`core/internal\` naming this key, instead of refusing to boot the Worker.`,
      ),
    storeCurrency: z
      .string()
      .regex(CURRENCY_CODE_PATTERN, "A currency code is lowercase, digits, and dashes.")
      .optional()
      .describe(
        "The currency this Paddle catalog prices in, lowercase ISO 4217 — `usd`. Optional, and the only thing it does is let a fixed-amount discount in another currency be refused when it is created rather than when a customer redeems it. Paddle accepts the mismatched object and fails at redemption, so without this the error arrives at the buyer instead of at you.",
      ),
  })
  .describe(
    "How this project sells through Paddle. `strictObject`, and that is what refuses `portalReturnUrl`: Paddle's customer portal takes no return parameter, so accepting one and dropping it would leave a URL an adopter wrote and believed in that nothing ever reads — a lie in a file they trust.",
  );
export type PaymentsPaddleSettings = z.infer<typeof PaymentsPaddleSettings>;
export type PaymentsPaddleSettingsInput = z.input<typeof PaymentsPaddleSettings>;

export const PaymentsStripeSettings = z
  .object({
    successUrl: ReturnUrl.describe(
      "Where hosted Checkout returns a buyer who paid. Put `{CHECKOUT_SESSION_ID}` in the query and Stripe fills it in, so the page can post it to /payments/purchases and show the entitlement at once instead of waiting for the webhook.",
    ),
    cancelUrl: ReturnUrl.describe("Where hosted Checkout returns a buyer who backed out. Usually the paywall."),
    portalReturnUrl: ReturnUrl.describe("Where the Billing Portal returns a subscriber who is done managing."),
  })
  .describe(
    "Where Stripe's hosted pages send a browser back to. Config, not request input: a client that could name a return URL could send a paying customer to a page it controls. Build all three on `PUBLIC_ORIGIN` — the constant the scaffolded pithy.config.ts derives from `domains` — and never on a literal: an origin written down is production's origin written into staging, which lands a staging payer in production on an account that has bought nothing (#256).",
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

/**
 * The rails a reported quantity can be billed on. Stripe takes a meter event; Paddle takes a one-time charge
 * against the subscription. **Apple and Google cannot**: in-app purchase has no concept of a seat, so a
 * quantity-billed product is web-rails-only and says so at boot.
 *
 * **Lemon Squeezy is deferred, with the reason recorded on pithy-sh/pithy#561.** Its usage records are
 * written against a subscription *item*, which the projection does not store, so the same call shape does
 * not fit without a new column and a refresh of every Lemon Squeezy subscription. Named here so the refusal
 * can say so, rather than reading as an oversight.
 */
export const REPORTED_BILLING_RAILS = ["stripe", "paddle"] as const satisfies readonly PaymentsRail[];

/** How often a reported quantity goes to the store. */
export const PaymentsReportCadence = z
  .enum(["period-end", "daily-peak"])
  .describe(
    "How often the count is reported. `period-end` sends one count per subscription per billing period — simplest, and what a store's metering expects to be fed. `daily-peak` samples every run and keeps each day's high-water mark, then sends the period's highest day once, in its last day — the period's peak, never the sum of its days. The day rows stay as the audit a customer disputing an invoice can check.",
  );
export type PaymentsReportCadence = z.infer<typeof PaymentsReportCadence>;

export const PaymentsReportedBilling = z
  .strictObject({
    kind: z
      .literal("reported")
      .describe(
        "The quantity is reported by payments, from a count the adopter's `resolveQuantity` computes. The only kind there is.",
      ),
    unit: z
      .string()
      .min(1)
      .max(MAX_NAME_LENGTH)
      .describe("What one unit is — `student`, `coach`, `seat`. For people reading the catalog and the run log."),
    cadence: PaymentsReportCadence.default("period-end").describe(
      "How often the count is reported. Defaults to `period-end`. Per product, because a project can sell two things metered differently.",
    ),
    min: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        "The smallest count that may be reported. A resolver answering below it is skipped and logged — never clamped, because a clamped value is a wrong number billed silently.",
      ),
    max: z
      .number()
      .int()
      .positive()
      .describe(
        "The largest count that may be reported. A resolver answering above it is skipped and logged — never clamped. A value that becomes money is bounded by somebody who meant it.",
      ),
    rails: z
      .array(PaymentsRail)
      .min(1)
      .describe(
        "Which rails report this product's count. Stripe and Paddle only — in-app purchase has no seats, and Lemon Squeezy is deferred.",
      ),
    stripe: z
      .strictObject({
        meterEventName: z
          .string()
          .min(1)
          .max(100)
          .describe(
            "The `event_name` of the Stripe Billing Meter this product's metered price reads — what each report is sent as.",
          ),
      })
      .optional()
      .describe("How Stripe hears the count: the meter it is reported to. Required when `rails` lists stripe."),
    paddle: z
      .strictObject({
        priceId: z
          .string()
          .min(1)
          .max(MAX_SKU_LENGTH)
          .describe(
            "The one-time Paddle price charged per unit — `pri_01…`. Each report is a one-time charge of this price, at the reported quantity, on the subscription's next bill.",
          ),
      })
      .optional()
      .describe("How Paddle hears the count: the one-time price it is charged at. Required when `rails` lists paddle."),
  })
  .describe(
    "Bill by a count the adopter's code owns. Payments asks `resolveQuantity` and reports the answer to the store; it never counts anybody's members itself, and never reports a number a kit meter counted.",
  );
export type PaymentsReportedBilling = z.output<typeof PaymentsReportedBilling>;

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
        "The entitlement keys this product grants — mentioned here, declared in the top-level `entitlements` map. Many products across many rails may grant one key, which is the whole point — gating code names the key, never this product. Every key must be declared. Empty for a product that only credits a balance.",
      ),
    apple: PaymentsAppleProduct.optional().describe("The Apple listing, if this product ships on the App Store."),
    google: PaymentsGoogleProduct.optional().describe("The Google listing, if this product ships on Google Play."),
    stripe: PaymentsStripeProduct.optional().describe("The Stripe price, if this product is sold through Stripe."),
    lemonSqueezy: PaymentsLemonSqueezyProduct.optional().describe(
      "The Lemon Squeezy variant, if this product is sold through Lemon Squeezy.",
    ),
    paddle: PaymentsPaddleProduct.optional().describe("The Paddle price, if this product is sold through Paddle."),
    grants: PaymentsGrants.optional().describe(
      "What this purchase fulfills beyond its entitlements. Opt-in per product; a subscription's grant fires once per billing period, since each renewal is a distinct provider transaction.",
    ),
    billing: PaymentsReportedBilling.optional().describe(
      "Bill this subscription by a reported quantity — students, coaches, seats — rather than a flat price. Requires `resolveQuantity` on `payments(...)`. Omit for a flat-priced product.",
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

/**
 * The meters the kit counts itself, because the kit writes the rows they count. Everything the kit cannot
 * see — seats, students, projects — is the adopter's count, read through `quota()`. Payments never counts
 * members. Forever.
 */
export const KIT_METERS = ["emails", "storageBytes", "mediaItems"] as const;
export type KitMeter = (typeof KIT_METERS)[number];

const MeterPolicy = z
  .strictObject({
    enforce: z
      .boolean()
      .default(false)
      .describe(
        "Whether the quota of the same name binds. Off by default: declaring a quota makes it readable, and turning this on makes it refuse. Two steps, because the first is a pricing decision and the second is a production one.",
      ),
  })
  .describe("Whether one kit meter is enforced.");

export const PaymentsMeters = z
  .strictObject({
    emails: MeterPolicy.optional().describe(
      "Emails enqueued through `@pithy-sh/email` for a subject, per billing period. Enforced at enqueue: past the quota the enqueue throws `payments/quota_exceeded` and writes no job.",
    ),
    storageBytes: MeterPolicy.optional().describe(
      "Bytes the billing subject holds in `@pithy-sh/storage`: a user's own, or under organization billing every member's bytes stored for the organization. Enforced, the quota replaces the configured `bytesPerOwner` as the ceiling, and a write past it throws `payments/quota_exceeded`.",
    ),
    mediaItems: MeterPolicy.optional().describe(
      "Media items the billing subject holds in `@pithy-sh/media`: a user's own, or under organization billing every member's records for the organization. Enforced at create: past the quota the create throws `payments/quota_exceeded`.",
    ),
  })
  .describe(
    "Which kit meters enforce their quota. Every meter is advisory until named here with `enforce: true`, because a cap that arrives by surprise breaks an adopter already over it. A meter refuses at its limit and never bills.",
  );
export type PaymentsMeters = z.output<typeof PaymentsMeters>;

export const PaymentsConfig = z
  .object({
    billingSubject: PaymentsSubjectType.describe(
      "Who a purchase belongs to, and who its entitlements reach. `user` is one person buying for themselves: they pay, they are entitled, nobody else is. `organization` is a company buying for its people: the company is invoiced, and everybody the adopter counts as a member holds what it bought — so a colleague who joined this morning is entitled and one who left this afternoon is not, with no row rewritten either time. Required, and decided once for the project: a codebase that could grant to a user on one route and an organization on the next eventually disagrees with itself about who is entitled, and the disagreement surfaces as somebody being refused what they paid for. Changing it later is a migration of every entitlement, purchase, and store link, so it is worth the minute now.",
    ),
    rails: PaymentsRailToggles.default({
      apple: false,
      google: false,
      stripe: false,
      lemonSqueezy: false,
      paddle: false,
    }).describe("Which stores this project sells through. Every rail is off until named."),
    products: z
      .record(z.string(), PaymentsProduct)
      .default({})
      .describe(
        "The catalog, keyed by logical product id — the id that lands in every purchase row. Keys are yours and outlive any store's SKU, so renaming a SKU in a console never rewrites history.",
      ),
    entitlements: z
      .record(EntitlementKey, PaymentsEntitlementDeclaration)
      .default({})
      .describe(
        "What each entitlement key means — its display name, its numbered `quotas`, its `features` — declared once, however many products sell it. A key a product mentions must be declared here. A key declared here and sold by no product is comp-only: the control plane may grant it and no checkout sells it.",
      ),
    defaults: PaymentsAllowanceDefaults.optional().describe(
      "The free floor: the quotas and features a caller holding no key gets. Optional. Without it an unentitled caller gets 0 of every quota and no feature, which is fail-closed and correct.",
    ),
    meters: PaymentsMeters.default({}).describe(
      "Which kit meters — `emails`, `storageBytes`, `mediaItems` — enforce the quota of the same name. All advisory until named.",
    ),
    manualEntitlements: z
      .never({
        error:
          "`manualEntitlements` is gone. Declare each comp-only key in the top-level `entitlements` map instead — a key declared there and sold by no product is grantable by hand.",
      })
      .optional()
      .describe(
        "Removed. Declare each comp-only key in `entitlements` instead: a declared key no product sells is what this field used to mean. Refused rather than ignored, because ignoring it would drop a comp-only key and nobody would see it.",
      ),
    stripe: PaymentsStripeSettings.optional().describe(
      "Where Stripe's hosted Checkout and Billing Portal return the browser. Required when the Stripe rail is on — the two routes cannot create a session without them.",
    ),
    lemonSqueezy: PaymentsLemonSqueezySettings.optional().describe(
      "Where Lemon Squeezy's hosted checkout returns the browser. Required when that rail is on — the checkout route cannot create a session without it.",
    ),
    paddle: PaymentsPaddleSettings.optional().describe(
      "How this project sells through Paddle: the account, the publishable client token, the checkout mode, and where a buyer lands. Required when the Paddle rail is on — the rail cannot initialize Paddle.js or create a transaction without it.",
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

    // The same pair for Lemon Squeezy, and for the same reason. Only two URLs, not three: that rail's
    // customer portal is a signed expiring link with nowhere to return to.
    if (config.rails.lemonSqueezy && config.lemonSqueezy === undefined) {
      ctx.issues.push({
        code: "custom",
        input: ctx.value,
        path: ["lemonSqueezy"],
        message:
          "The Lemon Squeezy rail is on, so `lemonSqueezy` must declare a `successUrl`. Hosted checkout has nowhere to return a browser without it.",
      });
    }

    if (!config.rails.lemonSqueezy && config.lemonSqueezy !== undefined) {
      ctx.issues.push({
        code: "custom",
        input: ctx.value,
        path: ["lemonSqueezy"],
        message:
          "`lemonSqueezy` declares a return URL, but `rails.lemonSqueezy` is off. Enable the rail, or drop the block.",
      });
    }

    // The same pair for Paddle. The client token and the account are not return URLs — they are what a
    // browser needs to open a checkout at all — so the rail cannot start one without this block either.
    if (config.rails.paddle && config.paddle === undefined) {
      ctx.issues.push({
        code: "custom",
        input: ctx.value,
        path: ["paddle"],
        message:
          "The Paddle rail is on, so `paddle` must declare `clientToken`, `environment`, and `successUrl`. Paddle.js cannot initialize and no transaction can be created without them.",
      });
    }

    if (!config.rails.paddle && config.paddle !== undefined) {
      ctx.issues.push({
        code: "custom",
        input: ctx.value,
        path: ["paddle"],
        message: "`paddle` declares settings, but `rails.paddle` is off. Enable the rail, or drop the block.",
      });
    }

    // A key is declared once and mentioned by products. A mention with no declaration is a key whose
    // quotas, features and name exist nowhere, and a comp of it would be refused while a checkout sold it.
    for (const [id, product] of entries) {
      for (const key of product.entitlements) {
        if (key in config.entitlements) continue;
        ctx.issues.push({
          code: "custom",
          input: ctx.value,
          path: ["products", id, "entitlements"],
          message: `Product "${id}" grants "${key}", which \`entitlements\` does not declare. Declare it — \`entitlements: { ${key}: { name: "…" } }\` — or correct the product.`,
        });
      }
    }

    for (const problem of declarationProblems(config)) {
      ctx.issues.push({ code: "custom", input: ctx.value, path: problem.path, message: problem.message });
    }

    // An enforced meter with no quota of its name would resolve every subject to the hard floor of zero and
    // refuse every send. That is fail-closed and it is also an outage, caught here rather than in production.
    const quotaNames = new Set(declaredQuotaNames(config));
    for (const meter of KIT_METERS) {
      if (config.meters[meter]?.enforce !== true || quotaNames.has(meter)) continue;
      ctx.issues.push({
        code: "custom",
        input: ctx.value,
        path: ["meters", meter],
        message: `The ${meter} meter is enforced, and no quota named "${meter}" is declared. Declare one on an entitlement or in \`defaults\`, or leave the meter advisory — enforced with nothing declared, it would refuse everyone.`,
      });
    }

    for (const [id, product] of entries) {
      for (const problem of reportedBillingProblems(id, product, config)) {
        ctx.issues.push({ code: "custom", input: ctx.value, path: problem.path, message: problem.message });
      }
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
          message: `Product "${id}" declares no rail. Give it an \`apple\`, \`google\`, \`stripe\`, \`lemonSqueezy\`, or \`paddle\` block — nothing could buy it otherwise.`,
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
 * The catalog's pieces as *written*, beside the whole config as written.
 *
 * A catalog assembled in TypeScript — products built from a map of price ids, which is what makes the
 * ids swappable per environment — needs a name for each piece it builds. The output types are the
 * wrong ones: they are what `PaymentsConfig.parse()` returns, with every default already filled in, so
 * typing an unparsed product with `PaymentsProduct` demands `entitlements` and `clawback` back from the
 * author. The alternative was leaving adopters to write `z.input<typeof PaymentsProduct>` themselves,
 * which works and makes the schema's internals part of the surface anyway.
 *
 * `PaymentsStripeSettings` defaults nothing today, so its input and output coincide. It is exported all
 * the same: the three pieces a catalog is assembled from should be nameable as a set, and a default
 * added later then shifts nothing.
 */
export type PaymentsProductInput = z.input<typeof PaymentsProduct>;
export type PaymentsRailTogglesInput = z.input<typeof PaymentsRailToggles>;
export type PaymentsStripeSettingsInput = z.input<typeof PaymentsStripeSettings>;

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
  switch (rail) {
    case "stripe":
      return product.stripe?.priceId;
    case "lemonSqueezy":
      return product.lemonSqueezy?.variantId;
    case "paddle":
      return product.paddle?.priceId;
    case "apple":
      return product.apple?.productId;
    case "google":
      return product.google?.productId;
  }
}

/**
 * What is wrong with one product's reported billing, as sentences naming the product — empty for a product
 * that has none, or one that is sound.
 *
 * Every refusal here is at boot, because a reported product that cannot be reported is a subscription that
 * bills nothing for a quantity the customer is using — invisible until somebody reads an invoice.
 */
export function reportedBillingProblems(
  id: string,
  product: PaymentsProduct,
  config: Pick<PaymentsConfig, "rails">,
): DeclarationProblem[] {
  const billing = product.billing;
  if (billing === undefined) return [];
  const problems: DeclarationProblem[] = [];
  const at = (...rest: (string | number)[]) => ["products", id, "billing", ...rest];

  if (product.type !== "subscription") {
    problems.push({
      path: at(),
      message: `Product "${id}" reports a quantity and is a ${product.type}. A reported quantity is billed per period, so only a subscription can carry one.`,
    });
  }
  if (billing.min > billing.max) {
    problems.push({
      path: at("min"),
      message: `Product "${id}" reports between ${billing.min} and ${billing.max}. The minimum must not exceed the maximum.`,
    });
  }
  for (const rail of billing.rails) {
    if (rail === "apple" || rail === "google") {
      problems.push({
        path: at("rails"),
        message: `Product "${id}" reports its quantity on ${rail}. In-app purchase has no concept of a seat, so a quantity-billed product sells on the web rails only. Remove ${rail} from \`billing.rails\`.`,
      });
      continue;
    }
    if (rail === "lemonSqueezy") {
      problems.push({
        path: at("rails"),
        message: `Product "${id}" reports its quantity on lemonSqueezy, which payments does not report to yet: its usage records are written against a subscription item the projection does not store. Report on stripe or paddle.`,
      });
      continue;
    }
    if (!config.rails[rail] || product[rail] === undefined) {
      problems.push({
        path: at("rails"),
        message: `Product "${id}" reports its quantity on ${rail}, and is not sold there. Enable \`rails.${rail}\` and give the product a \`${rail}\` block, or remove ${rail} from \`billing.rails\`.`,
      });
    }
  }
  if (billing.rails.includes("stripe") && billing.stripe === undefined) {
    problems.push({
      path: at("stripe"),
      message: `Product "${id}" reports its quantity on stripe and names no meter. Set \`billing.stripe.meterEventName\` to the event name of the meter its price reads.`,
    });
  }
  if (billing.rails.includes("paddle") && billing.paddle === undefined) {
    problems.push({
      path: at("paddle"),
      message: `Product "${id}" reports its quantity on paddle and names no price to charge it at. Set \`billing.paddle.priceId\` to a one-time price.`,
    });
  }
  return problems;
}

/** Every product billed by a reported quantity, with its id. */
export function reportedProducts(
  config: PaymentsConfig,
): (PaymentsCatalogEntry & { billing: PaymentsReportedBilling })[] {
  return Object.entries(config.products).flatMap(([id, product]) =>
    product.billing === undefined ? [] : [{ id, product, billing: product.billing }],
  );
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

/**
 * Every entitlement key this project defines — the keys `entitlements` declares. Every key a product
 * mentions is among them, because the config refuses a mention with no declaration.
 *
 * The set a manual grant is checked against, and the set the control-plane catalog read publishes.
 * Computed once per composition: the catalog is config, so it cannot change under a running Worker.
 *
 * **Empty is a real answer.** A project composing payments with nothing declared defines no keys, and every
 * grant against it is refused — which is correct, because there is no vocabulary to grant in. It is the same
 * statement `clientProjection` makes as `{ enabled: false }`.
 */
export function grantableEntitlements(config: PaymentsConfig): ReadonlySet<string> {
  return new Set<string>(Object.keys(config.entitlements));
}

/**
 * The declared keys no product sells — comp-only. Granted by hand through the control plane, sold by no
 * checkout. What `manualEntitlements` used to list, said by the shape of the config rather than by a
 * second list that could disagree with the first.
 */
export function compOnlyEntitlements(config: PaymentsConfig): string[] {
  const sold = new Set<string>();
  for (const product of Object.values(config.products)) for (const key of product.entitlements) sold.add(key);
  return Object.keys(config.entitlements).filter((key) => !sold.has(key));
}

/** The entitlement keys a product grants, or an empty list for an unknown product or one that grants none. */
export function entitlementsForProduct(config: PaymentsConfig, id: string): readonly string[] {
  return config.products[id]?.entitlements ?? [];
}

/** Whether a rail is enabled for this project. A disabled rail refuses its routes and its webhook. */
export function railEnabled(config: PaymentsConfig, rail: PaymentsRail): boolean {
  return config.rails[rail];
}
