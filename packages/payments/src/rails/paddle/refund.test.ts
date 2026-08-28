// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import type { PaymentsPurchase } from "../../data/purchase";
import type { PaymentsPaddleCredentials } from "../../secret/registry";
import type { PaddleHttpFetch, PaddleHttpRequest } from "./api";
import { MAX_PADDLE_REFUND_TRANSACTIONS, requestPaddleRefunds } from "./refund";

/**
 * Raising refund adjustments at Paddle — the fourth verb of #465.
 *
 * Three facts shape every case below, and each is asserted rather than described:
 *
 * 1. **It is a request, not a completion.** Paddle holds most live refunds at `pending_approval` until a
 *    person reviews them. So the result says `requested`, carries the store's own status, and nothing in
 *    this module touches an entitlement or a row.
 * 2. **Refunds attach to transactions.** A subscription is a family of them, so the seam takes a set and
 *    raises one adjustment each — and the report is *total* over that set, because a report shorter than
 *    what was asked about is what a silent partial looks like.
 * 3. **They do not stack.** Paddle refuses a second adjustment on a transaction whose refund is pending.
 *    That is decided here, before anything is sent, and reported as `already_requested`.
 *
 * The transport asserts on what was **sent** — the verb, the path, the body — because two of this
 * module's obligations are invisible in a return value: a request issued when none should have been, and
 * an amount or a partial type reaching Paddle, both produce perfectly well-formed answers.
 */

const CREDENTIALS: PaymentsPaddleCredentials = {
  apiKey: "pdl_sdbx_apikey_01hv8wptq8987qeep44cyrewp9_suiteonly",
  webhookSecret: "pdl_ntfset_01hv8wptq8987qeep44cyrewp9_suiteonly",
};

const SUB = "sub_01m02kntv7bhw3sxdy5kyj93kt";
/** The first payment: Solo, 6.00, on the day the customer joined. */
const TXN_SOLO = "txn_01m02kntv7bhw3sxdy5kyj93k1";
/** The second: the 65.82 proration Paddle took when they upgraded to Team on day 10. */
const TXN_PRORATION = "txn_01m02kntv7bhw3sxdy5kyj93k2";

const REASON = 'Subscriber-requested refund of subscription "team_monthly".';

/** One outbound call, as the rail made it. */
interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | undefined;
}

/** What each endpoint answers. A transaction with no entry here is one Paddle does not know. */
interface Routes {
  /** `GET /transactions/{id}?include=adjustments`, keyed by transaction. */
  transactions?: Readonly<Record<string, unknown>>;
  /** `POST /adjustments`, keyed by the `transaction_id` in the body. A missing entry refuses with 400. */
  adjustments?: Readonly<Record<string, unknown>>;
  /** The transaction reads that fail, with the status Paddle answered. */
  readRefusal?: Readonly<Record<string, number>>;
}

/**
 * A transport that records every call and answers from `routes`.
 *
 * **An unrouted call throws rather than answering an empty body.** Half of these cases assert that a
 * write did *not* happen, and a stub that quietly answers everything turns "the rail sent nothing" into
 * "the rail sent something and the assertion looked elsewhere".
 */
function paddle(routes: Routes): PaddleHttpFetch & { calls: Call[] } {
  const calls: Call[] = [];
  const transport = (async (url: string, init?: PaddleHttpRequest) => {
    const method = init?.method ?? "GET";
    const body = init?.body === undefined ? undefined : (JSON.parse(init.body) as Record<string, unknown>);
    calls.push({ url, method, body });
    const path = url.replace(/^https:\/\/[^/]+/, "").split("?")[0] ?? "";

    if (method === "GET" && path.startsWith("/transactions/")) {
      const id = path.slice("/transactions/".length);
      const status = routes.readRefusal?.[id];
      if (status !== undefined) return { ok: false, status, text: async () => "{}" };
      const found = routes.transactions?.[id];
      if (found === undefined) return { ok: false, status: 404, text: async () => "{}" };
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: found }) };
    }
    if (method === "POST" && path === "/adjustments") {
      const id = String(body?.transaction_id);
      const answer = routes.adjustments?.[id];
      if (answer === undefined) {
        return {
          ok: false,
          status: 400,
          text: async () => JSON.stringify({ error: { code: "adjustment_invalid", detail: "Paddle would not." } }),
        };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: answer }) };
    }
    throw new Error(`the rail made a call this test did not route: ${method} ${path}`);
  }) as PaddleHttpFetch & { calls: Call[] };
  transport.calls = calls;
  return transport;
}

const options = (transport: PaddleHttpFetch) => ({
  credentials: CREDENTIALS,
  environment: "sandbox" as const,
  transport,
});

/** Every call that changes something at Paddle. The refusal cases assert this is empty. */
const writes = (transport: { calls: Call[] }) => transport.calls.filter((call) => call.method !== "GET");

/** A stored purchase naming one transaction on the subscription — the only reference this verb takes. */
function purchase(providerTransactionId: string, id: string, overrides: Partial<PaymentsPurchase> = {}) {
  return {
    id,
    subjectType: "user",
    subjectId: "ada",
    rail: "paddle",
    role: "charge",
    providerTransactionId,
    productId: "team_monthly",
    providerProductId: "pri_01kzvyz9khsdy36z10wb8bgmq4",
    type: "subscription",
    status: "active",
    environment: "sandbox",
    purchasedAt: new Date("2026-08-15T11:42:21.789Z"),
    expiresAt: new Date("2026-08-15T11:42:21.789Z"),
    revokedAt: null,
    resumesAt: null,
    originalTransactionId: SUB,
    amountMinor: 600,
    currency: "usd",
    providerEventAt: new Date("2026-08-15T11:42:21.789Z"),
    payload: {},
    createdAt: new Date("2026-08-15T11:42:21.789Z"),
    updatedAt: new Date("2026-08-15T11:42:21.789Z"),
    ...overrides,
  } as PaymentsPurchase;
}

const SOLO_ROW = purchase(TXN_SOLO, "11111111-1111-4111-8111-111111111111");
const PRORATION_ROW = purchase(TXN_PRORATION, "22222222-2222-4222-8222-222222222222");

/** A completed transaction with no adjustments against it — the ordinary refundable case. */
function transaction(id: string, total: string, adjustments: readonly unknown[] = []): Record<string, unknown> {
  return {
    id,
    status: "completed",
    customer_id: "ctm_01kzvyz9pithytestnotareal0",
    subscription_id: SUB,
    currency_code: "USD",
    details: { totals: { grand_total: total, currency_code: "USD" } },
    adjustments,
    created_at: "2026-08-15T11:42:21.789736Z",
  };
}

/** An adjustment, as `POST /adjustments` answers one and as an include lists one. */
function adjustment(id: string, transactionId: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    action: "refund",
    type: "full",
    status: "pending_approval",
    transaction_id: transactionId,
    subscription_id: SUB,
    customer_id: "ctm_01kzvyz9pithytestnotareal0",
    reason: REASON,
    currency_code: "USD",
    totals: { total: "600", currency_code: "USD" },
    created_at: "2026-08-28T11:14:02.663Z",
    ...overrides,
  };
}

const ADJ_SOLO = "adj_01m02kntv7bhw3sxdy5kyj93a1";
const ADJ_PRORATION = "adj_01m02kntv7bhw3sxdy5kyj93a2";

/** The thrown `PithyError`, or undefined. Keeps each refusal a single readable line. */
async function thrown(run: () => Promise<unknown>): Promise<PithyError | undefined> {
  try {
    await run();
    return undefined;
  } catch (error) {
    return error as PithyError;
  }
}

describe("requestPaddleRefunds — a request, never a completion", () => {
  test("raises one full refund per transaction, and says requested rather than refunded", async () => {
    // The recorded case the whole seam exists for: joined on Solo, upgraded on day 10, cancels on day 13.
    // Two payments, two adjustments, and both come back to the customer — not one.
    const transport = paddle({
      transactions: { [TXN_SOLO]: transaction(TXN_SOLO, "600"), [TXN_PRORATION]: transaction(TXN_PRORATION, "6582") },
      adjustments: {
        [TXN_SOLO]: adjustment(ADJ_SOLO, TXN_SOLO),
        [TXN_PRORATION]: adjustment(ADJ_PRORATION, TXN_PRORATION, { totals: { total: "6582" } }),
      },
    });

    const result = await requestPaddleRefunds(
      { purchases: [SOLO_ROW, PRORATION_ROW], reason: REASON },
      options(transport),
    );

    expect(result.outcomes).toEqual([
      {
        outcome: "requested",
        purchaseId: SOLO_ROW.id,
        adjustmentId: ADJ_SOLO,
        status: "awaiting_review",
      },
      {
        outcome: "requested",
        purchaseId: PRORATION_ROW.id,
        adjustmentId: ADJ_PRORATION,
        status: "awaiting_review",
      },
    ]);
  });

  test("sends exactly `action: refund`, `type: full`, the transaction, and a reason — and no amount", async () => {
    // Every field Paddle takes, pinned. `type: "partial"` needs `txnitm_` ids nothing here holds, and an
    // amount on a bearer route is a self-service withdrawal — so neither may ever appear in this body.
    const transport = paddle({
      transactions: { [TXN_SOLO]: transaction(TXN_SOLO, "600") },
      adjustments: { [TXN_SOLO]: adjustment(ADJ_SOLO, TXN_SOLO) },
    });

    await requestPaddleRefunds({ purchases: [SOLO_ROW], reason: REASON }, options(transport));

    const write = writes(transport)[0];
    expect(write?.method).toBe("POST");
    expect(write?.url).toContain("/adjustments");
    expect(write?.body).toEqual({
      action: "refund",
      type: "full",
      transaction_id: TXN_SOLO,
      reason: REASON,
    });
    for (const banned of ["amount", "amount_minor", "items", "line_items"]) {
      expect(Object.keys(write?.body ?? {}), banned).not.toContain(banned);
    }
  });

  test("reads each transaction with include=adjustments before it writes anything", async () => {
    // The pre-flight. Without the include there is no way to know a refund is already standing, and
    // learning that from Paddle mid-set is the failure mode this ordering exists to prevent.
    const transport = paddle({
      transactions: { [TXN_SOLO]: transaction(TXN_SOLO, "600") },
      adjustments: { [TXN_SOLO]: adjustment(ADJ_SOLO, TXN_SOLO) },
    });

    await requestPaddleRefunds({ purchases: [SOLO_ROW], reason: REASON }, options(transport));

    const [read, write] = transport.calls;
    expect(read?.method).toBe("GET");
    expect(read?.url).toContain(`/transactions/${TXN_SOLO}`);
    expect(read?.url).toContain("include=adjustments");
    expect(write?.method).toBe("POST");
  });

  test("carries the store's own status through, and maps every one Paddle states", async () => {
    // A sandbox refund can come back approved on creation. `approved` still does not mean the money
    // moved — that is the webhook's business — and the enum's own doc says so.
    for (const [stated, expected] of [
      ["pending_approval", "awaiting_review"],
      ["approved", "approved"],
      ["rejected", "rejected"],
      ["reversed", "reversed"],
    ] as const) {
      const transport = paddle({
        transactions: { [TXN_SOLO]: transaction(TXN_SOLO, "600") },
        adjustments: { [TXN_SOLO]: adjustment(ADJ_SOLO, TXN_SOLO, { status: stated }) },
      });
      const result = await requestPaddleRefunds({ purchases: [SOLO_ROW], reason: REASON }, options(transport));
      expect(result.outcomes[0], stated).toMatchObject({ outcome: "requested", status: expected });
    }
  });

  test("a status this build does not map is reported as unknown, never thrown", async () => {
    // The one place this package reports a value it does not understand. The adjustment exists and
    // cannot be un-raised, so throwing would discard the only handle anybody has on money in flight.
    const transport = paddle({
      transactions: { [TXN_SOLO]: transaction(TXN_SOLO, "600") },
      adjustments: { [TXN_SOLO]: adjustment(ADJ_SOLO, TXN_SOLO, { status: "escalated_to_underwriting" }) },
    });

    const result = await requestPaddleRefunds({ purchases: [SOLO_ROW], reason: REASON }, options(transport));
    expect(result.outcomes).toEqual([
      { outcome: "requested", purchaseId: SOLO_ROW.id, adjustmentId: ADJ_SOLO, status: "unknown" },
    ]);
  });

  test("nothing it returns is projectable — no status, no revocation, no purchase row", async () => {
    // The invariant that keeps the entitlement standing. A rail handing back an event would be a second
    // producer of a row the webhook owns, and the two race on `providerEventAt`.
    const transport = paddle({
      transactions: { [TXN_SOLO]: transaction(TXN_SOLO, "600") },
      adjustments: { [TXN_SOLO]: adjustment(ADJ_SOLO, TXN_SOLO) },
    });

    const result = await requestPaddleRefunds({ purchases: [SOLO_ROW], reason: REASON }, options(transport));
    const keys = Object.keys(result.outcomes[0] ?? {});
    for (const projectable of ["status_", "rail", "providerTransactionId", "role", "payload", "revokedAt"]) {
      expect(keys, projectable).not.toContain(projectable);
    }
    // And the row it was handed is untouched: this seam reads a purchase and writes nothing back.
    expect(SOLO_ROW.status).toBe("active");
    expect(SOLO_ROW.revokedAt).toBeNull();
  });
});

describe("requestPaddleRefunds — they do not stack", () => {
  test("a refund already pending is reported, and no second adjustment is sent", async () => {
    // Paddle: "You can't create an adjustment for a transaction that has a refund that's pending
    // approval." Being told that mid-set, after other adjustments were raised, is the worst place to
    // learn it — so it is decided here and reported.
    const standing = adjustment(ADJ_SOLO, TXN_SOLO);
    const transport = paddle({
      transactions: { [TXN_SOLO]: transaction(TXN_SOLO, "600", [standing]) },
    });

    const result = await requestPaddleRefunds({ purchases: [SOLO_ROW], reason: REASON }, options(transport));

    expect(result.outcomes).toEqual([
      { outcome: "already_requested", purchaseId: SOLO_ROW.id, adjustmentId: ADJ_SOLO, status: "awaiting_review" },
    ]);
    expect(writes(transport), "a second request must never reach Paddle").toEqual([]);
  });

  test("a refund already approved is reported the same way, and sends nothing", async () => {
    const standing = adjustment(ADJ_SOLO, TXN_SOLO, { status: "approved" });
    const transport = paddle({ transactions: { [TXN_SOLO]: transaction(TXN_SOLO, "600", [standing]) } });

    const result = await requestPaddleRefunds({ purchases: [SOLO_ROW], reason: REASON }, options(transport));
    expect(result.outcomes).toEqual([
      { outcome: "already_requested", purchaseId: SOLO_ROW.id, adjustmentId: ADJ_SOLO, status: "approved" },
    ]);
    expect(writes(transport)).toEqual([]);
  });

  test("an approved chargeback blocks a refund too — the money is already back", async () => {
    const standing = adjustment(ADJ_SOLO, TXN_SOLO, { action: "chargeback", status: "approved" });
    const transport = paddle({ transactions: { [TXN_SOLO]: transaction(TXN_SOLO, "600", [standing]) } });

    const result = await requestPaddleRefunds({ purchases: [SOLO_ROW], reason: REASON }, options(transport));
    expect(result.outcomes[0]).toMatchObject({ outcome: "already_requested", adjustmentId: ADJ_SOLO });
    expect(writes(transport)).toEqual([]);
  });

  test("a rejected refund does not block a second attempt", async () => {
    // A reviewer at the store turning one down is not a permanent bar. Treating it as one would make
    // somebody else's mistake final, on money the adopter has decided to give back.
    const rejected = adjustment(ADJ_SOLO, TXN_SOLO, { status: "rejected" });
    const transport = paddle({
      transactions: { [TXN_SOLO]: transaction(TXN_SOLO, "600", [rejected]) },
      adjustments: { [TXN_SOLO]: adjustment(ADJ_PRORATION, TXN_SOLO) },
    });

    const result = await requestPaddleRefunds({ purchases: [SOLO_ROW], reason: REASON }, options(transport));
    expect(result.outcomes[0]).toMatchObject({ outcome: "requested", adjustmentId: ADJ_PRORATION });
  });

  test("a credit against the balance does not block one either", async () => {
    // A credit is not a revocation — `adjustments.ts` says so at REVOKING_ACTIONS, and this reads the
    // same set rather than a second copy of it.
    const credit = adjustment(ADJ_SOLO, TXN_SOLO, { action: "credit", status: "approved" });
    const transport = paddle({
      transactions: { [TXN_SOLO]: transaction(TXN_SOLO, "600", [credit]) },
      adjustments: { [TXN_SOLO]: adjustment(ADJ_PRORATION, TXN_SOLO) },
    });

    const result = await requestPaddleRefunds({ purchases: [SOLO_ROW], reason: REASON }, options(transport));
    expect(result.outcomes[0]).toMatchObject({ outcome: "requested" });
  });

  test("a mixed set refunds the one that can be and reports the one that cannot", async () => {
    // The case a whole-set refusal would get wrong: refusing here means the customer never gets the
    // second payment back because the first was already handled.
    const standing = adjustment(ADJ_SOLO, TXN_SOLO);
    const transport = paddle({
      transactions: {
        [TXN_SOLO]: transaction(TXN_SOLO, "600", [standing]),
        [TXN_PRORATION]: transaction(TXN_PRORATION, "6582"),
      },
      adjustments: { [TXN_PRORATION]: adjustment(ADJ_PRORATION, TXN_PRORATION) },
    });

    const result = await requestPaddleRefunds(
      { purchases: [SOLO_ROW, PRORATION_ROW], reason: REASON },
      options(transport),
    );

    expect(result.outcomes).toEqual([
      { outcome: "already_requested", purchaseId: SOLO_ROW.id, adjustmentId: ADJ_SOLO, status: "awaiting_review" },
      {
        outcome: "requested",
        purchaseId: PRORATION_ROW.id,
        adjustmentId: ADJ_PRORATION,
        status: "awaiting_review",
      },
    ]);
    expect(writes(transport)).toHaveLength(1);
  });
});

describe("requestPaddleRefunds — all-or-nothing before the first write", () => {
  test("a transaction that is not completed refuses the whole request and sends nothing", async () => {
    // Paddle requires a completed transaction. The other payment in the set is perfectly refundable and
    // is still not sent: everything knowable in advance is decided before anything is written.
    const transport = paddle({
      transactions: {
        [TXN_SOLO]: { ...transaction(TXN_SOLO, "600"), status: "past_due" },
        [TXN_PRORATION]: transaction(TXN_PRORATION, "6582"),
      },
      adjustments: { [TXN_PRORATION]: adjustment(ADJ_PRORATION, TXN_PRORATION) },
    });

    const error = await thrown(() =>
      requestPaddleRefunds({ purchases: [SOLO_ROW, PRORATION_ROW], reason: REASON }, options(transport)),
    );

    expect(error?.payload.code).toBe("payments/subscription_change_refused");
    expect(error?.payload.status).toBe(409);
    expect(error?.payload.detail).toContain("past_due");
    expect(writes(transport), "nothing may be raised when the set cannot be honored whole").toEqual([]);
  });

  test("a transaction Paddle does not know refuses the whole request", async () => {
    const transport = paddle({ transactions: { [TXN_PRORATION]: transaction(TXN_PRORATION, "6582") } });

    const error = await thrown(() =>
      requestPaddleRefunds({ purchases: [SOLO_ROW, PRORATION_ROW], reason: REASON }, options(transport)),
    );

    expect(error?.payload.code).toBe("payments/subscription_change_refused");
    expect(error?.payload.detail).toContain(TXN_SOLO);
    expect(writes(transport)).toEqual([]);
  });

  test("a store that cannot be reached is 503, not a refusal of the subscription", async () => {
    // Nothing about the subscription is wrong. Telling a customer their refund was refused because a
    // read timed out is a true sentence about the wrong thing.
    const transport = paddle({ readRefusal: { [TXN_SOLO]: 503 } });

    const error = await thrown(() =>
      requestPaddleRefunds({ purchases: [SOLO_ROW], reason: REASON }, options(transport)),
    );
    expect(error?.payload.code).toBe("payments/provider_unavailable");
    expect(writes(transport)).toEqual([]);
  });

  test("an empty set is refused rather than answered with an empty report", async () => {
    // An empty report reads as "nothing to refund, all done", which is a sentence about somebody's money
    // that nobody asked for. A caller with nothing to refund has a refusal to render.
    const transport = paddle({});
    const error = await thrown(() => requestPaddleRefunds({ purchases: [], reason: REASON }, options(transport)));
    expect(error?.payload.code).toBe("payments/subscription_change_refused");
    expect(transport.calls, "an empty set costs no round trip").toEqual([]);
  });

  test("a set larger than one request can issue is refused before the first write", async () => {
    // A call that runs out of subrequest budget half way through is a partial by another name. The bound
    // is checked first, so the refusal is complete rather than discovered.
    const many = Array.from({ length: MAX_PADDLE_REFUND_TRANSACTIONS + 1 }, (_, index) =>
      purchase(`txn_bulk_${index}`, `00000000-0000-4000-8000-00000000${String(index).padStart(4, "0")}`),
    );
    const transport = paddle({});

    const error = await thrown(() => requestPaddleRefunds({ purchases: many, reason: REASON }, options(transport)));
    expect(error?.payload.code).toBe("payments/subscription_change_refused");
    expect(error?.payload.detail).toContain(String(many.length));
    expect(transport.calls, "a set refused on its size costs no round trip either").toEqual([]);
  });

  test("the bound is a real number and leaves room for both calls per transaction", () => {
    // Anti-vacuous: a bound of zero or of infinity would make the case above pass while bounding nothing.
    expect(MAX_PADDLE_REFUND_TRANSACTIONS).toBeGreaterThan(1);
    expect(MAX_PADDLE_REFUND_TRANSACTIONS * 2).toBeLessThan(50);
  });

  test("a purchase naming no Paddle transaction refuses rather than guessing at one", async () => {
    // A `sub_…` in the transaction column is the subscription's head row, not a payment. Sending it
    // would ask Paddle to refund a subscription, which is not a thing.
    const head = purchase(SUB, "33333333-3333-4333-8333-333333333333", { role: "state" });
    const transport = paddle({});

    const error = await thrown(() => requestPaddleRefunds({ purchases: [head], reason: REASON }, options(transport)));
    expect(error?.payload.code).toBe("payments/subscription_change_refused");
    expect(transport.calls).toEqual([]);
  });

  test("the first create failing throws, because nothing has been written yet", async () => {
    // The line the whole design sits on: before the first write a failure is an error, after it a
    // report. With nothing raised, an error is the honest and more useful answer.
    const transport = paddle({
      transactions: { [TXN_SOLO]: transaction(TXN_SOLO, "600"), [TXN_PRORATION]: transaction(TXN_PRORATION, "6582") },
      adjustments: { [TXN_PRORATION]: adjustment(ADJ_PRORATION, TXN_PRORATION) },
    });

    const error = await thrown(() =>
      requestPaddleRefunds({ purchases: [SOLO_ROW, PRORATION_ROW], reason: REASON }, options(transport)),
    );
    expect(error).toBeDefined();
    expect(writes(transport), "the refusal came before anything was raised").toHaveLength(1);
  });
});

describe("requestPaddleRefunds — after the first write, nothing throws", () => {
  test("a later create failing is reported, not raised, so the refund already in flight is not lost", async () => {
    // The silent partial this shape exists to prevent, asserted from the other side: an error here would
    // tell the caller the refund failed while 6.00 is on its way back to the customer.
    const transport = paddle({
      transactions: { [TXN_SOLO]: transaction(TXN_SOLO, "600"), [TXN_PRORATION]: transaction(TXN_PRORATION, "6582") },
      adjustments: { [TXN_SOLO]: adjustment(ADJ_SOLO, TXN_SOLO) },
    });

    const result = await requestPaddleRefunds(
      { purchases: [SOLO_ROW, PRORATION_ROW], reason: REASON },
      options(transport),
    );

    expect(result.outcomes[0]).toMatchObject({ outcome: "requested", adjustmentId: ADJ_SOLO });
    expect(result.outcomes[1]).toMatchObject({ outcome: "failed", purchaseId: PRORATION_ROW.id });
  });

  test("the report is total: one outcome per payment asked about, in the order asked", async () => {
    // What makes a partial impossible to miss. A caller counting outcomes and a caller counting payments
    // must get the same number, whatever happened in between.
    const transport = paddle({
      transactions: { [TXN_SOLO]: transaction(TXN_SOLO, "600"), [TXN_PRORATION]: transaction(TXN_PRORATION, "6582") },
      adjustments: { [TXN_SOLO]: adjustment(ADJ_SOLO, TXN_SOLO) },
    });

    const result = await requestPaddleRefunds(
      { purchases: [SOLO_ROW, PRORATION_ROW], reason: REASON },
      options(transport),
    );

    expect(result.outcomes).toHaveLength(2);
    expect(result.outcomes.map((outcome) => outcome.purchaseId)).toEqual([SOLO_ROW.id, PRORATION_ROW.id]);
  });

  test("an answer in a shape this build cannot read is reported once something has been raised", async () => {
    // Even a response with no adjustment in it cannot be allowed to throw here: Paddle answered 200, so
    // an adjustment may well exist, and losing the one that definitely does is the worse outcome.
    const transport = paddle({
      transactions: { [TXN_SOLO]: transaction(TXN_SOLO, "600"), [TXN_PRORATION]: transaction(TXN_PRORATION, "6582") },
      adjustments: { [TXN_SOLO]: adjustment(ADJ_SOLO, TXN_SOLO), [TXN_PRORATION]: { nothing: "recognizable" } },
    });

    const result = await requestPaddleRefunds(
      { purchases: [SOLO_ROW, PRORATION_ROW], reason: REASON },
      options(transport),
    );
    expect(result.outcomes[0]).toMatchObject({ outcome: "requested" });
    expect(result.outcomes[1]).toMatchObject({ outcome: "failed" });
  });

  test("no store secret reaches a reported reason", async () => {
    // `detail` and a trail both end up in an operator's logs, and the API key is in every request this
    // module makes. Paddle's own redaction is what keeps it out.
    const transport = paddle({
      transactions: { [TXN_SOLO]: transaction(TXN_SOLO, "600"), [TXN_PRORATION]: transaction(TXN_PRORATION, "6582") },
      adjustments: { [TXN_SOLO]: adjustment(ADJ_SOLO, TXN_SOLO) },
    });

    const result = await requestPaddleRefunds(
      { purchases: [SOLO_ROW, PRORATION_ROW], reason: REASON },
      options(transport),
    );
    expect(JSON.stringify(result)).not.toContain(CREDENTIALS.apiKey);
  });
});
