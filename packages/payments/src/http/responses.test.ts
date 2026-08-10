// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import type { z } from "zod";
import type { PaymentsEntitlement } from "../data/entitlement";
import {
  PaymentsAdminEntitlementsResponse,
  PaymentsAdminEntitlementView,
  PaymentsAdminPurchasesResponse,
  PaymentsAdminPurchaseView,
  PaymentsAdminSubscriptionsResponse,
  PaymentsAdminUserEntitlementsResponse,
  PaymentsEntitlementResponse,
  PaymentsEntitlementsResponse,
  PaymentsEntitlementView,
  PaymentsHostedSessionResponse,
  PaymentsPurchaseResponse,
  PaymentsPurchaseView,
  PaymentsRestoreResponse,
} from "./responses";
import { adminEntitlementView, adminPurchaseView } from "./view";

/**
 * The response schemas against the shapes the handlers build.
 *
 * **Equality, not `.parse()` alone.** A Zod object strips unknown keys, so a bare parse passes a
 * response that has grown a field the schema never heard of. Comparing the parsed value with the
 * input fails in both directions, which is what makes the two unable to drift silently.
 *
 * The live binding — that these are what the routes actually emit — is in `routes.workers.test.ts`,
 * where each response is parsed against its schema after a real request.
 */
function accepts<T>(schema: z.ZodType<T>, value: unknown): void {
  expect(schema.parse(value)).toEqual(value);
}

const PURCHASE: PaymentsPurchaseView = {
  id: "9c1f9b9e-6a2a-4c9d-8f1b-2b7c7d4c1a01",
  rail: "apple",
  productId: "pro_monthly",
  type: "subscription",
  status: "active",
  environment: "production",
  purchasedAt: "2026-06-01T00:00:00.000Z",
  expiresAt: "2026-07-01T00:00:00.000Z",
  outcome: "created",
};

const ENTITLEMENT: PaymentsEntitlementView = {
  key: "pro",
  granted: true,
  expiresAt: "2026-07-01T00:00:00.000Z",
};

describe("payments response schemas", () => {
  test("the views accept what the projections build", () => {
    accepts(PaymentsPurchaseView, PURCHASE);
    accepts(PaymentsPurchaseView, { ...PURCHASE, expiresAt: null, outcome: "ignored" });
    accepts(PaymentsEntitlementView, ENTITLEMENT);
    accepts(PaymentsEntitlementView, { ...ENTITLEMENT, granted: false, expiresAt: null });
  });

  test("no receipt is declared on the purchase view", () => {
    // The stored `payload` is the whole verified provider response and a bearer artifact. A client has
    // no use for its own receipt read back to it, and the schema must not say otherwise.
    expect(Object.keys(PaymentsPurchaseView.shape)).not.toContain("payload");
    expect(Object.keys(PaymentsPurchaseView.shape)).not.toContain("providerTransactionId");
    expect(Object.keys(PaymentsPurchaseView.shape)).not.toContain("userId");
  });

  test("the envelopes accept what the routes return", () => {
    accepts(PaymentsPurchaseResponse, { purchase: PURCHASE, entitlements: [ENTITLEMENT] });
    accepts(PaymentsEntitlementsResponse, { entitlements: [] });
    accepts(PaymentsRestoreResponse, { purchases: [PURCHASE], entitlements: [ENTITLEMENT] });
    accepts(PaymentsHostedSessionResponse, { url: "https://checkout.stripe.com/c/pay/cs_test_1" });
    accepts(PaymentsEntitlementResponse, { entitlement: ENTITLEMENT });
    // A revoke returns the state it produced rather than nothing, so the false case is part of the
    // contract and not an afterthought.
    accepts(PaymentsEntitlementResponse, { entitlement: { key: "pro", granted: false, expiresAt: null } });
  });
});

describe("the management read schemas", () => {
  test("the admin views accept exactly what the projections build", () => {
    // Built by the projections rather than typed by hand, so this fails if `view.ts` and `responses.ts`
    // ever describe different objects — which is the drift the schemas exist to make impossible.
    const purchase = adminPurchaseView({
      id: "9c1f9b9e-6a2a-4c9d-8f1b-2b7c7d4c1a01",
      userId: "ada",
      rail: "apple",
      providerTransactionId: "2000000123",
      originalTransactionId: "2000000001",
      productId: "pro_monthly",
      type: "subscription",
      status: "active",
      environment: "production",
      amountMinor: 999,
      currency: "USD",
      purchasedAt: new Date("2026-06-01T00:00:00.000Z"),
      expiresAt: new Date("2026-07-01T00:00:00.000Z"),
      revokedAt: null,
      updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    });
    accepts(PaymentsAdminPurchaseView, purchase);

    const row: PaymentsEntitlement = {
      id: "8c1f9b9e-6a2a-4c9d-8f1b-2b7c7d4c1a02",
      userId: "ada",
      entitlement: "pro",
      active: true,
      expiresAt: new Date("2026-07-01T00:00:00.000Z"),
      sourcePurchaseId: "9c1f9b9e-6a2a-4c9d-8f1b-2b7c7d4c1a01",
      manual: false,
      createdAt: new Date("2026-06-01T00:00:00.000Z"),
      updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    };
    accepts(PaymentsAdminEntitlementView, adminEntitlementView(row, new Date("2026-06-10T00:00:00.000Z")));
    // Past its expiry: the flag still says active, and the projection still says it does not grant.
    expect(adminEntitlementView(row, new Date("2026-08-01T00:00:00.000Z")).granted).toBe(false);
  });

  test("no management projection carries the stored provider payload, or the row's surrogate keys", () => {
    // The one column that is a bearer artifact, and on Stripe a document carrying the buyer's email
    // address. It is not selected by the queries either — this is the schema half of that guarantee.
    const fields = Object.keys(PaymentsAdminPurchaseView.shape);
    expect(fields).not.toContain("payload");
    expect(fields).not.toContain("providerProductId");
    // `outcome` describes what a write did. A read of the log has no write to report, and a client that
    // could read one would come to depend on a field with no meaning here.
    expect(fields).not.toContain("outcome");
    // The entitlement row's own uuid is internal: an entitlement is addressed by `(userId, key)`.
    expect(Object.keys(PaymentsAdminEntitlementView.shape)).not.toContain("id");
  });

  test("the management envelopes accept what the handlers return", () => {
    const purchase: PaymentsAdminPurchaseView = {
      id: "9c1f9b9e-6a2a-4c9d-8f1b-2b7c7d4c1a01",
      userId: "ada",
      rail: "stripe",
      providerTransactionId: "pi_1Abc",
      originalTransactionId: null,
      productId: "coins_100",
      type: "consumable",
      status: "active",
      environment: "production",
      amountMinor: null,
      currency: null,
      purchasedAt: "2026-06-01T00:00:00.000Z",
      expiresAt: null,
      revokedAt: null,
      updatedAt: "2026-06-01T00:00:00.000Z",
    };
    const entitlement: PaymentsAdminEntitlementView = {
      userId: "ada",
      key: "pro",
      granted: true,
      expiresAt: null,
      manual: true,
      source: null,
    };
    accepts(PaymentsAdminPurchasesResponse, { purchases: [purchase], nextCursor: null });
    accepts(PaymentsAdminPurchasesResponse, { purchases: [], nextCursor: "eyJzb3J0IjoxfQ" });
    accepts(PaymentsAdminSubscriptionsResponse, { subscriptions: [purchase], nextCursor: null });
    accepts(PaymentsAdminEntitlementsResponse, { entitlements: [entitlement], nextCursor: null });
    // No cursor on the per-account read: `UNIQUE (userId, entitlement)` bounds it, so there is no page.
    accepts(PaymentsAdminUserEntitlementsResponse, { userId: "ada", entitlements: [entitlement] });
    accepts(PaymentsAdminUserEntitlementsResponse, { userId: "nobody", entitlements: [] });
  });
});
