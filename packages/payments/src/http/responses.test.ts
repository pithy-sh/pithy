// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import type { z } from "zod";
import {
  PaymentsEntitlementResponse,
  PaymentsEntitlementsResponse,
  PaymentsEntitlementView,
  PaymentsHostedSessionResponse,
  PaymentsPurchaseResponse,
  PaymentsPurchaseView,
  PaymentsRestoreResponse,
} from "./responses";

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
