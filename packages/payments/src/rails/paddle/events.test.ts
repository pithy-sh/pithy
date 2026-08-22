// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import type { PaymentsPurchase } from "../../data/purchase";
import type { PaymentsPaddleCredentials } from "../../secret/registry";
import type { PaddleHttpFetch, PaddleHttpRequest } from "./api";
import { PADDLE_EVENT_RETENTION_DAYS, PADDLE_SWEPT_EVENT_TYPES, sweepPaddleEvents } from "./events";
import { accountReferenceProof, type PaddleEvent } from "./objects";
import { PADDLE_RECORDED_EVENT_TYPES, recordedPayload } from "./recorded";
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
  test("asks for the event types in the one form Paddle documents: a single key, comma-separated", async () => {
    // Paddle documents every `array[string]` query parameter as one key with a comma-separated value, and
    // the live sandbox API confirmed it on 2026-08-13 — filtering on two of the six types in that
    // account's stream returned four events of exactly those two types. The earlier build sent
    // `event_type=a&event_type=b&…`, a repeated-key form documented nowhere; a filter Paddle does not
    // recognize is a filter it may not apply, and the whole account stream is what comes back.
    const transport = stub({ "/events": [] });
    await sweepPaddleEvents({ ...OPTIONS, transport });

    const url = transport.calls[0]?.url ?? "";
    expect(url).toContain("order_by=id%5BASC%5D");
    expect(url).toContain("per_page=200");
    // Exactly one `event_type` key. Two would be the undocumented form back again.
    expect(url.split("event_type=")).toHaveLength(2);
    expect(url).toContain(`event_type=${encodeURIComponent(PADDLE_SWEPT_EVENT_TYPES.join(","))}`);
    // And every type is genuinely in it. Anti-vacuity against a list that had emptied.
    for (const type of PADDLE_SWEPT_EVENT_TYPES) expect(decodeURIComponent(url), type).toContain(type);
    expect(PADDLE_SWEPT_EVENT_TYPES.length).toBeGreaterThan(15);
    expect(url).not.toContain("api_key");
    expect(url).not.toContain("client_token");
  });

  test("a type the filter excluded but Paddle returned anyway is walked past, not read and not recorded", async () => {
    // The control this package owns. A query parameter is a request honored by someone else's service;
    // an allowlist on what is *recorded* is a control we can prove. `client_token.created` carries a token
    // Paddle does not redact, so "the filter will have caught it" is not a safety argument.
    const TOKEN = "test_c0ffee0000000000000planted";
    const transport = stub({
      "/events": [
        {
          event_id: "evt_token",
          event_type: "client_token.created",
          occurred_at: "2026-08-12T09:00:00Z",
          data: { id: "ctkn_01", token: TOKEN },
        },
        await activated("evt_after"),
      ],
    });
    const page = await sweepPaddleEvents({ ...OPTIONS, transport });

    const [token, after] = page.events;
    // Null is the caller's instruction to write no row at all — not "projects nothing", which still does.
    expect(token?.notification).toBeNull();
    expect(JSON.stringify(page.events)).not.toContain(TOKEN);
    // The event is still reported, so the caller's cursor advances past it rather than stalling forever.
    expect(token?.eventId).toBe("evt_token");
    expect(page.cursor).toBe("evt_after");
    // Anti-vacuity: an allowlisted event on the same page was read in full, so the null above is the
    // allowlist working and not the whole page having failed to parse.
    expect(after?.notification?.event).toMatchObject({ providerTransactionId: SUB });
  });

  test("a swept adjustment reads its transaction, so a full refund projects a revocation", async () => {
    // The sweep asks Paddle for `adjustment.created` and `adjustment.updated`, and the map cannot tell a
    // full refund from a partial one without the transaction's own total. The reader was optional, the
    // sweep never passed one, and every swept refund therefore projected nothing *and* recorded itself as
    // handled — which then made the webhook redelivery of the same event id a duplicate the guard skipped.
    // The sweep did not merely miss the refund; it stopped the webhook from catching it.
    const transport = stub({
      "/events": [
        {
          event_id: "evt_refund",
          event_type: "adjustment.created",
          occurred_at: "2026-08-12T12:00:00Z",
          data: {
            id: "adj_01",
            action: "refund",
            status: "approved",
            transaction_id: TXN,
            totals: { total: "999" },
            created_at: "2026-08-12T12:00:00Z",
          },
        },
      ],
      "/transactions/": {
        id: TXN,
        status: "completed",
        customer_id: "ctm_01",
        items: [{ price: { id: PRICE } }],
        details: { totals: { grand_total: "999", currency_code: "USD" } },
        created_at: "2026-08-12T09:00:00Z",
      },
    });

    const page = await sweepPaddleEvents({ ...OPTIONS, transport });
    expect(page.events[0]?.notification?.event).toMatchObject({
      providerTransactionId: TXN,
      status: "refunded",
      role: "charge",
    });
    // The read genuinely happened, against the transaction the adjustment named — and it is the read that
    // asks for the adjustments array, which is the read that needs `adjustment.read` on the key.
    const read = transport.calls.find((call) => call.url.includes(`/transactions/${TXN}`));
    expect(read).toBeDefined();
    expect(read?.url).toContain("include=adjustments");
  });

  test("two partial adjustments summing to the whole transaction revoke, swept exactly as delivered", async () => {
    // The money defect, end to end through the sweep. Each adjustment is half of a 9900 transaction, so
    // neither reaches the total on its own and a per-adjustment comparison revokes nothing.
    const half = (id: string) => ({
      id,
      action: "refund",
      status: "approved",
      transaction_id: TXN,
      totals: { total: "4950" },
      created_at: "2026-08-12T12:00:00Z",
    });
    const transport = stub({
      "/events": [
        {
          event_id: "evt_second_half",
          event_type: "adjustment.created",
          occurred_at: "2026-08-12T12:00:00Z",
          data: half("adj_02"),
        },
      ],
      "/transactions/": {
        id: TXN,
        status: "completed",
        customer_id: "ctm_01",
        items: [{ price: { id: PRICE } }],
        details: { totals: { grand_total: "9900", currency_code: "USD" } },
        adjustments: [half("adj_01"), half("adj_02")],
        created_at: "2026-08-12T09:00:00Z",
      },
    });

    const page = await sweepPaddleEvents({ ...OPTIONS, transport });
    expect(page.events[0]?.notification?.event).toMatchObject({ status: "refunded" });
    expect(page.events[0]?.notification?.note ?? null).toBeNull();
  });

  test("one unreadable transaction costs its own event, not the page it arrived on", async () => {
    // The reader runs inside this function, which parses **every** event before returning, and the sweep
    // calls it outside the try/catch that guards projection. So a throw from the second event's
    // transaction read discarded the first event too — an event that had read perfectly and was ahead of
    // the failure in the stream, which is exactly the event the sweep exists to find.
    const transport = (async (url: string) => {
      if (url.includes("/transactions/")) return { ok: false, status: 503, text: async () => "{}" };
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            data: [
              await activated("evt_good"),
              {
                event_id: "evt_unreadable",
                event_type: "adjustment.created",
                occurred_at: "2026-08-12T12:00:00Z",
                data: {
                  id: "adj_01",
                  action: "refund",
                  status: "approved",
                  transaction_id: TXN,
                  totals: { total: "999" },
                  created_at: "2026-08-12T12:00:00Z",
                },
              },
              await activated("evt_behind"),
            ],
            meta: METADATA,
          }),
      };
    }) as PaddleHttpFetch;

    const page = await sweepPaddleEvents({ ...OPTIONS, transport });
    expect(page.events.map((swept) => swept.eventId)).toEqual(["evt_good", "evt_unreadable", "evt_behind"]);

    // The healthy event ahead of the failure kept its projection.
    expect(page.events[0]?.notification?.event).toMatchObject({ providerTransactionId: SUB });
    expect(page.events[0]?.failure).toBeNull();

    // The failure is attributed to the one event that caused it, with the cause the caller needs to write
    // a reason and the body it needs to write a row.
    const failed = page.events[1];
    expect(failed?.notification).toBeNull();
    const failure = failed?.failure ?? null;
    expect(failure).not.toBeNull();
    const cause = failure === null ? null : (failure.cause as PithyError);
    expect(cause?.payload.code).toBe("payments/provider_unavailable");
    expect(failure === null ? null : failure.payload).toMatchObject({ event_id: "evt_unreadable" });

    // And the event behind it was still read, so the caller decides what to do about the gap rather than
    // this function deciding by throwing.
    expect(page.events[2]?.failure).toBeNull();
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
    expect(page.events[0]?.notification?.event).toMatchObject({
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

/**
 * **The recording allowlist has no path around it.**
 *
 * `recorded.ts` states the control without an exception, and it has to: `PaddleEvent` is `.loose()`, and a
 * `client_token.created` body carries a `token` Paddle does not redact into a table an operator greps, an
 * export copies and a backup keeps.
 *
 * The failure branch wrote the parsed event straight through. It was harmless — every type that can reach
 * that branch is on the recorded list — but harmless by coincidence of two lists agreeing, not by the
 * control. Both halves are gated here: the branch goes through `recordedPayload`, and the subset the old
 * code was leaning on is asserted rather than assumed.
 */
describe("what the failure branch writes down", () => {
  test("every swept type is a recorded type, so no branch can reach D1 with an unvouched body", () => {
    // The invariant the old failure branch depended on without saying so. Asserted in this direction only:
    // the recorded list is deliberately wider — it covers the webhook path, where there is no query filter
    // and the subscribed-event list is set by a human in Paddle's dashboard.
    const unrecorded = PADDLE_SWEPT_EVENT_TYPES.filter((type) => !PADDLE_RECORDED_EVENT_TYPES.has(type));
    expect(unrecorded).toEqual([]);
  });

  test("a failed event's body is what `recordedPayload` returns, not the parsed event", async () => {
    // A loose top-level key nothing in the schema names, riding along on the event that fails its second
    // read. `recordedPayload` decides its fate — here it keeps it, because `adjustment.created` is a
    // recorded type — and this pins that the branch asks rather than assuming.
    const transport = (async (url: string) => {
      if (url.includes("/transactions/")) return { ok: false, status: 503, text: async () => "{}" };
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            data: [
              {
                event_id: "evt_unreadable",
                event_type: "adjustment.created",
                occurred_at: "2026-08-12T12:00:00Z",
                notification_id: "ntf_01",
                data: {
                  id: "adj_01",
                  action: "refund",
                  status: "approved",
                  transaction_id: TXN,
                  totals: { total: "999" },
                  created_at: "2026-08-12T12:00:00Z",
                },
              },
            ],
            meta: METADATA,
          }),
      };
    }) as PaddleHttpFetch;

    const page = await sweepPaddleEvents({ ...OPTIONS, transport });
    const payload = page.events[0]?.failure?.payload;
    expect(payload).toBeDefined();
    expect(payload).toEqual(
      recordedPayload({
        event_id: "evt_unreadable",
        event_type: "adjustment.created",
        occurred_at: "2026-08-12T12:00:00Z",
        notification_id: "ntf_01",
        data: {
          id: "adj_01",
          action: "refund",
          status: "approved",
          transaction_id: TXN,
          totals: { total: "999" },
          created_at: "2026-08-12T12:00:00Z",
        },
      } as PaddleEvent),
    );
  });
});
