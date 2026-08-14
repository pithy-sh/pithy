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
import { PADDLE_SWEEP_MAX_ATTEMPTS, sweepPaddle } from "./paddleSweep";

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
async function activated(eventId: string, subscriptionId = SUB, customerId = CUSTOMER) {
  return {
    event_id: eventId,
    event_type: "subscription.activated",
    occurred_at: "2026-08-12T09:00:00Z",
    data: {
      id: subscriptionId,
      status: "active",
      customer_id: customerId,
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

/**
 * A transport that honours `after=`, so consecutive sweeps see the stream the way Paddle serves it.
 *
 * The fixed-page {@link stream} is right for a single run. A case that sweeps three times to watch an
 * attempt count climb needs the second run to resume where the first stopped, and a stub that ignores the
 * cursor would hand it the whole stream again — which is the one thing the assertion is about.
 *
 * `/transactions/` is answered by `transaction`, or refused when it is null. That is how a permanently
 * unreadable event is planted without stubbing anything inside the sweep.
 */
function streamFrom(events: { event_id: string }[], transaction: unknown | null = null): PaddleHttpFetch {
  return (async (url: string, _init?: PaddleHttpRequest) => {
    if (url.includes("/transactions/")) {
      if (transaction === null) return { ok: false, status: 503, text: async () => "{}" };
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: transaction, meta: { pagination: { has_more: false } } }),
      };
    }
    const after = new URL(url).searchParams.get("after");
    const from = after === null ? 0 : events.findIndex((event) => event.event_id === after) + 1;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: events.slice(from), meta: { pagination: { has_more: false } } }),
    };
  }) as PaddleHttpFetch;
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

  /**
   * **The read-derived note, on the sweep's own path.** (#341)
   *
   * The webhook handler is not the only place a note finished a row: this sweep called `complete` with
   * whatever note the rail returned, and the Paddle rail derives one from a transaction read. A 404 there
   * is not a fact about the adjustment — a rotated key, a shared sandbox, and an adjustment swept ahead of
   * its own transaction all produce it — so it goes through the same bound a thrown read already used.
   *
   * The neighbouring partial-refund case is the anti-vacuity: its note comes from a transaction the read
   * *returned*, and it still finishes the row with `ignored: 1`.
   */
  test("an adjustment whose transaction Paddle will not show is repairable, not finished", async () => {
    await sweepPaddle(deps(stream([[await activated("evt_01")]])));

    const absent = (async (url: string) => {
      if (url.includes("/transactions/")) return { ok: false, status: 404, text: async () => "{}" };
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            data: [
              {
                event_id: "evt_unread",
                event_type: "adjustment.created",
                occurred_at: "2026-08-12T12:00:00Z",
                data: refund("adj_01", "9900"),
              },
            ],
            meta: { pagination: { has_more: false } },
          }),
      };
    }) as PaddleHttpFetch;

    const report = await sweepPaddle(deps(absent));
    // Failed, not ignored: an event this build *was* going to act on and could not.
    expect(report).toMatchObject({ read: 1, projected: 0, ignored: 0, failed: 1, quarantined: [] });

    const row = (await webhookRows()).find((event) => event.providerEventId === "evt_unread");
    expect(row?.error).toContain("cannot read");
    expect(row?.processedAt, "a read can be wrong, so its note must not finish the row").toBeNull();
    expect(row?.abandonedAt, "under the bound, so nothing has been given up on yet").toBeNull();
    expect(row?.attempts).toBe(1);

    // And the delivery Paddle is still retrying can repair it, which is the whole point: the guard is not
    // holding a `duplicate` in front of it.
    expect((await webhookRows()).find((event) => event.providerEventId === "evt_unread")?.processedAt).toBeNull();
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

  test("a permanently unprojectable event is quarantined after a bounded number of attempts, and the stream moves on", async () => {
    // The defect the previous fix created by mirroring the one it removed. Leaving `processedAt` null so a
    // failure is retried is right for a *transient* fault. For a permanent one — a malformed event, a
    // deleted transaction, a shape Paddle changed — it halts the cursor in front of that event forever,
    // and then every purchase behind it is the one nothing ever finds. Neither "always skip" nor "always
    // halt" is the answer; a bounded number of attempts, then quarantine, is.
    const unsellable = await activated("evt_02", "sub_02");
    (unsellable.data as { items: { price: { id: string } }[] }).items = [{ price: { id: "pri_not_in_catalog" } }];
    const events = [await activated("evt_01"), unsellable, await activated("evt_03", "sub_03")];

    // Every attempt but the last: the cursor halts in front of the failure, exactly as before.
    for (let attempt = 1; attempt < PADDLE_SWEEP_MAX_ATTEMPTS; attempt += 1) {
      const report = await sweepPaddle(deps(streamFrom(events)));
      expect(report.quarantined, `attempt ${attempt}`).toEqual([]);
      expect((await cursors())[0]?.cursor, `attempt ${attempt}`).toBe("evt_01");
      const row = (await webhookRows()).find((each) => each.providerEventId === "evt_02");
      expect(row?.processedAt, `attempt ${attempt}`).toBeNull();
      expect(row?.attempts, `attempt ${attempt}`).toBe(attempt);
      // Anti-vacuity: `evt_03` really is behind the failure and really is being withheld by it.
      expect((await purchases()).map((each) => each.providerTransactionId)).toEqual([SUB]);
    }

    // The attempt that gives up on it. The cursor advances past the event, and the event behind it — the
    // purchase that was hostage to a fault no retry was ever going to clear — finally projects.
    const last = await sweepPaddle(deps(streamFrom(events)));
    expect(last).toMatchObject({ failed: 1, quarantined: ["evt_02"], projected: 1 });
    expect((await cursors())[0]?.cursor).toBe("evt_03");
    expect((await purchases()).map((each) => each.providerTransactionId).sort()).toEqual([SUB, "sub_03"]);

    // Quarantined, not dropped. The row says so in words, carries its attempt count, and is `abandonedAt`
    // so the next sweep walks past it rather than starting the count again — but **not** `processedAt`,
    // which is what the webhook guard short-circuits on. Giving up is this pass's decision about its own
    // progress; it must not answer for a delivery of the same event (#337).
    const quarantined = (await webhookRows()).find((each) => each.providerEventId === "evt_02");
    expect(quarantined?.abandonedAt).not.toBeNull();
    expect(quarantined?.processedAt).toBeNull();
    expect(quarantined?.attempts).toBe(PADDLE_SWEEP_MAX_ATTEMPTS);
    expect(quarantined?.error).toContain("quarantined");
    expect(quarantined?.error).toContain(String(PADDLE_SWEEP_MAX_ATTEMPTS));
    // And the reason the attempts failed is still in it — a row nobody can diagnose is dropped with extra
    // steps.
    expect(quarantined?.error).toContain("payments/");

    // The next sweep neither retries it nor re-quarantines it: it is behind the cursor and handled.
    const after = await sweepPaddle(deps(streamFrom(events)));
    expect(after).toMatchObject({ read: 0, failed: 0, quarantined: [] });
  });

  test("the attempt bound is small enough that a stall is measured in days, not months", async () => {
    // The sweep runs on a daily cron, so an attempt is a day. A bound of one would be "always skip" — the
    // defect this replaced. A bound in the hundreds would be "always halt" wearing a counter.
    expect(PADDLE_SWEEP_MAX_ATTEMPTS).toBeGreaterThan(1);
    expect(PADDLE_SWEEP_MAX_ATTEMPTS).toBeLessThanOrEqual(7);
  });

  test("a fault that clears before the bound is projected, not quarantined", async () => {
    // The mirror, and the reason the bound is not one. A transient fault must still be repaired by the
    // retry — quarantining a purchase that a second attempt would have found is the original defect back.
    const unsellable = await activated("evt_02", "sub_02");
    (unsellable.data as { items: { price: { id: string } }[] }).items = [{ price: { id: "pri_not_in_catalog" } }];

    const first = await sweepPaddle(deps(streamFrom([await activated("evt_01"), unsellable])));
    expect(first).toMatchObject({ failed: 1, quarantined: [] });

    // Whatever it was is now fixed — a price added to the catalog, a D1 fault gone.
    const second = await sweepPaddle(
      deps(streamFrom([await activated("evt_01"), await activated("evt_02", "sub_02")])),
    );
    expect(second).toMatchObject({ projected: 1, failed: 0, quarantined: [] });

    const row = (await webhookRows()).find((each) => each.providerEventId === "evt_02");
    expect(row?.processedAt).not.toBeNull();
    // Completed rather than quarantined: no error text, and the count left where it stopped climbing.
    expect(row?.error).toBeNull();
    expect(row?.attempts).toBe(1);
  });

  test("one unreadable transaction costs its own event, not the healthy events on its page", async () => {
    // The reader runs inside `sweepPaddleEvents`, which parses every event on the page before returning,
    // and the sweep calls it *outside* the try/catch that guards projection. So one 503 on a transaction
    // read threw away the whole page — including the events ahead of it that had read perfectly.
    const events = [
      await activated("evt_01"),
      {
        event_id: "evt_02",
        event_type: "adjustment.created",
        occurred_at: "2026-08-12T12:00:00Z",
        data: refund("adj_01", "4950"),
      },
      await activated("evt_03", "sub_03"),
    ];

    const report = await sweepPaddle(deps(streamFrom(events)));
    // The healthy event ahead of the failure was projected and its cursor written.
    expect(report).toMatchObject({ projected: 1, failed: 1, quarantined: [] });
    expect((await cursors())[0]?.cursor).toBe("evt_01");
    expect((await purchases()).map((each) => each.providerTransactionId)).toEqual([SUB]);

    // The unreadable event has a row, a reason, and a first attempt against it.
    const failed = (await webhookRows()).find((each) => each.providerEventId === "evt_02");
    expect(failed?.processedAt).toBeNull();
    expect(failed?.error).toContain("payments/provider_unavailable");
    expect(failed?.attempts).toBe(1);
  });

  test("a delivery the guard recorded with an error is repaired by the sweep, not skipped as a duplicate", async () => {
    // The shape `completeWebhook` now leaves behind on every rail: a reason, and **no** `processedAt`,
    // because the delivery arrived and did not project. The sweep reads freshness off the same state the
    // guard does, so this row is outstanding to it and gets tried.
    //
    // The reverse was #337's first consequence: `processedAt` beside the error made the row a duplicate
    // here and a `duplicate: true` at the guard, so no path in this package repaired a failed delivery.
    await env.DB.prepare(
      "INSERT INTO pithy_payments_webhook_events (id, rail, provider_event_id, payload, received_at, processed_at, error, created_at) VALUES (?, 'paddle', 'evt_01', '{}', ?, null, ?, ?)",
    )
      .bind("delivered-and-failed", NOW.getTime(), "projection blew up", NOW.getTime())
      .run();

    const report = await sweepPaddle(deps(stream([[await activated("evt_01")]])));
    expect(report).toMatchObject({ read: 1, projected: 1, duplicate: 0, failed: 0 });
    // The purchase the failed delivery was carrying finally has a row.
    expect(await purchases()).toHaveLength(1);
    // And the row it repaired is the one that was already there, not a second one.
    const rows = await webhookRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "delivered-and-failed", error: null });
    expect(rows[0]?.processedAt).not.toBeNull();
  });

  test("a delivery the guard finished is still a duplicate to the sweep", async () => {
    // The other half, so the case above is "failed is outstanding" rather than "the sweep stopped reading
    // the table". A finished row is behind both readers, and projecting it again would be the double
    // projection `UNIQUE (rail, providerEventId)` exists to prevent.
    await env.DB.prepare(
      "INSERT INTO pithy_payments_webhook_events (id, rail, provider_event_id, payload, received_at, processed_at, error, created_at) VALUES (?, 'paddle', 'evt_01', '{}', ?, ?, null, ?)",
    )
      .bind("delivered-and-done", NOW.getTime(), NOW.getTime(), NOW.getTime())
      .run();

    const report = await sweepPaddle(deps(stream([[await activated("evt_01")]])));
    expect(report).toMatchObject({ read: 1, projected: 0, duplicate: 1, failed: 0 });
    expect(await purchases()).toHaveLength(0);
  });

  test("an abandoned event is not picked back up by the sweep, even with the cursor behind it", async () => {
    // The asymmetry, from the side that could quietly stop holding. `abandonedAt` has to be invisible to
    // *this* pass — otherwise the attempt count restarts on every run and the bound buys nothing — while
    // staying fully visible to a webhook delivery, which is what repairs it.
    //
    // The cursor is the reason this needs its own case. Every other quarantine assertion is satisfied by
    // the cursor having advanced past the event, so a `fresh` that had stopped excluding abandoned rows
    // would pass all of them. Here the cursor is deleted, the sweep is handed the event again, and the
    // claim is about the row alone.
    const unsellable = await activated("evt_01");
    (unsellable.data as { items: { price: { id: string } }[] }).items = [{ price: { id: "pri_not_in_catalog" } }];

    for (let attempt = 1; attempt <= PADDLE_SWEEP_MAX_ATTEMPTS; attempt += 1) {
      await sweepPaddle(deps(stream([[unsellable]])));
    }
    const abandoned = (await webhookRows())[0];
    expect(abandoned?.abandonedAt).not.toBeNull();
    expect(abandoned?.attempts).toBe(PADDLE_SWEEP_MAX_ATTEMPTS);

    await db().deleteFrom("pithyPaymentsSyncCursors").execute();
    const after = await sweepPaddle(deps(stream([[unsellable]])));
    expect(after).toMatchObject({ read: 1, duplicate: 1, failed: 0, quarantined: [] });
    // The count did not climb, so the row was not tried again.
    expect((await webhookRows())[0]?.attempts).toBe(PADDLE_SWEEP_MAX_ATTEMPTS);
  });

  /**
   * **An orphan is walked past, and left repairable.** (#339)
   *
   * The sweep used to `complete` one — `processedAt`, the column the webhook guard short-circuits on — so
   * a sweep that reached an orphan before its delivery did answered the redelivery that follows the account
   * link with `duplicate`, and the purchase was never projected. `routes.workers.test.ts` drives that losing
   * order through both real doors. What this file owns is the sweep's own half: the cursor must still move,
   * because halting in front of an orphan stalls every event behind one customer who never links.
   */
  test("an orphan is abandoned rather than finished, and the cursor still moves past it", async () => {
    // No `pithy_user` stamp, and no `provider_accounts` row: authentic, and nobody to project it against.
    // A customer of its own: the stamped event behind it links *somebody else*, so this case stays about
    // the cursor. An orphan whose customer the same page links is the next case, and it projects.
    const orphan = {
      ...(await activated("evt_orphan", "sub_stray", "ctm_01hv8wptq8987qeep44cystray")),
      data: {
        ...(await activated("evt_orphan", "sub_stray", "ctm_01hv8wptq8987qeep44cystray")).data,
        custom_data: {},
      },
    };

    const report = await sweepPaddle(deps(stream([[orphan, await activated("evt_behind", "sub_02")]])));
    expect(report.orphaned).toEqual(["evt_orphan"]);
    // Not counted as ignored: an ignored event is one this build was never going to act on, and a stuck
    // sale must not read as a healthy number.
    expect(report).toMatchObject({ read: 2, projected: 1, ignored: 0, failed: 0, quarantined: [] });

    const swept = (await webhookRows()).find((row) => row.providerEventId === "evt_orphan");
    expect(swept?.abandonedAt, "the sweep gave up on it, so it says so in its own column").not.toBeNull();
    expect(swept?.processedAt, "an orphan is repairable, so it is not finished").toBeNull();
    expect(swept?.error).toContain("orphaned");
    // No attempt was counted: an orphan is not a failure being retried, and the first look is as informed
    // as the tenth.
    expect(swept?.attempts ?? 0).toBe(0);

    // The stream moved on — the whole reason `fail` is the wrong answer here.
    expect((await cursors())[0]?.cursor).toBe("evt_behind");
    expect((await purchases()).map((row) => row.providerTransactionId)).toEqual(["sub_02"]);

    // And the next run does not pick it up again, so one unlinkable customer is not swept for ever.
    const second = await sweepPaddle(deps(stream([[orphan]])));
    expect(second).toMatchObject({ read: 1, duplicate: 1, orphaned: [] });
  });

  /**
   * **What repairs an abandoned orphan when no delivery ever comes.** (#341)
   *
   * The case above is the sweep walking away and staying away — correct, and for an unlinkable customer it
   * is the end of the story. For a customer who *does* link, it was also the end of the story, and that was
   * the defect: the cursor is past the event, Paddle's three-day retry window closes, and nothing
   * re-examined the row on the one signal that changed anything.
   *
   * The link here is written by the sweep itself, from a stamped event for the same customer — the shape a
   * checkout this deployment initiated actually has. The orphan's own event is never read again.
   */
  test("an orphan is projected when a later event links its customer", async () => {
    const orphan = {
      ...(await activated("evt_orphan", "sub_orphan")),
      data: { ...(await activated("evt_orphan", "sub_orphan")).data, custom_data: {} },
    };

    const first = await sweepPaddle(deps(stream([[orphan]])));
    expect(first.orphaned).toEqual(["evt_orphan"]);
    expect(await purchases()).toEqual([]);

    // A stamped event for the same Paddle customer, in a later run. Its own purchase projects; the link it
    // writes is what the abandoned row was waiting for.
    const report = await sweepPaddle(deps(stream([[await activated("evt_linked", "sub_linked")]])));
    expect(report).toMatchObject({ read: 1, projected: 1, orphaned: [] });

    const rows = await purchases();
    expect(rows.map((row) => row.providerTransactionId).sort()).toEqual(["sub_linked", "sub_orphan"]);
    expect(rows.every((row) => row.userId === "ada")).toBe(true);

    const repaired = (await webhookRows()).find((row) => row.providerEventId === "evt_orphan");
    expect(repaired?.processedAt, "the purchase is projected, so the event is finished").not.toBeNull();
    expect(repaired?.error).toBeNull();
    // Kept: how close this sale came to being lost belongs on the record.
    expect(repaired?.abandonedAt).not.toBeNull();
  });

  test("walks more than one page, and stops when Paddle says there is no more", async () => {
    const transport = stream([[await activated("evt_01")], [await activated("evt_02", "sub_02")]]);
    const report = await sweepPaddle(deps(transport));
    expect(report).toMatchObject({ read: 2, projected: 2 });
    expect(transport.urls).toHaveLength(2);
    expect(transport.urls[1]).toContain("after=evt_01");
  });
});
