// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { PaymentsEntitlement } from "./entitlement";
import { PaymentsProviderAccount } from "./providerAccount";
import { PaymentsPurchase } from "./purchase";
import {
  PAYMENTS_ENTITLEMENTS_TABLE,
  PAYMENTS_PROVIDER_ACCOUNTS_TABLE,
  PAYMENTS_PURCHASES_TABLE,
  PAYMENTS_WEBHOOK_EVENTS_TABLE,
  paymentsTables,
} from "./tables";
import { PaymentsWebhookEvent } from "./webhookEvent";

/** camelCase here; `CamelCasePlugin` snake-cases it in the DDL. */
const toSnake = (name: string) => name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

describe("table prefixing (CLAUDE.md §Data layer)", () => {
  it("prefixes every provided table pithy_payments_, so it can never clash with an adopter's own", () => {
    for (const name of Object.keys(paymentsTables())) {
      expect(toSnake(name)).toMatch(/^pithy_payments_/);
    }
  });

  it("names the four tables the migration creates", () => {
    expect(Object.keys(paymentsTables()).sort()).toEqual(
      [
        PAYMENTS_PURCHASES_TABLE,
        PAYMENTS_ENTITLEMENTS_TABLE,
        PAYMENTS_PROVIDER_ACCOUNTS_TABLE,
        PAYMENTS_WEBHOOK_EVENTS_TABLE,
      ].sort(),
    );
  });
});

describe("PaymentsPurchase codec round-trip", () => {
  const purchase: PaymentsPurchase = {
    id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
    userId: "u1",
    rail: "apple",
    role: "charge",
    providerTransactionId: "2000000123456789",
    productId: "pro_monthly",
    providerProductId: "com.acme.pro.monthly",
    type: "subscription",
    status: "active",
    environment: "production",
    purchasedAt: new Date(1_700_000_000_000),
    expiresAt: new Date(1_702_592_000_000),
    revokedAt: null,
    originalTransactionId: "2000000000000001",
    amountMinor: 999,
    currency: "USD",
    providerEventAt: new Date(1_700_000_000_500),
    payload: { transactionId: "2000000123456789", type: "Auto-Renewable Subscription" },
    createdAt: new Date(1_700_000_001_000),
    updatedAt: new Date(1_700_000_001_000),
  };

  it("encodes every timestamp to ms-epoch and the payload to a JSON string, then decodes both back", () => {
    const row = PaymentsPurchase.encode(purchase);
    expect(row.purchasedAt).toBe(1_700_000_000_000);
    expect(row.expiresAt).toBe(1_702_592_000_000);
    expect(row.providerEventAt).toBe(1_700_000_000_500);
    expect(row.revokedAt).toBe(null);
    // The payload is a string in SQLite, never an object — that is what `sqliteJson` is for.
    expect(typeof row.payload).toBe("string");
    expect(PaymentsPurchase.parse(row)).toEqual(purchase);
  });

  it("round-trips a refunded consumable — a revokedAt, no expiry, and no reported amount", () => {
    const refunded: PaymentsPurchase = {
      ...purchase,
      type: "consumable",
      status: "refunded",
      expiresAt: null,
      revokedAt: new Date(1_700_100_000_000),
      originalTransactionId: null,
      amountMinor: null,
      currency: null,
    };
    expect(PaymentsPurchase.parse(PaymentsPurchase.encode(refunded))).toEqual(refunded);
  });

  it("round-trips a sandbox purchase as sandbox — the field never widens on the way through", () => {
    const sandbox: PaymentsPurchase = { ...purchase, environment: "sandbox" };
    expect(PaymentsPurchase.parse(PaymentsPurchase.encode(sandbox)).environment).toBe("sandbox");
  });

  it("rejects a row whose rail, status, type, or environment is outside its enum", () => {
    const row = PaymentsPurchase.encode(purchase);
    expect(PaymentsPurchase.safeParse({ ...row, rail: "amazon" }).success).toBe(false);
    expect(PaymentsPurchase.safeParse({ ...row, status: "trialing" }).success).toBe(false);
    expect(PaymentsPurchase.safeParse({ ...row, type: "subscription_group" }).success).toBe(false);
    expect(PaymentsPurchase.safeParse({ ...row, environment: "staging" }).success).toBe(false);
  });

  it("rejects a fractional amount — minor units are integers, never floats", () => {
    expect(PaymentsPurchase.safeParse({ ...PaymentsPurchase.encode(purchase), amountMinor: 9.99 }).success).toBe(false);
  });
});

describe("PaymentsEntitlement codec round-trip", () => {
  const entitlement: PaymentsEntitlement = {
    id: "9f8d1c00-0000-4000-8000-000000000001",
    userId: "u1",
    entitlement: "pro",
    active: true,
    expiresAt: new Date(1_702_592_000_000),
    sourcePurchaseId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
    manual: false,
    createdAt: new Date(1_700_000_001_000),
    updatedAt: new Date(1_700_000_001_000),
  };

  it("encodes active to 0|1 and back, and the expiry to ms-epoch", () => {
    const row = PaymentsEntitlement.encode(entitlement);
    expect(row.active).toBe(1);
    expect(row.expiresAt).toBe(1_702_592_000_000);
    expect(PaymentsEntitlement.parse(row)).toEqual(entitlement);
  });

  it("round-trips the revoked shape — inactive, never expiring, nothing granting it", () => {
    const revoked: PaymentsEntitlement = { ...entitlement, active: false, expiresAt: null, sourcePurchaseId: null };
    expect(PaymentsEntitlement.encode(revoked).active).toBe(0);
    expect(PaymentsEntitlement.parse(PaymentsEntitlement.encode(revoked))).toEqual(revoked);
  });

  it("rejects a store SKU where an entitlement key belongs — the key is validated as a key", () => {
    const row = PaymentsEntitlement.encode(entitlement);
    expect(PaymentsEntitlement.safeParse({ ...row, entitlement: "com.acme.pro" }).success).toBe(false);
  });
});

describe("PaymentsProviderAccount codec round-trip", () => {
  it("round-trips a Stripe customer link", () => {
    const account: PaymentsProviderAccount = {
      id: "9f8d1c00-0000-4000-8000-000000000002",
      rail: "stripe",
      providerAccountId: "cus_123",
      userId: "u1",
      createdAt: new Date(1_700_000_000_000),
    };
    const row = PaymentsProviderAccount.encode(account);
    expect(row.createdAt).toBe(1_700_000_000_000);
    expect(PaymentsProviderAccount.parse(row)).toEqual(account);
  });
});

describe("PaymentsWebhookEvent codec round-trip", () => {
  const event: PaymentsWebhookEvent = {
    id: "9f8d1c00-0000-4000-8000-000000000003",
    rail: "stripe",
    providerEventId: "evt_1Abc",
    payload: { type: "customer.subscription.updated" },
    receivedAt: new Date(1_700_000_000_000),
    processedAt: new Date(1_700_000_000_200),
    error: null,
    createdAt: new Date(1_700_000_000_000),
  };

  it("stores the payload as a JSON string and decodes it back to an object", () => {
    const row = PaymentsWebhookEvent.encode(event);
    expect(typeof row.payload).toBe("string");
    expect(PaymentsWebhookEvent.parse(row)).toEqual(event);
  });

  it("round-trips the drift shape — received, never processed, with the reason recorded", () => {
    const failed: PaymentsWebhookEvent = { ...event, processedAt: null, error: "signature verification failed" };
    expect(PaymentsWebhookEvent.parse(PaymentsWebhookEvent.encode(failed))).toEqual(failed);
  });
});
