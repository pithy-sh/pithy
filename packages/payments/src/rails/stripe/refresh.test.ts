// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import type { PaymentsPurchase } from "../../data/purchase";
import { PaymentsProviderUnavailableError, PaymentsVerificationFailedError } from "../../error/errors";
import subscriptionCreated from "./fixtures/event-subscription-created.json" with { type: "json" };
import { STRIPE_TEST_SECRET_KEY, type StripeRecordedCall, stripeStubTransport } from "./fixtures/events";
import { refreshStripeSubscription } from "./refresh";

/**
 * Stripe's reconciliation path: one retrieve, and the same mapping the webhook uses.
 *
 * What these cases pin is that a refresh is a *read of now* rather than a replay of an old event. The retrieve
 * carries no timestamp of its own, so the clock becomes the provider event time — and if it did not, the
 * monotonic write rule would discard every repair as staler than the row it was repairing.
 */

const NOW = new Date("2026-01-20T00:00:00.000Z");
const SUBSCRIPTION = subscriptionCreated.data.object;

const credentials = { secretKey: STRIPE_TEST_SECRET_KEY, webhookSecret: "whsec_unused" };

/** A stored Stripe subscription row, as the projection last wrote it. */
function stored(overrides: Partial<PaymentsPurchase> = {}): PaymentsPurchase {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    userId: "ada",
    rail: "stripe",
    providerTransactionId: "in_1PithyAdaJan",
    productId: "pro_monthly",
    providerProductId: "price_1Abc",
    type: "subscription",
    status: "active",
    environment: "production",
    purchasedAt: new Date("2026-01-01T00:00:00.000Z"),
    expiresAt: new Date("2026-02-01T00:00:00.000Z"),
    revokedAt: null,
    originalTransactionId: "sub_1PithyAdaPro",
    amountMinor: 999,
    currency: "usd",
    providerEventAt: new Date("2026-01-01T00:00:00.000Z"),
    payload: {},
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("refreshStripeSubscription", () => {
  test("retrieves the subscription by its own id and normalizes it", async () => {
    const calls: StripeRecordedCall[] = [];
    const transport = stripeStubTransport({ "/subscriptions/sub_1PithyAdaPro": { body: SUBSCRIPTION } }, calls);

    const event = await refreshStripeSubscription(stored(), { credentials, now: NOW, transport });

    expect(calls[0]?.url).toContain("/subscriptions/sub_1PithyAdaPro");
    expect(event).toMatchObject({
      rail: "stripe",
      // The invoice, not the subscription — each billing period is its own row, so a period nobody heard a
      // webhook for projects as a new row rather than overwriting the last one that did arrive.
      providerTransactionId: "in_1PithyAdaJan",
      originalTransactionId: "sub_1PithyAdaPro",
      providerProductId: "price_1Abc",
      status: "active",
      amountMinor: 999,
    });
  });

  test("dates the event by the clock, so a repair cannot lose to the row it is repairing", async () => {
    const transport = stripeStubTransport({ "/subscriptions/": { body: SUBSCRIPTION } });
    const event = await refreshStripeSubscription(stored(), { credentials, now: NOW, transport });
    expect(event?.providerEventAt).toEqual(NOW);
  });

  test("reports a state the row does not have yet — the drift a missed webhook leaves", async () => {
    const transport = stripeStubTransport({
      "/subscriptions/": { body: { ...SUBSCRIPTION, status: "canceled" } },
    });
    const event = await refreshStripeSubscription(stored(), { credentials, now: NOW, transport });
    expect(event?.status).toBe("expired");
  });

  test("a subscription Stripe no longer knows leaves the row exactly as it stood", async () => {
    // Not evidence that anybody's access ended: a 404 here is a deleted object or the other mode's account.
    const transport = stripeStubTransport({ "/subscriptions/": { status: 404 } });
    await expect(refreshStripeSubscription(stored(), { credentials, now: NOW, transport })).resolves.toBeUndefined();
  });

  test("a one-time purchase is not refreshed, and costs no round-trip", async () => {
    // A payment intent does not change after it succeeds. The one thing that changes it is a refund, which
    // arrives as `charge.refunded`.
    const calls: StripeRecordedCall[] = [];
    const transport = stripeStubTransport({ "/subscriptions/": { body: SUBSCRIPTION } }, calls);
    await expect(
      refreshStripeSubscription(stored({ type: "consumable" }), { credentials, now: NOW, transport }),
    ).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  test("a subscription row with no subscription id has nothing to retrieve", async () => {
    const calls: StripeRecordedCall[] = [];
    const transport = stripeStubTransport({ "/subscriptions/": { body: SUBSCRIPTION } }, calls);
    await expect(
      refreshStripeSubscription(stored({ originalTransactionId: null }), { credentials, now: NOW, transport }),
    ).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  test("an answer that is not a Subscription is refused rather than projected", async () => {
    const transport = stripeStubTransport({ "/subscriptions/": { body: { id: "sub_x", object: "subscription" } } });
    await expect(refreshStripeSubscription(stored(), { credentials, now: NOW, transport })).rejects.toBeInstanceOf(
      PaymentsVerificationFailedError,
    );
  });

  test("an outage is provider_unavailable, which is what tells the Workflow to retry", async () => {
    const transport = stripeStubTransport({ "/subscriptions/": { status: 503 } });
    await expect(refreshStripeSubscription(stored(), { credentials, now: NOW, transport })).rejects.toBeInstanceOf(
      PaymentsProviderUnavailableError,
    );
  });
});
