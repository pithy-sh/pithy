// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import type { PaymentsPaddleCredentials } from "../../secret/registry";
import type { PaddleHttpFetch } from "./api";
import { PADDLE_ADJUSTMENTS_INCLUDE, readTransaction } from "./read";

/**
 * What each read asks Paddle for, because an `include` is a permission demand and not a free extra.
 *
 * Paddle's permissions reference is explicit: *"Your key needs read permission for any entity added via
 * the `include` parameter"*, and a key without it gets a `forbidden` (403) — the OpenAPI spec carries the
 * same fact as `x-enum-permissions: {adjustments: ['adjustment.read']}` on this very parameter. So an
 * unconditional `include=adjustments` is an unconditional `adjustment.read` requirement on every
 * transaction read this rail makes, including the two that never look at the array.
 */

const CREDENTIALS: PaymentsPaddleCredentials = {
  apiKey: "pdl_sdbx_apikey_01hv8wptq8987qeep44cyrewp9_suiteonly",
  webhookSecret: "pdl_ntfset_01hv8wptq8987qeep44cyrewp9_suiteonly",
};
const TXN = "txn_01hv8wptq8987qeep44cyrewp9";
const PRICE = "pri_01kzvyz9e21z9vbhd7xqq3csyh";

const TRANSACTION = {
  id: TXN,
  status: "completed",
  customer_id: "ctm_01",
  items: [{ price: { id: PRICE } }],
  details: { totals: { grand_total: "9900", currency_code: "USD" } },
  created_at: "2026-08-12T09:00:00Z",
};

/** A transport recording every URL, answering 200 unless a case asks for a refusal. */
function stub(refusal?: { status: number; body?: string }) {
  const urls: string[] = [];
  const transport = (async (url: string) => {
    urls.push(url);
    if (refusal !== undefined) {
      return { ok: false, status: refusal.status, text: async () => refusal.body ?? "{}" };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: TRANSACTION }) };
  }) as PaddleHttpFetch & { urls: string[] };
  transport.urls = urls;
  return transport;
}

const options = (transport: PaddleHttpFetch) => ({
  credentials: CREDENTIALS,
  environment: "production" as const,
  transport,
});

describe("readTransaction", () => {
  test("asks for no include at all by default, so a key scoped to transactions alone can read one", async () => {
    // Receipt verification and reconciliation read a transaction for its totals, its status and its
    // `custom_data`. Neither looks at the adjustments array, and asking for it would make `adjustment.read`
    // a requirement of checking out — on a rail whose own documentation tells adopters to scope keys
    // narrowly.
    const transport = stub();
    expect(await readTransaction(TXN, options(transport))).toMatchObject({ id: TXN });

    const url = transport.urls[0] ?? "";
    expect(url).toContain(`/transactions/${TXN}`);
    expect(url).not.toContain("include");
    // No query string whatsoever — not merely no `adjustments`.
    expect(url).not.toContain("?");
  });

  test("asks for adjustments only when the caller says it needs them", async () => {
    // Anti-vacuity for the case above: the mechanism is plainly able to emit the include, so "no include"
    // there is the default and not a reader that lost the ability to ask.
    const transport = stub();
    expect(await readTransaction(TXN, options(transport), PADDLE_ADJUSTMENTS_INCLUDE)).toMatchObject({ id: TXN });
    expect(transport.urls[0]).toContain("include=adjustments");
  });

  test("a refusal of the adjustments read names the permission to grant", async () => {
    // 403 `forbidden` is exactly what Paddle answers a key that lacks `adjustment.read`, and "Paddle
    // refused the request for transaction txn_…" alone sends an operator to look at the wrong thing.
    const transport = stub({
      status: 403,
      body: JSON.stringify({ error: { code: "forbidden", detail: "You aren't permitted to perform this request." } }),
    });
    const thrown = await readTransaction(TXN, options(transport), PADDLE_ADJUSTMENTS_INCLUDE).catch(
      (error: unknown) => error as PithyError,
    );

    expect(thrown).toBeInstanceOf(PithyError);
    expect((thrown as PithyError).payload.code).toBe("payments/rail_not_configured");
    expect((thrown as PithyError).payload.detail).toContain("adjustment.read");
    expect((thrown as PithyError).payload.detail).toContain(TXN);
  });

  test("a plain read's refusal does not claim a permission it never asked for", async () => {
    // The other half. A 403 on a read that asked for no include is a key problem, not a missing
    // `adjustment.read`, and naming one would be a wrong answer rather than a vague one.
    const transport = stub({ status: 403, body: JSON.stringify({ error: { code: "forbidden" } }) });
    const thrown = await readTransaction(TXN, options(transport)).catch((error: unknown) => error as PithyError);
    expect((thrown as PithyError).payload.detail).not.toContain("adjustment.read");
  });

  test("an absent transaction is undefined rather than a refusal", async () => {
    const transport = stub({ status: 404 });
    expect(await readTransaction(TXN, options(transport))).toBeUndefined();
  });
});
