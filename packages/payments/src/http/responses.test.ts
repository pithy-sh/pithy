// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import type { z } from "zod";
import { PaymentsConfig } from "../config/config";
import type { PaymentsEntitlement } from "../data/entitlement";
import {
  PaymentsAdminCatalogProduct,
  PaymentsAdminCatalogResponse,
  PaymentsAdminEntitlementsResponse,
  PaymentsAdminEntitlementView,
  PaymentsAdminPurchasesResponse,
  PaymentsAdminPurchaseView,
  PaymentsAdminSubjectEntitlementsResponse,
  PaymentsAdminSubscriptionsResponse,
  PaymentsCheckoutHandoffResponse,
  PaymentsEntitlementResponse,
  PaymentsEntitlementsResponse,
  PaymentsEntitlementView,
  PaymentsPortalHandoffResponse,
  PaymentsPurchaseResponse,
  PaymentsPurchaseView,
  PaymentsRestoreResponse,
} from "./responses";
import { adminCatalogView, adminEntitlementView, adminPurchaseView } from "./view";

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
  resumesAt: null,
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
  });

  test("a client's own views name no subject at all", () => {
    // The player-facing half of the subject rule. A client reads its own rows, and who holds them is the
    // answer the server already resolved — under organization billing from the adopter's resolver, never
    // from anything the request said. Echoing the holder back teaches a client that it is a value in the
    // protocol, and the field a response carries is the field a request grows next.
    for (const view of [PaymentsPurchaseView, PaymentsEntitlementView]) {
      const fields = Object.keys(view.shape);
      expect(fields).not.toContain("subjectId");
      expect(fields).not.toContain("subjectType");
      expect(fields).not.toContain("userId");
    }
  });

  test("the envelopes accept what the routes return", () => {
    accepts(PaymentsPurchaseResponse, { purchase: PURCHASE, entitlements: [ENTITLEMENT] });
    accepts(PaymentsEntitlementsResponse, { entitlements: [] });
    accepts(PaymentsRestoreResponse, { purchases: [PURCHASE], entitlements: [ENTITLEMENT] });
    accepts(PaymentsCheckoutHandoffResponse, { kind: "redirect", url: "https://checkout.stripe.com/c/pay/cs_test_1" });
    accepts(PaymentsCheckoutHandoffResponse, {
      kind: "paddle",
      transactionId: "txn_01hv8wptq8987qeep44cyrewp9",
      clientToken: "test_1234567890abcdef",
      environment: "sandbox",
      displayMode: "overlay",
      successUrl: "https://acme.example/thanks",
    });
    accepts(PaymentsPortalHandoffResponse, { url: "https://sandbox-customer-portal.paddle.com/cpl_01" });
    accepts(PaymentsPortalHandoffResponse, {
      url: "https://sandbox-customer-portal.paddle.com/cpl_01",
      subscriptions: [{ subscriptionId: "sub_01", cancel: "https://…/cancel", updatePaymentMethod: "https://…/pay" }],
    });
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
      subjectType: "user",
      subjectId: "ada",
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
      resumesAt: null,
      updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    });
    accepts(PaymentsAdminPurchaseView, purchase);

    const row: PaymentsEntitlement = {
      id: "8c1f9b9e-6a2a-4c9d-8f1b-2b7c7d4c1a02",
      subjectType: "organization",
      subjectId: "acme",
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

  test("a management view carries the subject as the pair the row is keyed on", () => {
    // The other half of the subject rule, and the reason it is a test rather than a convention: an
    // organization id may equal some user's id, so a view carrying `subjectId` alone renders one holder's
    // subscription under the other's name. Both halves are projected off one row, never assembled from
    // config and a column — which is what this asserts by reading the pair back out of the projection.
    const row: PaymentsEntitlement = {
      id: "8c1f9b9e-6a2a-4c9d-8f1b-2b7c7d4c1a02",
      subjectType: "organization",
      subjectId: "shared-id",
      entitlement: "pro",
      active: true,
      expiresAt: null,
      sourcePurchaseId: null,
      manual: true,
      createdAt: new Date("2026-06-01T00:00:00.000Z"),
      updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    };
    const view = adminEntitlementView(row, new Date("2026-06-10T00:00:00.000Z"));
    expect(view.subjectType).toBe("organization");
    expect(view.subjectId).toBe("shared-id");
    // A user holding the same id is a different holder, and the schema is what keeps the two apart.
    expect(PaymentsAdminEntitlementView.parse({ ...view, subjectType: "user" })).not.toEqual(view);
    // And a half-named holder does not parse at all, in either direction.
    for (const half of ["subjectType", "subjectId"]) {
      const { [half]: _dropped, ...rest } = view as Record<string, unknown>;
      expect(PaymentsAdminEntitlementView.safeParse(rest).success).toBe(false);
    }
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
    // The entitlement row's own uuid is internal: an entitlement is addressed by its subject and its key.
    expect(Object.keys(PaymentsAdminEntitlementView.shape)).not.toContain("id");
  });

  test("the management envelopes accept what the handlers return", () => {
    const purchase: PaymentsAdminPurchaseView = {
      id: "9c1f9b9e-6a2a-4c9d-8f1b-2b7c7d4c1a01",
      subjectType: "user",
      subjectId: "ada",
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
      resumesAt: null,
      updatedAt: "2026-06-01T00:00:00.000Z",
    };
    const entitlement: PaymentsAdminEntitlementView = {
      subjectType: "user",
      subjectId: "ada",
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
    // No cursor on the per-subject read: `UNIQUE (subjectType, subjectId, entitlement)` bounds it, so there
    // is no page. Both halves are echoed, so what a client renders is the holder it asked about.
    accepts(PaymentsAdminSubjectEntitlementsResponse, {
      subjectType: "user",
      subjectId: "ada",
      entitlements: [entitlement],
    });
    accepts(PaymentsAdminSubjectEntitlementsResponse, {
      subjectType: "organization",
      subjectId: "acme",
      entitlements: [],
    });
    // A response naming only the id does not parse: half an address is a holder nobody asked about.
    expect(PaymentsAdminSubjectEntitlementsResponse.safeParse({ subjectId: "ada", entitlements: [] }).success).toBe(
      false,
    );
  });

  test("the catalog view is what the schema says, in both of its two states", () => {
    // Equality rather than a bare parse, as everywhere in this file: a Zod object strips unknown keys, so
    // parsing alone would pass a projection that had grown one.
    const config = PaymentsConfig.parse({
      billingSubject: "user",
      rails: { apple: true },
      manualEntitlements: ["founder"],
      products: {
        pro_monthly: {
          type: "subscription",
          name: "Pro",
          entitlements: ["pro"],
          apple: { productId: "com.acme.pro.monthly" },
        },
      },
    });
    // The empty catalog still has a `billingSubject`: what a project bills is required config, and a
    // project selling nothing yet has still decided who it would bill. It is not a catalog fact, which is
    // why nothing about it reaches the response.
    const empty = PaymentsConfig.parse({ billingSubject: "organization" });
    accepts(PaymentsAdminCatalogResponse, adminCatalogView(config));
    accepts(PaymentsAdminCatalogResponse, adminCatalogView(empty));
    expect(adminCatalogView(empty)).toEqual({ enabled: false });
  });

  test("a catalog product carries four facts, and none of them is commercial", () => {
    // The field list is locked here; the *invariant* — that no value outside these four can cross — is
    // asserted over a real response in `controlPlane.workers.test.ts`. Both, because this one names the
    // shape a client codes against and that one catches a field nobody thought to ban.
    expect(Object.keys(PaymentsAdminCatalogProduct.shape).sort()).toEqual(["entitlements", "id", "name", "type"]);
  });
});
