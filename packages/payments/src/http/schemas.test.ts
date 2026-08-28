// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { SubscriptionCancelTiming } from "../data/subscription";
import { SubscriptionCancelRequest, SubscriptionChangeRequest, SubscriptionPreviewRequest } from "./schemas";

/**
 * The subscription request schemas, held to the one rule that makes them safe: there is almost nothing
 * in them.
 *
 * Every field a caller could send on these routes is a field that names something the server is
 * supposed to resolve — a price, a rail, a subscription — so the tests here are mostly assertions of
 * absence, and they are written against the parsed *output* rather than the shape alone. A Zod object
 * strips unknown keys, so a body naming a price parses fine; what matters is that the price is gone
 * by the time a handler can reach it.
 */

/** Names that must never appear in a subscription request, and what each one would let a caller do. */
const FORBIDDEN = [
  // A subscription a caller names is somebody else's subscription. The route resolves it from the
  // caller's own purchase rows, which is the only set it can prove ownership of.
  "subscriptionId",
  "subscription",
  "providerSubscriptionId",
  // A price a caller names is a plan this project does not sell, bought at a price it did not set.
  "priceId",
  "providerProductId",
  "amount",
  "amountMinor",
  "currency",
  // A rail a caller names is the wrong store asked about a subscription that does not live there. The
  // subscription's own row says which store holds it.
  "rail",
  // The billing enums. `data/subscription.ts` states why neither is modeled anywhere: the value a client
  // would eventually set is Paddle's `do_not_bill`, a free upgrade.
  "prorationMode",
  "prorationBillingMode",
  "onPaymentFailure",
  "on_payment_failure",
  // The subject, as on every player-facing route in this package.
  "subjectId",
  "subjectType",
  "userId",
] as const;

describe("the subscription change request", () => {
  test("names a catalog product and nothing else", () => {
    expect(Object.keys(SubscriptionChangeRequest.shape)).toEqual(["productId"]);
  });

  test("a body naming a price, a rail or a subscription loses them in the parse", () => {
    // Not "is refused": Zod strips, and stripping is the behavior that matters — a handler reading
    // `c.req.valid("json")` cannot reach a field that is not in the output, whatever the client sent.
    const smuggled = Object.fromEntries(FORBIDDEN.map((field) => [field, "sub_01hv8wptq8987qeep44cyrewp9"]));
    expect(SubscriptionChangeRequest.parse({ productId: "team_monthly", ...smuggled })).toEqual({
      productId: "team_monthly",
    });
  });

  test("the product id is bounded, and an empty one is not a product", () => {
    expect(SubscriptionChangeRequest.safeParse({ productId: "team_monthly" }).success).toBe(true);
    expect(SubscriptionChangeRequest.safeParse({ productId: "" }).success).toBe(false);
    expect(SubscriptionChangeRequest.safeParse({ productId: "p".repeat(200) }).success).toBe(true);
    expect(SubscriptionChangeRequest.safeParse({ productId: "p".repeat(201) }).success).toBe(false);
    expect(SubscriptionChangeRequest.safeParse({}).success).toBe(false);
  });

  test("preview is that schema itself, not a copy of it", () => {
    // Two objects that must stay identical are two objects that will not. The preview route asks the
    // same question with the commit removed, so it is the same value under a name that reads on its
    // route line — and this is what stops somebody editing "the preview one".
    expect(SubscriptionPreviewRequest).toBe(SubscriptionChangeRequest);
  });
});

describe("the subscription cancel request", () => {
  test("states the timing in the customer's terms", () => {
    expect(SubscriptionCancelRequest.parse({ timing: "at_period_end" })).toEqual({ timing: "at_period_end" });
    expect(SubscriptionCancelRequest.parse({ timing: "now" })).toEqual({ timing: "now" });
  });

  test("the store's own spelling does not parse", () => {
    // The rail translates. A request in Paddle's vocabulary means somebody stopped translating and is
    // sending a string Paddle happens to accept — `next_billing_period` reads like "cancel next month"
    // and is not.
    expect(SubscriptionCancelRequest.safeParse({ timing: "next_billing_period" }).success).toBe(false);
    expect(SubscriptionCancelRequest.safeParse({ timing: "immediately" }).success).toBe(false);
  });

  test("the timing is required: ending somebody's access today is not a default", () => {
    expect(SubscriptionCancelRequest.safeParse({}).success).toBe(false);
  });

  test("the timings are the data module's, so a third cannot exist on one side only", () => {
    expect(SubscriptionCancelRequest.shape.timing.options).toEqual(SubscriptionCancelTiming.options);
  });

  test("it carries nothing else", () => {
    expect(Object.keys(SubscriptionCancelRequest.shape)).toEqual(["timing"]);
    const smuggled = Object.fromEntries(FORBIDDEN.map((field) => [field, "sub_01hv8wptq8987qeep44cyrewp9"]));
    expect(SubscriptionCancelRequest.parse({ timing: "at_period_end", ...smuggled })).toEqual({
      timing: "at_period_end",
    });
  });
});
