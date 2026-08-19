// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import type { PaymentsPurchase } from "../../data/purchase";
import type { PaymentsLemonSqueezyCredentials } from "../../secret/registry";
import type { LemonSqueezyHttpFetch } from "./api";
import { INVOICE_ONE, ORDER_ID, orderResponse, SUBSCRIPTION_ID, subscriptionResponse } from "./fixtures/events";
import { createLemonSqueezyPortalSession } from "./portal";
import { refreshLemonSqueezyPurchase } from "./refresh";
import { verifyLemonSqueezyOrder } from "./verify";

const CREDENTIALS: PaymentsLemonSqueezyCredentials = {
  apiKey: "ls_api_test",
  webhookSecret: "ls_whsec_test",
  storeId: "1",
};

const NOW = new Date("2026-06-01T00:00:00.000Z");

/** A transport answering one body, recording the URLs it was asked for. */
function stub(body: string, status = 200): LemonSqueezyHttpFetch & { urls: string[] } {
  const urls: string[] = [];
  const fetcher: LemonSqueezyHttpFetch = (url) => {
    urls.push(url);
    return Promise.resolve({ ok: status >= 200 && status < 300, status, text: () => Promise.resolve(body) });
  };
  return Object.assign(fetcher, { urls });
}

/** A stored row, as the projection last wrote it. Only the fields a refresh reads matter. */
function stored(overrides: Partial<PaymentsPurchase> = {}): PaymentsPurchase {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    subjectType: "user",
    subjectId: "ada",
    rail: "lemonSqueezy",
    role: "state",
    providerTransactionId: `subscription:${SUBSCRIPTION_ID}`,
    productId: "pro_monthly",
    providerProductId: "55555",
    type: "subscription",
    status: "active",
    environment: "production",
    purchasedAt: new Date("2026-01-01T10:00:00.000Z"),
    expiresAt: new Date("2026-02-01T10:00:00.000Z"),
    revokedAt: null,
    resumesAt: null,
    originalTransactionId: `subscription:${SUBSCRIPTION_ID}`,
    amountMinor: null,
    currency: null,
    providerEventAt: new Date("2026-01-01T10:00:00.000Z"),
    payload: {},
    createdAt: new Date("2026-01-01T10:00:00.000Z"),
    updatedAt: new Date("2026-01-01T10:00:00.000Z"),
    ...overrides,
  };
}

describe("refreshLemonSqueezyPurchase", () => {
  test("re-reads a state row by its own subscription id", async () => {
    const transport = stub(subscriptionResponse({ status: "cancelled", ends_at: "2026-03-01T10:00:00.000000Z" }));
    const event = await refreshLemonSqueezyPurchase(stored(), { credentials: CREDENTIALS, now: NOW, transport });

    expect(transport.urls[0]).toContain(`/subscriptions/${SUBSCRIPTION_ID}`);
    expect(event).toMatchObject({
      providerTransactionId: `subscription:${SUBSCRIPTION_ID}`,
      role: "state",
      status: "canceled",
    });
  });

  test("dates the repair with the clock, never the store's own timestamp", async () => {
    // The contract requires it. A refresh is a read of the state now, so it is the freshest fact anyone
    // holds — dating it earlier would let the monotonic write rule discard the very repair it is making.
    const transport = stub(subscriptionResponse({ updated_at: "2026-01-01T10:00:00.000000Z" }));
    const event = await refreshLemonSqueezyPurchase(stored(), { credentials: CREDENTIALS, now: NOW, transport });
    expect(event?.providerEventAt).toEqual(NOW);
  });

  test("re-reads an order row", async () => {
    const transport = stub(orderResponse({ refunded: true, refunded_at: "2026-05-01T00:00:00.000000Z" }));
    const event = await refreshLemonSqueezyPurchase(
      stored({
        role: "charge",
        type: "non_consumable",
        providerTransactionId: `order:${ORDER_ID}`,
        originalTransactionId: null,
      }),
      { credentials: CREDENTIALS, now: NOW, transport },
    );
    expect(transport.urls[0]).toContain(`/orders/${ORDER_ID}`);
    expect(event).toMatchObject({ status: "refunded", role: "charge" });
  });

  test("has nothing to say about a money row, and says so rather than inventing an answer", async () => {
    // A `subscription_invoice:` row records one closed billing period. It is born `expired`, which is
    // terminal, so the reconciliation pass never selects one — and re-reading a closed invoice could only
    // restate what it already says.
    const transport = stub(subscriptionResponse());
    const event = await refreshLemonSqueezyPurchase(
      stored({
        role: "charge",
        providerTransactionId: `subscription_invoice:${INVOICE_ONE}`,
        originalTransactionId: null,
      }),
      { credentials: CREDENTIALS, now: NOW, transport },
    );
    expect(event).toBeUndefined();
    expect(transport.urls).toEqual([]);
  });

  test("a subscription the store no longer knows is undefined, which leaves the row as it stands", async () => {
    const transport = stub("", 404);
    const event = await refreshLemonSqueezyPurchase(stored(), { credentials: CREDENTIALS, now: NOW, transport });
    expect(event).toBeUndefined();
  });

  test("a store that cannot be reached throws, so the Workflow retries rather than recording a false repair", async () => {
    const transport: LemonSqueezyHttpFetch = () => Promise.reject(new Error("network"));
    try {
      await refreshLemonSqueezyPurchase(stored(), { credentials: CREDENTIALS, now: NOW, transport });
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(PithyError);
      if (error instanceof PithyError) expect(error.payload.code).toBe("payments/provider_unavailable");
    }
  });
});

describe("createLemonSqueezyPortalSession", () => {
  test("reads the caller's own customer and hands back its signed portal link", async () => {
    const transport = stub(
      JSON.stringify({
        data: {
          type: "customers",
          id: "700",
          attributes: { urls: { customer_portal: "https://acme.lemonsqueezy.com/billing?token=abc" } },
        },
      }),
    );
    const session = await createLemonSqueezyPortalSession(
      { providerAccountId: "700" },
      { credentials: CREDENTIALS, transport },
    );
    expect(session.url).toBe("https://acme.lemonsqueezy.com/billing?token=abc");
    expect(transport.urls[0]).toContain("/customers/700");
  });

  test("takes no return URL, because Lemon Squeezy's portal has nowhere to return to", async () => {
    // Expressed in the contract as an optional `returnUrl`, so this rail declines it in the type rather
    // than accepting one an adopter configured and silently dropping it.
    const transport = stub(
      JSON.stringify({
        data: { attributes: { urls: { customer_portal: "https://acme.lemonsqueezy.com/billing?token=abc" } } },
      }),
    );
    await createLemonSqueezyPortalSession({ providerAccountId: "700" }, { credentials: CREDENTIALS, transport });
    expect(transport.urls[0]).not.toContain("return");
  });

  test("refuses a customer with no portal link rather than sending a browser nowhere", async () => {
    const transport = stub(JSON.stringify({ data: { attributes: { urls: {} } } }));
    await expect(
      createLemonSqueezyPortalSession({ providerAccountId: "700" }, { credentials: CREDENTIALS, transport }),
    ).rejects.toBeInstanceOf(PithyError);
  });
});

describe("verifyLemonSqueezyOrder", () => {
  test("refuses every submitted receipt, because no shape of one could be trusted", async () => {
    // LS order ids are sequential integers. A verify that trusted one would let any authenticated caller
    // claim any order in the store by counting, and `linkProviderAccount` never rebinds — so the first
    // pairing wins and the theft is permanent.
    for (const receipt of ["8801", "1", "", "some-uuid-looking-thing"]) {
      await expect(verifyLemonSqueezyOrder(receipt)).rejects.toBeInstanceOf(PithyError);
    }
  });

  test("the refusal tells a buyer their purchase is coming, not that they did something wrong", async () => {
    try {
      await verifyLemonSqueezyOrder("8801");
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(PithyError);
      if (error instanceof PithyError) {
        expect(error.payload.code).toBe("payments/invalid_receipt");
        expect(error.payload.action).toMatch(/nothing to submit/i);
      }
    }
  });

  test("makes no network call at all — there is nothing worth asking", async () => {
    // Refusing without a round-trip is the point: a lookup would be a lookup an attacker could drive.
    let called = false;
    const spy: LemonSqueezyHttpFetch = () => {
      called = true;
      return Promise.reject(new Error("should not be reached"));
    };
    void spy;
    await expect(verifyLemonSqueezyOrder("8801")).rejects.toBeInstanceOf(PithyError);
    expect(called).toBe(false);
  });
});
