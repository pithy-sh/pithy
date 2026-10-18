// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { PaymentsReportedBilling } from "../../config/config";
import type { StripeHttpRequest } from "./api";
import { STRIPE_TEST_SECRET_KEY } from "./fixtures/events";
import meterEvent from "./fixtures/meter-event-created.json";
import { stripeUsageReporter } from "./usage";

const billing = PaymentsReportedBilling.parse({
  kind: "reported",
  unit: "student",
  max: 500,
  rails: ["stripe"],
  stripe: { meterEventName: "academy_students" },
});

const request = {
  providerSubscriptionId: "sub_1PithyAcme",
  providerCustomerId: "cus_PithyAcme",
  quantity: 25,
  period: "2026-10-05T09:00:00.000Z",
  at: new Date(1792022399 * 1000),
  billing,
  idempotencyKey: meterEvent.identifier,
};

/** A transport that records the one call and answers with the recorded meter event. */
function transport(answer: unknown = meterEvent, status = 200) {
  const calls: { url: string; init?: StripeHttpRequest }[] = [];
  return {
    calls,
    fetch: async (url: string, init?: StripeHttpRequest) => {
      calls.push({ url, init });
      return { ok: status < 400, status, text: async () => JSON.stringify(answer) };
    },
  };
}

describe("the Stripe usage reporter", () => {
  test("sends one Billing Meter event, keyed by the period's idempotency key, and accepts Stripe's answer", async () => {
    const wire = transport();
    await stripeUsageReporter({ secretKey: STRIPE_TEST_SECRET_KEY, transport: wire.fetch }).report(request);
    expect(wire.calls).toHaveLength(1);
    const call = wire.calls[0];
    expect(call?.url).toBe("https://api.stripe.com/v1/billing/meter_events");
    expect(call?.init?.method).toBe("POST");
    const form = new URLSearchParams(call?.init?.body ?? "");
    expect(Object.fromEntries(form)).toEqual({
      event_name: "academy_students",
      identifier: meterEvent.identifier,
      timestamp: String(meterEvent.timestamp),
      "payload[stripe_customer_id]": "cus_PithyAcme",
      "payload[value]": "25",
    });
  });

  test("refuses to report with no customer, rather than send an event Stripe would bill to nobody", async () => {
    const wire = transport();
    const reporter = stripeUsageReporter({ secretKey: STRIPE_TEST_SECRET_KEY, transport: wire.fetch });
    await expect(reporter.report({ ...request, providerCustomerId: undefined })).rejects.toThrow();
    expect(wire.calls).toEqual([]);
  });

  test("an answer that is not the event it sent is a failure, so the period stays claimed", async () => {
    const wire = transport({ ...meterEvent, identifier: "somebody_else" });
    await expect(
      stripeUsageReporter({ secretKey: STRIPE_TEST_SECRET_KEY, transport: wire.fetch }).report(request),
    ).rejects.toThrow();
  });

  test("a refusal from Stripe is a failure", async () => {
    const wire = transport({ error: { type: "invalid_request_error", message: "No such meter" } }, 400);
    await expect(
      stripeUsageReporter({ secretKey: STRIPE_TEST_SECRET_KEY, transport: wire.fetch }).report(request),
    ).rejects.toThrow();
  });
});
