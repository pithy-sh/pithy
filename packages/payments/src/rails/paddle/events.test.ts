// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import type { PaymentsPurchase } from "../../data/purchase";
import type { PaymentsPaddleCredentials } from "../../secret/registry";
import type { PaddleHttpFetch, PaddleHttpRequest } from "./api";
import { PADDLE_EVENT_RETENTION_DAYS, PADDLE_SWEPT_EVENT_TYPES, sweepPaddleEvents } from "./events";
import { accountReferenceProof } from "./objects";
import { readPaddlePricing, refreshPaddlePurchase } from "./refresh";

const CREDENTIALS: PaymentsPaddleCredentials = {
  apiKey: "pdl_sdbx_apikey_01hv8wptq8987qeep44cyrewp9_suiteonly",
  webhookSecret: "pdl_ntfset_01hv8wptq8987qeep44cyrewp9_suiteonly",
};
const NOW = new Date("2026-08-12T09:00:00Z");
const SUB = "sub_01hv8wptq8987qeep44cyrewp9";
const TXN = "txn_01hv8wptq8987qeep44cyrewp9";
const PRICE = "pri_01kzvyz9e21z9vbhd7xqq3csyh";

interface Call {
  url: string;
  init?: PaddleHttpRequest;
}

/** A transport answering by path fragment, recording every call and every URL. */
function stub(answers: Record<string, unknown>, options: { status?: number; body?: string } = {}) {
  const calls: Call[] = [];
  const transport = (async (url: string, init?: PaddleHttpRequest) => {
    calls.push({ url, init });
    if (options.status !== undefined) {
      return { ok: false, status: options.status, text: async () => options.body ?? "{}" };
    }
    const key = Object.keys(answers).find((fragment) => url.includes(fragment));
    if (key === undefined) return { ok: false, status: 404, text: async () => "{}" };
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: answers[key], meta: METADATA }) };
  }) as PaddleHttpFetch & { calls: Call[] };
  transport.calls = calls;
  return transport;
}

let METADATA: Record<string, unknown> = { pagination: { has_more: false } };

/** One subscription-activated event, stamped for this deployment. */
async function activated(eventId: string, occurredAt = "2026-08-12T09:00:00Z") {
  return {
    event_id: eventId,
    event_type: "subscription.activated",
    occurred_at: occurredAt,
    data: {
      id: SUB,
      status: "active",
      customer_id: "ctm_01",
      items: [{ price: { id: PRICE } }],
      current_billing_period: { starts_at: occurredAt, ends_at: "2026-09-12T09:00:00Z" },
      custom_data: {
        pithy_user: "ada",
        pithy_env: "prod",
        pithy_ref_proof: await accountReferenceProof("ada", "prod", CREDENTIALS.webhookSecret),
      },
      created_at: occurredAt,
    },
  };
}

const OPTIONS = {
  credentials: CREDENTIALS,
  environment: "production" as const,
  now: NOW,
  deployment: "prod",
};

describe("sweepPaddleEvents", () => {
  test("filters event types in the query, so an api key or a client token is never even fetched", async () => {
    // Verified live: the assigned sandbox's stream carries `api_key.created` and `client_token.created`,
    // and the client token's `token` field is not redacted by Paddle. A type absent from the query cannot
    // be recorded, which is a stronger control than filtering after the fact.
    const transport = stub({ "/events": [] });
    await sweepPaddleEvents({ ...OPTIONS, transport });

    const url = transport.calls[0]?.url ?? "";
    expect(url).toContain("order_by=id%5BASC%5D");
    expect(url).toContain("per_page=200");
    for (const type of PADDLE_SWEPT_EVENT_TYPES) {
      expect(url, type).toContain(`event_type=${encodeURIComponent(type)}`);
    }
    // Anti-vacuity: the filter is genuinely present rather than the URL being empty.
    expect(url.split("event_type=")).toHaveLength(PADDLE_SWEPT_EVENT_TYPES.length + 1);
    expect(url).not.toContain("api_key");
    expect(url).not.toContain("client_token");
  });

  test("resumes after a cursor, and advances only to the last event it read", async () => {
    const transport = stub({ "/events": [await activated("evt_02"), await activated("evt_03")] });
    const page = await sweepPaddleEvents({ ...OPTIONS, cursor: "evt_01", transport });
    expect(transport.calls[0]?.url).toContain("after=evt_01");
    expect(page.cursor).toBe("evt_03");
    expect(page.events.map((swept) => swept.eventId)).toEqual(["evt_02", "evt_03"]);
  });

  test("an empty page leaves the cursor where it was, rather than moving it onto nothing", async () => {
    const transport = stub({ "/events": [] });
    const page = await sweepPaddleEvents({ ...OPTIONS, cursor: "evt_01", transport });
    expect(page.cursor).toBe("evt_01");
    expect(page.events).toEqual([]);
  });

  test("projects a swept event through the same map a webhook uses", async () => {
    // The claim that makes the sweep a repair rather than a second answer: one map, two entry points.
    const transport = stub({ "/events": [await activated("evt_09")] });
    const page = await sweepPaddleEvents({ ...OPTIONS, transport });
    expect(page.events[0]?.notification.event).toMatchObject({
      providerTransactionId: SUB,
      role: "state",
      status: "active",
    });
    // The same `evt_…` a webhook would have recorded — Paddle's stream carries no notification_id — so a
    // sweep of an event already delivered collides on `UNIQUE (rail, providerEventId)` and reprojects
    // nothing. That is what makes two consecutive runs idempotent.
    expect(page.events[0]?.eventId).toBe("evt_09");
  });

  test("two consecutive runs over the same events read the same ids, so the guard de-duplicates them", async () => {
    const first = stub({ "/events": [await activated("evt_10"), await activated("evt_11")] });
    const second = stub({ "/events": [await activated("evt_10"), await activated("evt_11")] });
    const a = await sweepPaddleEvents({ ...OPTIONS, transport: first });
    const b = await sweepPaddleEvents({ ...OPTIONS, transport: second });
    expect(a.events.map((e) => e.eventId)).toEqual(b.events.map((e) => e.eventId));
    expect(a.cursor).toBe(b.cursor);
  });

  test("reports hasMore, so a caller knows to ask again", async () => {
    METADATA = { pagination: { has_more: true } };
    const transport = stub({ "/events": [await activated("evt_12")] });
    expect((await sweepPaddleEvents({ ...OPTIONS, transport })).hasMore).toBe(true);
    METADATA = { pagination: { has_more: false } };
  });

  test("a cursor past the 90-day retention reports a gap naming the window, and does not restart", async () => {
    // Restarting from the beginning would re-project three months of history; pretending the gap is not
    // there would leave it forever. So it is reported, and the cursor is left exactly where it was.
    const transport = stub({}, { status: 400, body: JSON.stringify({ error: { code: "not_found", detail: "x" } }) });
    const page = await sweepPaddleEvents({ ...OPTIONS, cursor: "evt_ancient", transport });
    expect(page.gap).toContain(String(PADDLE_EVENT_RETENTION_DAYS));
    expect(page.gap).toContain("evt_ancient");
    expect(page.cursor).toBe("evt_ancient");
    expect(page.events).toEqual([]);
  });

  test("a rotated key is not reported as a retention gap", async () => {
    // A 401 folds into the same error code as an unknown cursor, and reporting one as the other would
    // send an operator to the wrong page entirely.
    const transport = stub({}, { status: 401 });
    const thrown = await sweepPaddleEvents({ ...OPTIONS, cursor: "evt_01", transport }).catch(
      (error: unknown) => error as PithyError,
    );
    expect(thrown).toBeInstanceOf(PithyError);
    expect((thrown as PithyError).payload.code).toBe("payments/rail_not_configured");
  });

  test("an outage raises rather than reporting an empty sweep", async () => {
    // A step that swallowed a 503 would record a repair that never happened. It must fail and retry.
    const transport = stub({}, { status: 503 });
    const thrown = await sweepPaddleEvents({ ...OPTIONS, transport }).catch((error: unknown) => error as PithyError);
    expect((thrown as PithyError).payload.code).toBe("payments/provider_unavailable");
  });
});

describe("refreshPaddlePurchase", () => {
  const row = (providerTransactionId: string): PaymentsPurchase =>
    ({ providerTransactionId, rail: "paddle" }) as PaymentsPurchase;

  const base = { credentials: CREDENTIALS, environment: "production" as const, now: NOW };

  test("re-reads a subscription by its own key and dates the answer with the clock", async () => {
    const transport = stub({
      "/subscriptions/": {
        id: SUB,
        status: "canceled",
        items: [{ price: { id: PRICE } }],
        current_billing_period: { ends_at: "2026-09-12T09:00:00Z" },
        created_at: "2026-08-12T09:00:00Z",
        updated_at: "2020-01-01T00:00:00Z",
      },
    });
    const event = await refreshPaddlePurchase(row(SUB), { ...base, transport });
    expect(event).toMatchObject({ providerTransactionId: SUB, status: "canceled", role: "state" });
    // The clock, not the entity's `updated_at` — which is deliberately ancient here, so a reader of the
    // wrong field produces a visibly different answer and the monotonic rule would discard the repair.
    expect(event?.providerEventAt).toEqual(NOW);
  });

  test("re-reads a transaction by its own key, never by its family's", async () => {
    // Falling back to `originalTransactionId` would re-read the *subscription* and answer with a state
    // event keyed to a different row, which reconciliation reads as the row having been superseded.
    const transport = stub({
      "/transactions/": {
        id: TXN,
        status: "completed",
        subscription_id: SUB,
        items: [{ price: { id: PRICE } }],
        details: { totals: { grand_total: "999", currency_code: "USD" } },
        created_at: "2026-08-12T09:00:00Z",
      },
    });
    const event = await refreshPaddlePurchase(row(TXN), { ...base, transport });
    expect(event?.providerTransactionId).toBe(TXN);
    expect(transport.calls[0]?.url).toContain(`/transactions/${TXN}`);
    expect(transport.calls[0]?.url).not.toContain("/subscriptions/");
  });

  test("answers undefined when Paddle no longer knows the purchase", async () => {
    // The contract's documented "the store has nothing to say about this", which leaves the row alone.
    expect(await refreshPaddlePurchase(row(SUB), { ...base, transport: stub({}) })).toBeUndefined();
  });

  test("raises `payments/provider_unavailable` when Paddle cannot be reached", async () => {
    // So the Workflow step fails and retries rather than recording a repair that never happened.
    const thrown = await refreshPaddlePurchase(row(SUB), { ...base, transport: stub({}, { status: 503 }) }).catch(
      (error: unknown) => error as PithyError,
    );
    expect((thrown as PithyError).payload.code).toBe("payments/provider_unavailable");
  });

  test("answers undefined for a key prefix a later build wrote", async () => {
    expect(await refreshPaddlePurchase(row("adj_01"), { ...base, transport: stub({}) })).toBeUndefined();
  });
});

describe("readPaddlePricing", () => {
  const row = (providerTransactionId: string): PaymentsPurchase =>
    ({ providerTransactionId, rail: "paddle" }) as PaymentsPurchase;
  const base = { credentials: CREDENTIALS, environment: "production" as const, now: NOW };

  test("reports what is paid now, what it becomes, and when — every figure Paddle's own", async () => {
    const transport = stub({
      "/subscriptions/": {
        id: SUB,
        status: "active",
        next_transaction: { details: { totals: { total: "750", currency_code: "USD" } } },
        recurring_transaction_details: { totals: { total: "999", currency_code: "USD" } },
        discount: { id: "dsc_01", starts_at: "2026-08-12T09:00:00Z", ends_at: "2027-08-12T09:00:00Z" },
      },
    });
    const pricing = await readPaddlePricing(row(SUB), { ...base, transport });
    expect(pricing).toEqual({
      currency: "usd",
      currentAmountMinor: 750,
      listAmountMinor: 999,
      // Paddle's subscription object carries `discount.id` and no code, so a screen names the date rather
      // than the code — which is the half that stops a bill changing unannounced.
      discountCode: null,
      discountEndsAt: new Date("2027-08-12T09:00:00Z"),
    });
    // Both includes asked for in one call rather than two round trips for one question.
    expect(transport.calls[0]?.url).toContain("include=next_transaction%2Crecurring_transaction_details");
  });

  test("a transaction row has no `next`, so it answers undefined", async () => {
    const transport = stub({ "/subscriptions/": {} });
    expect(await readPaddlePricing(row(TXN), { ...base, transport })).toBeUndefined();
    expect(transport.calls).toHaveLength(0);
  });
});
