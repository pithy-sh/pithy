// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { PaymentsReportedBilling } from "../../config/config";
import type { PaddleHttpRequest } from "./api";
import charged from "./fixtures/subscription-charge.json";
import { paddleUsageReporter } from "./usage";

const billing = PaymentsReportedBilling.parse({
  kind: "reported",
  unit: "student",
  max: 500,
  rails: ["paddle"],
  paddle: { priceId: "pri_seat_unit" },
});

const request = {
  providerSubscriptionId: charged.data.id,
  providerCustomerId: undefined,
  quantity: 25,
  period: "2026-10-05T09:00:00.000Z",
  at: new Date("2026-11-04T08:00:00.000Z"),
  billing,
  idempotencyKey: "usage_8c1f2a4e-6b3d-4f5a-9e7c-2d1b0a9f8e7d",
};

function transport(answer: unknown = charged, status = 200) {
  const calls: { url: string; init?: PaddleHttpRequest }[] = [];
  return {
    calls,
    fetch: async (url: string, init?: PaddleHttpRequest) => {
      calls.push({ url, init });
      return { ok: status < 400, status, text: async () => JSON.stringify(answer) };
    },
  };
}

describe("the Paddle usage reporter", () => {
  test("adds one one-time charge to the next bill, under the period's idempotency key", async () => {
    const wire = transport();
    await paddleUsageReporter({
      apiKey: "pdl_sdbx_apikey_suiteonly",
      environment: "sandbox",
      transport: wire.fetch,
    }).report(request);
    expect(wire.calls).toHaveLength(1);
    const call = wire.calls[0];
    expect(call?.url).toBe(`https://sandbox-api.paddle.com/subscriptions/${charged.data.id}/charge`);
    expect(call?.init?.method).toBe("POST");
    expect(call?.init?.headers?.["paddle-idempotency-key"]).toBe(request.idempotencyKey);
    expect(JSON.parse(call?.init?.body ?? "{}")).toEqual({
      effective_from: "next_billing_period",
      items: [{ price_id: "pri_seat_unit", quantity: 25 }],
    });
  });

  test("never rewrites the subscription's items — the recorded answer's recurring line is untouched", () => {
    // The charge adds a line to the next bill; the subscription Paddle answers with still carries its one
    // recurring item at the quantity it had. The reporter sends no `items` update, only a charge.
    expect(charged.data.items).toEqual([
      { status: "active", quantity: 1, recurring: true, price: { id: "pri_01kzvyz9e21z9vbhd7xqq3csyh" } },
    ]);
  });

  test("an answer naming another subscription is a failure", async () => {
    const wire = transport({ data: { ...charged.data, id: "sub_somebody_else" } });
    await expect(
      paddleUsageReporter({ apiKey: "k", environment: "sandbox", transport: wire.fetch }).report(request),
    ).rejects.toThrow();
  });
});
