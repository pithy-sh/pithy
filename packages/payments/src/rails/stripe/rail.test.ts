// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { SIGNED_WEBHOOK_MAX_TOLERANCE_SECONDS } from "@pithy-sh/core/src/http/webhookWindow";
import { describe, expect, test } from "vitest";
import type { PaymentsStripeCredentials } from "../../secret/registry";
import subscriptionCreated from "./fixtures/event-subscription-created.json" with { type: "json" };
import { STRIPE_TEST_SECRET_KEY, STRIPE_TEST_WEBHOOK_SECRET, stripeSignatureHeader } from "./fixtures/events";
import { stripeRail } from "./rail";

/**
 * What a `toleranceSeconds` an adopter sets on the rail actually reaches.
 *
 * Four layers apply a default to that number on its way down — `rail.ts`, `webhook.ts`, `signature.ts`, and
 * the core primitive — and every one of them does it with `??`, which catches `undefined` and never `NaN`. The
 * decision written into those files is that exactly one of them refuses a bad number: the primitive, because
 * it owns the comparison. These cases are the proof that the decision holds, which is what makes it a decision
 * rather than three layers each assuming another one looked.
 */

const NOW = new Date("2026-01-15T00:00:00.000Z");

/** A decade before {@link NOW}. Outside every honest window, so only a broken one lets it through. */
const DECADE_AGO = new Date(NOW.getTime() - 10 * 365 * 24 * 3600 * 1000);

const CREDENTIALS: PaymentsStripeCredentials = {
  secretKey: STRIPE_TEST_SECRET_KEY,
  webhookSecret: STRIPE_TEST_WEBHOOK_SECRET,
};

/** One delivery Stripe would have sent at `timestamp`, correctly signed for these exact bytes. */
async function delivery(timestamp: Date) {
  const body = JSON.stringify(subscriptionCreated);
  const headers = new Headers();
  headers.set("stripe-signature", await stripeSignatureHeader(body, NOW, { timestamp }));
  return { body, headers };
}

/** Run the rail's webhook path and hand back the `PithyError`, or fail loudly when it accepted the delivery. */
async function refusal(promise: Promise<unknown>): Promise<PithyError> {
  try {
    await promise;
  } catch (cause) {
    if (cause instanceof PithyError) return cause;
    throw cause;
  }
  throw new Error("expected a refusal, got a pass");
}

describe("stripeRail — a tolerance cannot be smuggled down through the layers", () => {
  test.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["a negative window", -1],
    ["wider than the maximum", SIGNED_WEBHOOK_MAX_TOLERANCE_SECONDS + 1],
  ])("a decade-old delivery is refused when the rail was given %s", async (_label, toleranceSeconds) => {
    // The realistic source is `Number(env.STRIPE_WEBHOOK_TOLERANCE)` on a variable nobody set. A `NaN` does
    // not widen the window — `skew > NaN` is false, so it deletes it, and this capture verifies forever.
    const rail = stripeRail(CREDENTIALS, { toleranceSeconds });
    const { payload } = await refusal(rail.parseNotification(await delivery(DECADE_AGO), { now: NOW }));
    expect(payload.code).toBe("core/internal");
    expect(payload.status).toBe(500);
  });

  test("the same delivery is refused as an unverified webhook when the rail was given nothing", async () => {
    // The half that keeps the cases above about the tolerance rather than about the date.
    const rail = stripeRail(CREDENTIALS, {});
    const { payload } = await refusal(rail.parseNotification(await delivery(DECADE_AGO), { now: NOW }));
    expect(payload.code).toBe("payments/verification_failed");
  });

  test("a finite tolerance still reaches the comparison and still widens it", async () => {
    const rail = stripeRail(CREDENTIALS, { toleranceSeconds: 3000 });
    const notification = await rail.parseNotification(await delivery(new Date(NOW.getTime() - 2_000_000)), {
      now: NOW,
    });
    expect(notification.providerEventId).toBe("evt_stripeSubscriptionCreated");
  });
});
