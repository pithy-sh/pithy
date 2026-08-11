// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { EXAMPLE_ADA, EXAMPLE_ALAN, EXAMPLE_GRACE } from "@pithy-sh/core/src/seed/exampleIdentities";
import { d1SeedGroup, defineSeed, type SeedSet } from "@pithy-sh/core/src/seed/seed";
import { PaymentsEntitlement } from "../data/entitlement";
import { PaymentsPurchase } from "../data/purchase";
import { PAYMENTS_ENTITLEMENTS_TABLE, PAYMENTS_PURCHASES_TABLE } from "../data/tables";

/**
 * Three purchases and the entitlements they derive, for the canonical example cast.
 *
 * The set is spread deliberately rather than repeated: **Ada** holds a live Apple subscription, **Grace**
 * a Stripe non-consumable she owns forever, **Alan** a refunded Google consumable. That is one row per
 * rail, one per product type, and the three purchase states anything reading this table has to handle —
 * so a fresh `dev` backend can render a real subscription screen, a real receipt, and a real refund
 * without anybody authoring a fixture first.
 *
 * The users are the shared cast from `@pithy-sh/core`, so these purchases belong to the same people
 * `auth` seeds and `ledger` opens balances for. Order 250 puts them after auth's users (100), exactly the
 * way the migration registry encodes a dependency.
 *
 * **Everything is fixed — the ids and the clock.** `pithy seed` is `INSERT OR IGNORE`, so a generated
 * UUID would give Ada a second subscription on every run. A fixed `CREATED_AT` does the same job for the
 * timestamps.
 *
 * **No payloads worth the name.** The `payload` column really holds a verified provider response, and a
 * real one is a bearer artifact. A committed fixture gets an identifier and nothing else.
 *
 * Composed in only when the project turns on `seed.includeExamples`, and only for `dev` and `staging` —
 * an example fixture never targets production, whatever that setting says.
 */

/** Where this set sorts in the whole project's seed registry. After auth (100), which owns these users. */
const PAYMENTS_EXAMPLE_SEED_ORDER = 250;

/** Fixed ids, so the fixture is idempotent and an entitlement's provenance cannot drift off its purchase. */
const PRO_PURCHASE_ID = "b4e1f2a0-6c3d-4f18-9a52-1d7e8c0b3f41";
const ADS_PURCHASE_ID = "c5f2a3b1-7d4e-4a29-8b63-2e8f9d1c4a52";
const COINS_PURCHASE_ID = "d6a3b4c2-8e5f-4b3a-9c74-3f9a0e2d5b63";

const PRO_ENTITLEMENT_ID = "e7b4c5d3-9f60-4c4b-8d85-4a0b1f3e6c74";
const ADS_ENTITLEMENT_ID = "f8c5d6e4-a071-4d5c-9e96-5b1c2a4f7d85";

/** One fixed moment every row was written at. The demo is about state, not about a calendar. */
const CREATED_AT = new Date("2026-01-01T00:00:00.000Z");

/**
 * When Ada's subscription runs to.
 *
 * Deliberately far out rather than `now + 30 days`. A computed date would make the fixture depend on when
 * it ran, which breaks the one property that matters — that re-seeding writes identical rows — and the
 * read path evaluates `expiresAt` on every request, so a date in the past would quietly turn the live
 * subscription into a lapsed one the day after somebody seeded it.
 */
const RENEWS_AT = new Date("2099-01-01T00:00:00.000Z");

/** When Alan asked for his money back. */
const REFUNDED_AT = new Date("2026-01-08T00:00:00.000Z");

export const paymentsExampleSeed: SeedSet = defineSeed({
  name: "example",
  order: PAYMENTS_EXAMPLE_SEED_ORDER,
  environments: ["dev", "staging"],
  example: true,
  d1: [
    d1SeedGroup("app", PAYMENTS_PURCHASES_TABLE, PaymentsPurchase, [
      {
        id: PRO_PURCHASE_ID,
        userId: EXAMPLE_ADA.id,
        rail: "apple",
        role: "charge",
        providerTransactionId: "2000000512345678",
        productId: "pro_monthly",
        providerProductId: "com.example.pro.monthly",
        type: "subscription",
        status: "active",
        // Sandbox, because a seeded environment is dev or staging and a purchase carries where it happened.
        environment: "sandbox",
        purchasedAt: CREATED_AT,
        expiresAt: RENEWS_AT,
        revokedAt: null,
        // A renewal chains back to the transaction that started the subscription; this is that one.
        originalTransactionId: "2000000512345678",
        amountMinor: 999,
        currency: "USD",
        providerEventAt: CREATED_AT,
        payload: { transactionId: "2000000512345678", type: "Auto-Renewable Subscription" },
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
      },
      {
        id: ADS_PURCHASE_ID,
        userId: EXAMPLE_GRACE.id,
        rail: "stripe",
        role: "charge",
        providerTransactionId: "pi_3ExampleRemoveAds",
        productId: "remove_ads",
        providerProductId: "price_example_remove_ads",
        type: "non_consumable",
        status: "active",
        environment: "sandbox",
        purchasedAt: CREATED_AT,
        // Owned forever. Null is what makes the read path stop checking a clock for this one.
        expiresAt: null,
        revokedAt: null,
        originalTransactionId: null,
        amountMinor: 299,
        currency: "USD",
        providerEventAt: CREATED_AT,
        payload: { id: "pi_3ExampleRemoveAds", object: "payment_intent" },
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
      },
      {
        id: COINS_PURCHASE_ID,
        userId: EXAMPLE_ALAN.id,
        rail: "google",
        role: "charge",
        providerTransactionId: "GPA.3300-0000-0000-00000",
        productId: "coins_100",
        providerProductId: "coins_100",
        type: "consumable",
        status: "refunded",
        environment: "sandbox",
        purchasedAt: CREATED_AT,
        expiresAt: null,
        revokedAt: REFUNDED_AT,
        originalTransactionId: null,
        amountMinor: 199,
        currency: "USD",
        providerEventAt: REFUNDED_AT,
        payload: { orderId: "GPA.3300-0000-0000-00000", purchaseState: 0 },
        createdAt: CREATED_AT,
        updatedAt: REFUNDED_AT,
      },
    ]),
    d1SeedGroup("app", PAYMENTS_ENTITLEMENTS_TABLE, PaymentsEntitlement, [
      {
        id: PRO_ENTITLEMENT_ID,
        userId: EXAMPLE_ADA.id,
        entitlement: "pro",
        active: true,
        expiresAt: RENEWS_AT,
        sourcePurchaseId: PRO_PURCHASE_ID,
        manual: false,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
      },
      {
        id: ADS_ENTITLEMENT_ID,
        userId: EXAMPLE_GRACE.id,
        entitlement: "ads_removed",
        active: true,
        expiresAt: null,
        sourcePurchaseId: ADS_PURCHASE_ID,
        manual: false,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
      },
      // Alan gets no row, and that is the derivation rather than an omission: a consumable credits a
      // balance, so a refunded one leaves nothing in the read model to take away.
    ]),
  ],
});
