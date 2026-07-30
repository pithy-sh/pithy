import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import type { PaymentsStripeCredentials } from "../../secret/registry";
import sessionPayment from "./fixtures/event-session-completed-payment.json" with { type: "json" };
import sessionSubscription from "./fixtures/event-session-completed-subscription.json" with { type: "json" };
import subscriptionCreated from "./fixtures/event-subscription-created.json" with { type: "json" };
import {
  STRIPE_TEST_SECRET_KEY,
  STRIPE_TEST_WEBHOOK_SECRET,
  type StripeRecordedCall,
  type StripeStubAnswer,
  stripeStubTransport,
} from "./fixtures/events";
import { verifyStripeSession } from "./verify";

const NOW = new Date("2026-01-15T00:00:00.000Z");

const CREDENTIALS: PaymentsStripeCredentials = {
  secretKey: STRIPE_TEST_SECRET_KEY,
  webhookSecret: STRIPE_TEST_WEBHOOK_SECRET,
};

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** What Stripe answers a retrieve with: the session, with whatever the case expanded onto it. */
const retrieved = (overrides: Record<string, unknown> = {}, fixture: unknown = sessionPayment): StripeStubAnswer => ({
  body: { ...(clone(fixture) as { data: { object: object } }).data.object, ...overrides },
});

async function verify(answer: StripeStubAnswer, receipt = "cs_test_pithyCoins") {
  const calls: StripeRecordedCall[] = [];
  const purchase = await verifyStripeSession(receipt, {
    credentials: CREDENTIALS,
    now: NOW,
    transport: stripeStubTransport({ "/checkout/sessions/": answer }, calls),
  });
  return { purchase, url: calls[0]?.url ?? "" };
}

async function refusal(promise: Promise<unknown>): Promise<PithyError> {
  try {
    await promise;
  } catch (cause) {
    if (cause instanceof PithyError) return cause;
    throw cause;
  }
  throw new Error("expected a refusal, got a pass");
}

describe("verifyStripeSession", () => {
  test("retrieves the session the browser came back with, expanded", async () => {
    // Hosted Checkout returns the buyer to `success_url` with the session id. Reading it once is what lets the
    // buyer see their entitlement immediately instead of waiting for the webhook — the same immediacy the other
    // two rails get from a client submission, and worth nothing to correctness: the webhook produces the
    // identical row through the same writer.
    const { purchase, url } = await verify(retrieved());
    expect(url).toContain("/checkout/sessions/cs_test_pithyCoins");
    expect(url).toContain("expand%5B0%5D=subscription");
    expect(url).toContain("expand%5B1%5D=line_items");
    // The third expansion, and the only one that says anything about a refund: the session itself is
    // refund-blind, so without the charge this path answers `active` on a purchase Stripe has given back.
    expect(url).toContain("expand%5B2%5D=payment_intent.latest_charge");
    expect(purchase.event).toMatchObject({
      rail: "stripe",
      providerTransactionId: "pi_1PithyCoins",
      providerProductId: "price_1Coins",
      status: "active",
    });
    expect(purchase.providerAccountId).toBe("cus_PithyAda");
  });

  test("carries the reference this deployment set, so the route can refuse somebody else's session", async () => {
    // A session id is not a secret. What stops one being submitted by another signed-in user is that the session
    // itself names the purchaser we sent to Checkout.
    expect((await verify(retrieved())).purchase.accountReference).toBe("ada");
  });

  test("a one-time session is dated by Stripe's clock, not ours — a snapshot may not outrank a refund", async () => {
    // A completed Checkout Session is immutable, and `payment_status` reads `paid` for ever whatever became of
    // the money. Dating that snapshot with our clock let a buyer re-post the `cs_…` id from her success URL
    // after a refund had landed and re-grant the purchase permanently. The purchase's own time cannot do that.
    expect((await verify(retrieved())).purchase.event.providerEventAt).toEqual(new Date("2026-01-01T00:00:00.000Z"));
  });

  test("a refund on the expanded charge is what the retrieve reports, dated when we learned of it", async () => {
    const answer = retrieved({
      payment_intent: {
        id: "pi_1PithyCoins",
        object: "payment_intent",
        created: 1767225600,
        latest_charge: {
          id: "ch_1PithyCoins",
          object: "charge",
          created: 1767225600,
          refunded: true,
          amount_refunded: 499,
        },
      },
    });
    const { purchase } = await verify(answer);
    expect(purchase.event).toMatchObject({
      providerTransactionId: "pi_1PithyCoins",
      status: "refunded",
      revokedAt: NOW,
      // A revocation can resurrect nothing, so it is dated now: at the charge's own time the monotonic rule
      // would discard the repair against a row the completion webhook already wrote.
      providerEventAt: NOW,
    });
  });

  test("a subscription session is dated by the clock, because the expanded subscription is live state", async () => {
    // The asymmetry is the point. Stripe expands the subscription itself and reports its state now, so a read is
    // the freshest fact anyone has; dating it older would make a submission lose to a notification it beats.
    const answer = retrieved({ subscription: clone(subscriptionCreated).data.object }, sessionSubscription);
    expect((await verify(answer, "cs_test_pithyPro")).purchase.event.providerEventAt).toEqual(NOW);
  });

  test("a subscription session projects the expanded subscription", async () => {
    const answer = retrieved({ subscription: clone(subscriptionCreated).data.object }, sessionSubscription);
    const { purchase } = await verify(answer, "cs_test_pithyPro");
    expect(purchase.event).toMatchObject({
      providerTransactionId: "in_1PithyAdaJan",
      originalTransactionId: "sub_1PithyAdaPro",
      status: "active",
    });
  });

  test("a checkout that has not completed is refused rather than projected as nothing", async () => {
    // An abandoned or still-open session has no subscription and no payment. The buyer should be told, not left
    // with a 200 and no entitlement.
    const answer = retrieved({ status: "open", subscription: null }, sessionSubscription);
    const error = await refusal(verify(answer, "cs_test_pithyPro"));
    expect(error.payload.code).toBe("payments/verification_failed");
  });

  test("a session Stripe has never heard of is refused", async () => {
    const error = await refusal(verify({ status: 404 }));
    expect(error.payload.code).toBe("payments/verification_failed");
    expect(error.payload.status).toBe(400);
  });

  test("anything that is not a Checkout Session id is refused before Stripe is called", async () => {
    // A caller submitting an Apple receipt to the Stripe rail gets a clear answer and costs no round-trip.
    for (const receipt of ["", "pi_1PithyCoins", "sub_1PithyAdaPro", "eyJhbGciOiJFUzI1NiJ9.e30.x", "cs_test_a b"]) {
      const error = await refusal(verifyStripeSession(receipt, { credentials: CREDENTIALS, now: NOW }));
      expect(error.payload.code, receipt).toBe("payments/invalid_receipt");
    }
  });

  test("a Stripe outage is a 503, not a rejected purchase", async () => {
    // Telling a buyer who has just paid that their purchase is invalid because Stripe is down would send them to
    // support over nothing.
    expect((await refusal(verify({ status: 503 }))).payload.code).toBe("payments/provider_unavailable");
  });

  test("no refusal carries the secret key or the session's customer", async () => {
    const rendered = JSON.stringify((await refusal(verify({ status: 404 }))).payload);
    expect(rendered).not.toContain(STRIPE_TEST_SECRET_KEY);
    expect(rendered).not.toContain("cus_PithyAda");
  });
});
