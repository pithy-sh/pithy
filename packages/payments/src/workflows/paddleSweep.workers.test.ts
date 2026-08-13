// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { PaymentsConfig, type PaymentsConfigInput } from "../config/config";
import { paymentsDatabase } from "../data/tables";
import { payments_0001_purchases } from "../migrations/0001_purchases";
import type { PaddleHttpFetch, PaddleHttpRequest } from "../rails/paddle/api";
import { accountReferenceProof } from "../rails/paddle/objects";
import type { PaymentsPaddleCredentials } from "../secret/registry";
import { sweepPaddle } from "./paddleSweep";

/**
 * The sweep against real D1, because every claim it makes is a claim about rows.
 *
 * Idempotency is the one that matters most, and it is proved the only honest way: the same events are
 * swept twice and the database is counted afterwards. The sweep writes through the *same*
 * `pithy_payments_webhook_events` table and the *same* `UNIQUE (rail, providerEventId)` the webhook guard
 * uses, so an event already delivered is already recorded — and this is where that is checked rather than
 * asserted.
 */

const TABLES = [
  "pithy_payments_purchases",
  "pithy_payments_entitlements",
  "pithy_payments_provider_accounts",
  "pithy_payments_webhook_events",
  "pithy_payments_reconcile_runs",
  "pithy_payments_sync_cursors",
];

const CREDENTIALS: PaymentsPaddleCredentials = {
  apiKey: "pdl_sdbx_apikey_01hv8wptq8987qeep44cyrewp9_suiteonly",
  webhookSecret: "pdl_ntfset_01hv8wptq8987qeep44cyrewp9_suiteonly",
};
const NOW = new Date("2026-08-12T09:00:00Z");
const PRICE = "pri_01kzvyz9e21z9vbhd7xqq3csyh";
const SUB = "sub_01hv8wptq8987qeep44cyrewp9";
const TXN = "txn_01hv8wptq8987qeep44cyrewp9";
const CUSTOMER = "ctm_01hv8wptq8987qeep44cyrewp9";

const CATALOG: PaymentsConfigInput = {
  rails: { paddle: true },
  paddle: {
    clientToken: "test_1234567890abcdefghij",
    environment: "production",
    checkout: "overlay",
    successUrl: "https://acme.example/thanks",
  },
  products: { pro_monthly: { type: "subscription", name: "Pro", entitlements: ["pro"], paddle: { priceId: PRICE } } },
};

/**
 * The row-id sequence, per test rather than per sweep.
 *
 * Deliberately not reset inside {@link deps}: two sweeps in one test each minting `row-1` would collide on
 * the table's primary key for any event the second sweep had not already recorded, which is a fixture
 * artefact that would read as a product failure.
 */
let seq = 0;

beforeEach(async () => {
  for (const table of TABLES) await env.DB.exec(`DROP TABLE IF EXISTS ${table}`);
  await payments_0001_purchases.up(createDatabase(env.DB, {}) as unknown as Kysely<unknown>);
  seq = 0;
});

const db = () => paymentsDatabase(env.DB);
const purchases = () => db().selectFrom("pithyPaymentsPurchases").selectAll().execute();
const webhookRows = () =>
  db().selectFrom("pithyPaymentsWebhookEvents").selectAll().orderBy("providerEventId").execute();
const cursors = () => db().selectFrom("pithyPaymentsSyncCursors").selectAll().execute();

/** One `subscription.activated`, stamped with a proof this deployment could have written. */
async function activated(eventId: string, subscriptionId = SUB) {
  return {
    event_id: eventId,
    event_type: "subscription.activated",
    occurred_at: "2026-08-12T09:00:00Z",
    data: {
      id: subscriptionId,
      status: "active",
      customer_id: CUSTOMER,
      items: [{ price: { id: PRICE } }],
      current_billing_period: { starts_at: "2026-08-12T09:00:00Z", ends_at: "2026-09-12T09:00:00Z" },
      custom_data: {
        pithy_user: "ada",
        pithy_env: "prod",
        pithy_ref_proof: await accountReferenceProof("ada", "prod", CREDENTIALS.webhookSecret),
      },
      created_at: "2026-08-12T09:00:00Z",
    },
  };
}

/** A transport answering `/events` with fixed pages, and recording every URL it was asked for. */
function stream(pages: unknown[][]): PaddleHttpFetch & { urls: string[] } {
  let call = 0;
  const urls: string[] = [];
  const transport = (async (url: string, _init?: PaddleHttpRequest) => {
    urls.push(url);
    const page = pages[call] ?? [];
    const hasMore = call < pages.length - 1;
    call += 1;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: page, meta: { pagination: { has_more: hasMore } } }),
    };
  }) as PaddleHttpFetch & { urls: string[] };
  transport.urls = urls;
  return transport;
}

/**
 * A transport answering `/events` with one page and `/transactions/` with a fixed transaction.
 *
 * The adjustment map cannot tell a full refund from a partial one without the transaction's own total, so
 * a sweep that reaches an adjustment must reach Paddle twice. Every URL is recorded, because "did the
 * sweep ask?" is the claim.
 */
function streamAndTransaction(page: unknown[], txn: unknown): PaddleHttpFetch & { urls: string[] } {
  const urls: string[] = [];
  const transport = (async (url: string, _init?: PaddleHttpRequest) => {
    urls.push(url);
    const body = url.includes("/transactions/") ? txn : page;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: body, meta: { pagination: { has_more: false } } }),
    };
  }) as PaddleHttpFetch & { urls: string[] };
  transport.urls = urls;
  return transport;
}

/** One approved `refund` adjustment against {@link TXN}, for whatever fraction a case gives it. */
function refund(id: string, total: string) {
  return {
    id,
    action: "refund",
    status: "approved",
    transaction_id: TXN,
    subscription_id: SUB,
    customer_id: CUSTOMER,
    totals: { total },
    created_at: "2026-08-12T12:00:00Z",
  };
}

/** The transaction those adjustments adjust: 9900, billed against the subscription above. */
function refundedTransaction(adjustments: unknown[]) {
  return {
    id: TXN,
    status: "completed",
    customer_id: CUSTOMER,
    subscription_id: SUB,
    items: [{ price: { id: PRICE } }],
    details: { totals: { grand_total: "9900", currency_code: "USD" } },
    adjustments,
    created_at: "2026-08-12T09:00:00Z",
  };
}

/** The sweep's dependencies, with a deterministic id minter so rows are readable. */
function deps(transport: PaddleHttpFetch, overrides: Record<string, unknown> = {}) {
  const nextId = () => {
    seq += 1;
    return `row-${seq}`;
  };
  return {
    d1: env.DB,
    config: PaymentsConfig.parse(CATALOG),
    environment: "production" as const,
    credentials: CREDENTIALS,
    paddleEnvironment: "production" as const,
    deployment: "prod",
    now: () => NOW,
    newId: nextId,
    transport,
    // Nothing in this catalog grants a balance, so fulfillment has nothing to do — supplied explicitly so
    // a ledger that is not composed cannot be what makes a case pass.
    fulfill: async () => undefined,
    ...overrides,
  };
}

describe("sweepPaddle", () => {
  test("projects an event for a purchase this deployment holds no row for", async () => {
    // The whole reason the sweep exists: `refresh` can only re-read rows we already have, so a purchase
    // whose webhook was never delivered is invisible to it forever.
    expect(await purchases()).toHaveLength(0);

    const report = await sweepPaddle(deps(stream([[await activated("evt_01")]])));
    expect(report).toMatchObject({ read: 1, projected: 1, ignored: 0, duplicate: 0, failed: 0, gap: null });

    const rows = await purchases();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ rail: "paddle", userId: "ada", providerTransactionId: SUB, status: "active" });
    // Bound through the proven reference, exactly as the webhook path binds.
    const links = await db().selectFrom("pithyPaymentsProviderAccounts").selectAll().execute();
    expect(links[0]).toMatchObject({ rail: "paddle", providerAccountId: CUSTOMER, userId: "ada" });
  });

  test("two consecutive runs over the same events are a no-op the second time", async () => {
    // The idempotency claim, counted against the database rather than read off a flag.
    const first = await sweepPaddle(deps(stream([[await activated("evt_01"), await activated("evt_02", "sub_02")]])));
    expect(first).toMatchObject({ read: 2, projected: 2, duplicate: 0 });

    const second = await sweepPaddle(deps(stream([[await activated("evt_01"), await activated("evt_02", "sub_02")]])));
    // Read again — Paddle answered with the same page — and projected nothing: both are already recorded.
    expect(second).toMatchObject({ read: 2, projected: 0, duplicate: 2, failed: 0 });

    expect(await purchases()).toHaveLength(2);
    expect(await webhookRows()).toHaveLength(2);
  });

  test("an event a webhook already delivered is recognized, not reprojected", async () => {
    // The two paths share `UNIQUE (rail, providerEventId)` on Paddle's own `evt_…`, because the stream
    // carries no notification_id. That is what makes the sweep a repair rather than a duplicate source.
    // Written as raw SQL rather than through Kysely: the row is already encoded, and an `as any` to
    // satisfy the typed insert would be noise around a fixture.
    await env.DB.prepare(
      "INSERT INTO pithy_payments_webhook_events (id, rail, provider_event_id, payload, received_at, processed_at, error, created_at) VALUES (?, 'paddle', 'evt_01', '{}', ?, ?, null, ?)",
    )
      .bind("already", NOW.getTime(), NOW.getTime(), NOW.getTime())
      .run();

    const report = await sweepPaddle(deps(stream([[await activated("evt_01")]])));
    expect(report).toMatchObject({ read: 1, projected: 0, duplicate: 1 });
    expect(await purchases()).toHaveLength(0);
    expect(await webhookRows()).toHaveLength(1);
  });

  test("the cursor advances past what was projected, and resumes from it next run", async () => {
    await sweepPaddle(deps(stream([[await activated("evt_01"), await activated("evt_02", "sub_02")]])));
    expect((await cursors())[0]).toMatchObject({ rail: "paddle", name: "events", cursor: "evt_02" });

    const resumed = stream([[]]);
    await sweepPaddle(deps(resumed));
    expect(resumed.urls[0]).toContain("after=evt_02");
    // One cursor row per stream, still — two would let two runs each believe they were authoritative.
    expect(await cursors()).toHaveLength(1);
  });

  test("the first failure halts advancement, so nothing behind it is skipped", async () => {
    // Advancing past a failure turns a transient fault into a purchase nothing ever finds again — there is
    // no second pass that would look, which is the whole reason this sweep exists.
    //
    // The failure is planted in the data rather than in a stub: `evt_02` names a price the catalog does
    // not sell, so the real projection writer refuses it for the real reason.
    const unsellable = await activated("evt_02", "sub_02");
    (unsellable.data as { items: { price: { id: string } }[] }).items = [{ price: { id: "pri_not_in_catalog" } }];

    const report = await sweepPaddle(
      deps(stream([[await activated("evt_01"), unsellable, await activated("evt_03", "sub_03")]])),
    );
    expect(report).toMatchObject({ projected: 1, failed: 1 });

    // The cursor stopped at the last event that fully projected — **not** at the failure, and not at the
    // end of the page. `evt_03` is behind it and will be swept again next run.
    expect((await cursors())[0]?.cursor).toBe("evt_01");
    expect(await purchases()).toHaveLength(1);
    // The failure is recorded with its reason, which is what makes it findable.
    const failed = (await webhookRows()).find((row) => row.providerEventId === "evt_02");
    expect(failed?.error).toContain("payments/");
  });

  test("a cursor past Paddle's retention reports a gap and leaves the cursor alone", async () => {
    await sweepPaddle(deps(stream([[await activated("evt_01")]])));
    expect((await cursors())[0]?.cursor).toBe("evt_01");

    const refusing = (async (url: string) => {
      void url;
      return {
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ error: { code: "not_found", detail: "no such event" } }),
      };
    }) as PaddleHttpFetch;

    const report = await sweepPaddle(deps(refusing));
    expect(report.gap).toContain("90");
    expect(report.gap).toContain("evt_01");
    // Untouched: restarting would re-project three months, and clearing it would lose the gap.
    expect((await cursors())[0]?.cursor).toBe("evt_01");
  });

  test("an event stamped for another environment is recorded, projects nothing, and does not stall the sweep", async () => {
    const fenced = await activated("evt_01");
    (fenced.data as { custom_data: Record<string, string> }).custom_data = {
      pithy_user: "someone",
      pithy_env: "staging",
      pithy_ref_proof: await accountReferenceProof("someone", "staging", CREDENTIALS.webhookSecret),
    };

    const report = await sweepPaddle(deps(stream([[fenced, await activated("evt_02", "sub_02")]])));
    expect(report).toMatchObject({ read: 2, projected: 1, ignored: 1, failed: 0 });
    // The cursor is past both: a delivery that is not ours is behind us either way.
    expect((await cursors())[0]?.cursor).toBe("evt_02");
    expect(await purchases()).toHaveLength(1);
  });

  test("a project with the rail off sweeps nothing at all", async () => {
    const transport = stream([[await activated("evt_01")]]);
    const report = await sweepPaddle(
      deps(transport, {
        config: PaymentsConfig.parse({
          rails: { stripe: true },
          stripe: {
            successUrl: "https://acme.example/thanks",
            cancelUrl: "https://acme.example/paywall",
            portalReturnUrl: "https://acme.example/account",
          },
          products: {
            pro: { type: "subscription", name: "Pro", entitlements: ["pro"], stripe: { priceId: "price_1" } },
          },
        }),
      }),
    );
    expect(report).toMatchObject({ read: 0, projected: 0 });
    // Not a single call left the Worker. A rail nobody sells through costs nothing.
    expect(transport.urls).toHaveLength(0);
  });

  test("an event that failed to project is tried again next sweep, not counted a duplicate", async () => {
    // The defect. `complete()` set `processedAt` even when it wrote an error, and `fresh` is read off
    // `processedAt` — so the next sweep called the failure a duplicate, advanced the cursor past it, and
    // no pass ever looked at it again. The cursor halting in front of the failure was never the whole
    // repair; it only bought a second look that the row itself then refused to allow.
    const unsellable = await activated("evt_02", "sub_02");
    (unsellable.data as { items: { price: { id: string } }[] }).items = [{ price: { id: "pri_not_in_catalog" } }];

    const first = await sweepPaddle(deps(stream([[await activated("evt_01"), unsellable]])));
    expect(first).toMatchObject({ projected: 1, failed: 1 });

    // The row that makes the retry possible: an error, and **no** `processedAt`. Read as the raw column,
    // because that is the value `fresh` compares.
    const failed = (await webhookRows()).find((row) => row.providerEventId === "evt_02");
    expect(failed?.error).toContain("payments/");
    expect(failed?.processedAt).toBeNull();

    // Next sweep, with whatever it was that broke now fixed — a price added to the catalog, a transient
    // D1 fault gone. The event is fresh again and projects.
    const second = await sweepPaddle(deps(stream([[await activated("evt_02", "sub_02")]])));
    expect(second).toMatchObject({ read: 1, projected: 1, duplicate: 0, failed: 0 });

    expect((await purchases()).map((row) => row.providerTransactionId).sort()).toEqual([SUB, "sub_02"]);
    expect((await cursors())[0]?.cursor).toBe("evt_02");
    // Still one row for it: the retry went through the same `UNIQUE (rail, providerEventId)` insert.
    expect(await webhookRows()).toHaveLength(2);
  });

  test("an event that projected is still a duplicate next sweep, so the retry is not a reprojection", async () => {
    // The other direction, and the one the fix could plausibly break: making everything retryable would
    // reproject every event on every run forever.
    await sweepPaddle(deps(stream([[await activated("evt_01")]])));
    const again = await sweepPaddle(deps(stream([[await activated("evt_01")]])));
    expect(again).toMatchObject({ read: 1, projected: 0, duplicate: 1 });
    const row = (await webhookRows())[0];
    expect(row?.processedAt).not.toBeNull();
  });

  test("a swept full refund revokes, and the refund delivered in two halves revokes too", async () => {
    // Two defects in one row of the database. The sweep passed no transaction reader, so every swept
    // adjustment answered "this deployment cannot read the transaction" and recorded itself handled —
    // which then made the webhook redelivery of the same event id a duplicate the guard skipped. And the
    // map compared one adjustment's own total against the grand total, so a 9900 transaction refunded as
    // two approved 4950 adjustments revoked nothing at all.
    await sweepPaddle(deps(stream([[await activated("evt_01")]])));
    expect((await purchases())[0]).toMatchObject({ providerTransactionId: SUB, status: "active" });

    const transport = streamAndTransaction(
      [
        {
          event_id: "evt_refund",
          event_type: "adjustment.created",
          occurred_at: "2026-08-12T12:00:00Z",
          data: refund("adj_02", "4950"),
        },
      ],
      refundedTransaction([refund("adj_01", "4950"), refund("adj_02", "4950")]),
    );
    const report = await sweepPaddle(deps(transport));
    expect(report).toMatchObject({ read: 1, projected: 1, ignored: 0, failed: 0 });

    // The sweep genuinely asked Paddle for the transaction, and asked for its adjustments with it.
    const read = transport.urls.find((url) => url.includes("/transactions/"));
    expect(read).toContain(TXN);
    expect(read).toContain("include=adjustments");

    const rows = await purchases();
    const charge = rows.find((row) => row.providerTransactionId === TXN);
    const state = rows.find((row) => row.providerTransactionId === SUB);
    expect(charge).toMatchObject({ status: "refunded" });
    expect(charge?.revokedAt).not.toBeNull();
    // A refunded transaction that leaves the subscription standing is a refunded subscriber still holding
    // the feature, so the state row has to move with it.
    expect(state).toMatchObject({ status: "revoked" });
    expect(state?.revokedAt).not.toBeNull();
  });

  test("a partial refund is recorded, notes why, and takes nothing away", async () => {
    // Anti-vacuity for the case above: if everything revoked, that test would pass on a build that
    // revoked on every adjustment, which is worse than the defect it replaces.
    await sweepPaddle(deps(stream([[await activated("evt_01")]])));

    const report = await sweepPaddle(
      deps(
        streamAndTransaction(
          [
            {
              event_id: "evt_partial",
              event_type: "adjustment.created",
              occurred_at: "2026-08-12T12:00:00Z",
              data: refund("adj_01", "4950"),
            },
          ],
          refundedTransaction([refund("adj_01", "4950")]),
        ),
      ),
    );
    expect(report).toMatchObject({ read: 1, projected: 0, ignored: 1, failed: 0 });

    expect((await purchases()).find((row) => row.providerTransactionId === TXN)).toBeUndefined();
    expect((await purchases()).find((row) => row.providerTransactionId === SUB)).toMatchObject({ status: "active" });
    // Recorded with the reason, which is what makes it answerable when the customer asks.
    const recorded = (await webhookRows()).find((row) => row.providerEventId === "evt_partial");
    expect(recorded?.error).toContain("4950");
    expect(recorded?.error).toContain("9900");
  });

  test("a credential-bearing event Paddle returned anyway never becomes a row", async () => {
    // The filter is a request. This is the control. `client_token.created` carries a `token` Paddle does
    // not redact, and `pithy_payments_webhook_events` is a table an operator greps and a backup keeps.
    const TOKEN = "test_c0ffee0000000000000planted";
    const report = await sweepPaddle(
      deps(
        stream([
          [
            {
              event_id: "evt_token",
              event_type: "client_token.created",
              occurred_at: "2026-08-12T09:00:00Z",
              data: { id: "ctkn_01", token: TOKEN },
            },
            await activated("evt_after"),
          ],
        ]),
      ),
    );
    expect(report).toMatchObject({ read: 2, projected: 1, ignored: 1, failed: 0 });

    const rows = await webhookRows();
    // Anti-vacuity: the sweep did write a row this run, so "no row for the token" is the allowlist and
    // not the whole sweep having done nothing.
    expect(rows.map((row) => row.providerEventId)).toEqual(["evt_after"]);
    expect(JSON.stringify(rows)).not.toContain(TOKEN);
    // And the cursor is past it, so the stream is not stuck behind an event nothing will ever record.
    expect((await cursors())[0]?.cursor).toBe("evt_after");
  });

  test("walks more than one page, and stops when Paddle says there is no more", async () => {
    const transport = stream([[await activated("evt_01")], [await activated("evt_02", "sub_02")]]);
    const report = await sweepPaddle(deps(transport));
    expect(report).toMatchObject({ read: 2, projected: 2 });
    expect(transport.urls).toHaveLength(2);
    expect(transport.urls[1]).toContain("after=evt_01");
  });
});
