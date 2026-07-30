// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import type { PaymentsStripeCredentials } from "../../secret/registry";
import invoicePaid from "./fixtures/event-invoice-paid.json" with { type: "json" };
import sessionSubscription from "./fixtures/event-session-completed-subscription.json" with { type: "json" };
import subscriptionCreated from "./fixtures/event-subscription-created.json" with { type: "json" };
import { STRIPE_TEST_SECRET_KEY, STRIPE_TEST_WEBHOOK_SECRET, stripeSignatureHeader } from "./fixtures/events";
import { parseStripeNotification } from "./webhook";

const NOW = new Date("2026-01-15T00:00:00.000Z");

const CREDENTIALS: PaymentsStripeCredentials = {
  secretKey: STRIPE_TEST_SECRET_KEY,
  webhookSecret: STRIPE_TEST_WEBHOOK_SECRET,
};

/** One delivery, signed the way Stripe signs it, unless a case bends the header. */
async function delivery(payload: unknown, options: { header?: string | null; body?: string } = {}) {
  const body = options.body ?? JSON.stringify(payload);
  const headers = new Headers();
  const header = options.header === undefined ? await stripeSignatureHeader(body, NOW) : options.header;
  if (header !== null) headers.set("stripe-signature", header);
  return { body, headers };
}

const parse = async (payload: unknown, options?: { header?: string | null; body?: string }) =>
  parseStripeNotification(await delivery(payload, options), { credentials: CREDENTIALS, now: NOW });

/** The refusal a delivery produced. Fails the test when it was accepted. */
async function refusal(promise: Promise<unknown>): Promise<PithyError> {
  try {
    await promise;
  } catch (cause) {
    if (cause instanceof PithyError) return cause;
    throw cause;
  }
  throw new Error("expected a refusal, got a pass");
}

describe("parseStripeNotification", () => {
  test("a signed subscription event verifies and normalizes", async () => {
    const notification = await parse(subscriptionCreated);
    expect(notification.providerEventId).toBe("evt_stripeSubscriptionCreated");
    expect(notification.event).toMatchObject({
      rail: "stripe",
      providerTransactionId: "in_1PithyAdaJan",
      originalTransactionId: "sub_1PithyAdaPro",
      status: "active",
    });
    expect(notification.providerAccountId).toBe("cus_PithyAda");
    expect(notification.note).toBeNull();
  });

  test("stores the whole event as the payload, not just the object", async () => {
    // The webhook row is the replay source. Keeping the envelope keeps the event id, the type, and Stripe's own
    // timestamp — which is what makes "why didn't this renew" answerable from the table alone.
    const notification = await parse(subscriptionCreated);
    expect(notification.payload).toMatchObject({
      id: "evt_stripeSubscriptionCreated",
      type: "customer.subscription.created",
    });
  });

  test("carries the account reference a session echoed back", async () => {
    const notification = await parse(sessionSubscription);
    expect(notification.accountReference).toBe("ada");
    expect(notification.providerAccountId).toBe("cus_PithyAda");
    // The subscription's own events carry the state; this delivery's job was the pairing.
    expect(notification.event).toBeNull();
  });

  test("an event type this build does not act on is authentic and silent", async () => {
    const notification = await parse(invoicePaid);
    expect(notification.providerEventId).toBe("evt_stripeInvoicePaid");
    expect(notification.event).toBeNull();
    expect(notification.note).toBeNull();
  });

  test("a tampered body is refused, however well it parses", async () => {
    // The signature covers the exact bytes. Swapping the object leaves a valid-looking event and an invalid HMAC.
    const header = await stripeSignatureHeader(JSON.stringify(subscriptionCreated), NOW);
    const tampered = JSON.stringify({
      ...subscriptionCreated,
      data: { object: { ...subscriptionCreated.data.object, customer: "cus_Attacker" } },
    });
    const error = await refusal(
      parseStripeNotification(
        { body: tampered, headers: new Headers({ "stripe-signature": header }) },
        {
          credentials: CREDENTIALS,
          now: NOW,
        },
      ),
    );
    expect(error.payload.code).toBe("payments/verification_failed");
  });

  test("an unsigned delivery is refused before anything is read", async () => {
    expect((await refusal(parse(subscriptionCreated, { header: null }))).payload.detail).toContain("Stripe-Signature");
  });

  test("a delivery signed with another secret is refused", async () => {
    const body = JSON.stringify(subscriptionCreated);
    const header = await stripeSignatureHeader(body, NOW, { secret: "whsec_someoneElsesEndpoint" });
    expect((await refusal(parse(subscriptionCreated, { header }))).payload.code).toBe("payments/verification_failed");
  });

  test("a delivery outside the replay window is refused", async () => {
    const body = JSON.stringify(subscriptionCreated);
    const header = await stripeSignatureHeader(body, NOW, { timestamp: new Date(NOW.getTime() - 3_600_000) });
    expect((await refusal(parse(subscriptionCreated, { header }))).payload.detail).toContain("tolerance");
  });

  test("a signed body that is not JSON is refused", async () => {
    // Cannot happen from Stripe, and must not become a half-read event if it ever does.
    expect((await refusal(parse(undefined, { body: "not json" }))).payload.code).toBe("payments/verification_failed");
  });

  test("a signed body that is not an event is refused", async () => {
    expect((await refusal(parse({ hello: "world" }))).payload.detail).toContain("Stripe event");
  });

  test("no refusal carries the webhook secret or the body", async () => {
    const body = JSON.stringify(subscriptionCreated);
    const header = await stripeSignatureHeader(body, NOW, { secret: "whsec_someoneElsesEndpoint" });
    const rendered = JSON.stringify((await refusal(parse(subscriptionCreated, { header }))).payload);
    expect(rendered).not.toContain(STRIPE_TEST_WEBHOOK_SECRET);
    expect(rendered).not.toContain("cus_PithyAda");
  });
});
