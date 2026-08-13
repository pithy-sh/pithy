// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { AuditEventInput } from "@pithy-sh/core/src/audit/auditEvent";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import { openLedger } from "@pithy-sh/ledger/src/ledger";
import { ledger_0001_accounts } from "@pithy-sh/ledger/src/migrations/0001_accounts";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { PaymentsConfig } from "../config/config";
import type { PaymentsPurchase } from "../data/purchase";
import type { PaymentsRail } from "../data/rail";
import { PaymentsProviderUnavailableError, PaymentsVerificationFailedError } from "../error/errors";
import { payments_0001_purchases } from "../migrations/0001_purchases";
import type { ProviderEventInput } from "../projection/event";
import { projectPurchase } from "../projection/writer";
import type { PaymentsRailProvider, UnboundProviderEvent } from "../rails/contract";
import type { ReconcileRailAccess } from "./railAccess";
import { type ReconcileDeps, type ReconcileStep, reconcilePayments } from "./reconcile";

/**
 * The reconciliation pass, against real D1 through Miniflare.
 *
 * The properties worth proving are all about the database rather than the rails: that the keyset scan reaches
 * every row even though reconciling one stops it matching the selection, that a repair goes through the same
 * writer as a webhook so the entitlement moves with it, and that an unreachable store fails the step rather
 * than recording a repair that never happened. The rails themselves are fakes here — each one's real network
 * behaviour is proved in its own suite, and repeating it would test the fake.
 */

const SECOND = 1000;
const DAY = 86_400 * SECOND;
/** "Now" for every run below. */
const T0 = 1_700_000_000_000;

const CONFIG = PaymentsConfig.parse({
  rails: { apple: true, google: true, stripe: true },
  stripe: {
    successUrl: "https://acme.example/thanks",
    cancelUrl: "https://acme.example/pricing",
    portalReturnUrl: "https://acme.example/account",
  },
  products: {
    pro_monthly: {
      type: "subscription",
      name: "Pro monthly",
      entitlements: ["pro"],
      apple: { productId: "com.acme.pro.monthly" },
      google: { productId: "pro_monthly" },
      stripe: { priceId: "price_pro_monthly" },
    },
    remove_ads: {
      type: "non_consumable",
      name: "Remove ads",
      entitlements: ["ads_removed"],
      apple: { productId: "com.acme.removeads" },
    },
  },
});

const TABLES = [
  "pithy_payments_purchases",
  "pithy_payments_entitlements",
  "pithy_payments_provider_accounts",
  "pithy_payments_webhook_events",
  "pithy_payments_reconcile_runs",
  "pithy_payments_sync_cursors",
];

beforeEach(async () => {
  for (const table of TABLES) await env.DB.exec(`DROP TABLE IF EXISTS ${table}`);
  await payments_0001_purchases.up(createDatabase(env.DB, {}) as unknown as Kysely<unknown>);
});

/** Seed one purchase through the real writer, so the row under test is one the projection actually produces. */
async function seed(overrides: Partial<ProviderEventInput> = {}): Promise<PaymentsPurchase> {
  const input: ProviderEventInput = {
    rail: "apple",
    providerTransactionId: "txn-1",
    providerProductId: "com.acme.pro.monthly",
    userId: "ada",
    status: "active",
    environment: "production",
    purchasedAt: new Date(T0 - 30 * DAY),
    expiresAt: new Date(T0 + DAY),
    originalTransactionId: "orig-1",
    providerEventAt: new Date(T0 - 30 * DAY),
    payload: { transactionId: "txn-1" },
    ...overrides,
  };
  const projection = await projectPurchase(env.DB, input, {
    config: CONFIG,
    environment: "production",
    // Written a month ago, so the row is old enough for the stale window as well as the expiry one.
    now: new Date(T0 - 30 * DAY),
  });
  return projection.purchase;
}

/** A rail whose `refresh` returns whatever the case tells it to, recording every purchase it was asked about. */
function fakeRail(
  rail: PaymentsRail,
  refresh: (purchase: PaymentsPurchase) => Promise<UnboundProviderEvent | undefined>,
  asked: string[] = [],
): PaymentsRailProvider {
  return {
    rail,
    verify: async () => {
      throw new Error("not exercised");
    },
    parseNotification: async () => {
      throw new Error("not exercised");
    },
    refresh: async (purchase) => {
      asked.push(purchase.providerTransactionId);
      // `return await`, not `return`: returning the promise makes this frame adopt the rejection, and workerd
      // reports an adopted rejection as unhandled even where the caller catches it. The shipped rails carry
      // the same note for the same reason.
      return await refresh(purchase);
    },
  };
}

/** The refreshed state of a purchase, differing from what is stored only where a case says so. */
function refreshedFrom(
  purchase: PaymentsPurchase,
  overrides: Partial<UnboundProviderEvent> = {},
): UnboundProviderEvent {
  return {
    rail: purchase.rail,
    providerTransactionId: purchase.providerTransactionId,
    providerProductId: purchase.providerProductId,
    status: purchase.status,
    environment: purchase.environment,
    purchasedAt: purchase.purchasedAt,
    expiresAt: purchase.expiresAt,
    revokedAt: purchase.revokedAt,
    originalTransactionId: purchase.originalTransactionId,
    amountMinor: purchase.amountMinor,
    currency: purchase.currency,
    // The clock, as every rail's refresh does — a read of the state now.
    providerEventAt: new Date(T0),
    payload: { refreshed: true },
    ...overrides,
  };
}

/** The step runner a test uses: no journal, no replay, so the body's own ordering is what runs. */
const syncStep: ReconcileStep = { do: (_name, callback) => callback() };

/** A step runner that records the names it was asked for, so replay determinism is assertable. */
function namingStep(names: string[]): ReconcileStep {
  return {
    do: (name, callback) => {
      names.push(name);
      return callback();
    },
  };
}

function deps(
  providers: Partial<Record<PaymentsRail, PaymentsRailProvider>>,
  overrides: Partial<ReconcileDeps> = {},
): ReconcileDeps {
  const access: ReconcileRailAccess = {
    providerFor: async (rail) => {
      const provider = providers[rail];
      if (!provider) throw new PaymentsVerificationFailedError({ detail: `no fake for ${rail}` });
      return provider;
    },
  };
  return {
    d1: env.DB,
    config: CONFIG,
    environment: "production",
    railAccess: () => access,
    now: () => new Date(T0),
    ...overrides,
  };
}

async function statusOf(providerTransactionId: string): Promise<string | undefined> {
  const row = await env.DB.prepare("select status from pithy_payments_purchases where provider_transaction_id = ?")
    .bind(providerTransactionId)
    .first<{ status: string }>();
  return row?.status ?? undefined;
}

async function entitlementRows(): Promise<{ entitlement: string; active: number }[]> {
  const { results } = await env.DB.prepare(
    "select entitlement, active from pithy_payments_entitlements order by entitlement",
  ).all<{ entitlement: string; active: number }>();
  return results;
}

describe("reconcilePayments", () => {
  test("asks the rail about a subscription near its expiry and reports it unchanged when it agrees", async () => {
    const purchase = await seed();
    const asked: string[] = [];
    const report = await reconcilePayments(
      deps({ apple: fakeRail("apple", async (row) => refreshedFrom(row), asked) }),
      syncStep,
    );

    expect(asked).toEqual([purchase.providerTransactionId]);
    expect(report).toMatchObject({ scanned: 1, unchanged: 1, drifted: 0, skipped: 0, failed: 0 });
  });

  test("repairs drift through the same writer, so the entitlement moves in the same commit", async () => {
    // The whole design's claim: one idempotent projection, three triggers. A repair is not a status update —
    // it re-derives the read model, which is why a subscription found lapsed stops granting immediately.
    await seed();
    expect(await entitlementRows()).toEqual([{ entitlement: "pro", active: 1 }]);

    const report = await reconcilePayments(
      deps({
        apple: fakeRail("apple", async (row) =>
          refreshedFrom(row, { status: "expired", expiresAt: new Date(T0 - DAY) }),
        ),
      }),
      syncStep,
    );

    expect(report).toMatchObject({ drifted: 1, unchanged: 0 });
    expect(await statusOf("txn-1")).toBe("expired");
    expect(await entitlementRows()).toEqual([{ entitlement: "pro", active: 0 }]);
  });

  test("a renewal nobody was notified about is picked up and grants again", async () => {
    // The drift that matters most: the row says the period ended, and the store says it renewed. Nothing
    // arrived to say so, so nothing but this pass would ever find it.
    await seed({ status: "active", expiresAt: new Date(T0 - DAY) });
    const report = await reconcilePayments(
      deps({
        apple: fakeRail("apple", async (row) => refreshedFrom(row, { expiresAt: new Date(T0 + 30 * DAY) })),
      }),
      syncStep,
    );

    expect(report.drifted).toBe(1);
    expect(await entitlementRows()).toEqual([{ entitlement: "pro", active: 1 }]);
  });

  test("audits every repair, because repeated drift means the webhook path is broken", async () => {
    await seed();
    const events: AuditEventInput[] = [];
    await reconcilePayments(
      deps(
        { apple: fakeRail("apple", async (row) => refreshedFrom(row, { status: "canceled" })) },
        {
          emit: async (event) => {
            events.push(event);
          },
        },
      ),
      syncStep,
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "payments/purchase_reconciled",
      severity: "warning",
      actorType: "service",
      metadata: { rail: "apple", productId: "pro_monthly", from: "active", to: "canceled" },
    });
  });

  test("a run that finds nothing wrong audits nothing", async () => {
    await seed();
    const events: AuditEventInput[] = [];
    await reconcilePayments(
      deps(
        { apple: fakeRail("apple", async (row) => refreshedFrom(row)) },
        {
          emit: async (event) => {
            events.push(event);
          },
        },
      ),
      syncStep,
    );
    expect(events).toEqual([]);
  });

  test("a dry run reports the drift and writes nothing", async () => {
    await seed();
    const report = await reconcilePayments(
      deps({ apple: fakeRail("apple", async (row) => refreshedFrom(row, { status: "expired" })) }),
      syncStep,
      { dryRun: true },
    );

    expect(report).toMatchObject({ drifted: 1, dryRun: true });
    expect(await statusOf("txn-1")).toBe("active");
    expect(await entitlementRows()).toEqual([{ entitlement: "pro", active: 1 }]);
  });

  test("pages by keyset, so reconciling a row cannot make the scan skip the next one", async () => {
    // The correctness argument for the whole file. Every row here stops matching the selection the moment it
    // is reconciled, so an OFFSET-paged scan would step over half of them.
    for (let index = 0; index < 5; index += 1) {
      await seed({ providerTransactionId: `txn-${index}`, originalTransactionId: `orig-${index}` });
    }

    const asked: string[] = [];
    const report = await reconcilePayments(
      deps({
        apple: fakeRail(
          "apple",
          // Every refresh pushes the expiry far out, which is exactly what stops the row matching again.
          async (row) => refreshedFrom(row, { expiresAt: new Date(T0 + 365 * DAY) }),
          asked,
        ),
      }),
      syncStep,
      { pageSize: 2 },
    );

    expect(asked.sort()).toEqual(["txn-0", "txn-1", "txn-2", "txn-3", "txn-4"]);
    expect(report).toMatchObject({ scanned: 5, drifted: 5 });
    // Three full-ish pages plus the short one that ends the run.
    expect(report.pages).toBe(3);
  });

  test("step names are derived from a page counter, so a replay asks for the same ones in the same order", async () => {
    for (let index = 0; index < 3; index += 1) {
      await seed({ providerTransactionId: `txn-${index}`, originalTransactionId: `orig-${index}` });
    }
    const names: string[] = [];
    await reconcilePayments(deps({ apple: fakeRail("apple", async (row) => refreshedFrom(row)) }), namingStep(names), {
      pageSize: 2,
    });
    // Zero-padded so a journal read by a human sorts the way the pages ran.
    // `start-run` first: the id and the clock are journalled together, so a replay reads back the ones the
    // pages were repaired under rather than minting a second id (#328) on a newer clock (#331).
    // `record-run` last, always: the run record is written after the pages so a row can never claim a
    // finish time the pass had not reached (#316).
    expect(names).toEqual(["start-run", "page-000001", "page-000002", "record-run"]);
  });

  test("stops at the page cap and says so, rather than running until it is killed", async () => {
    for (let index = 0; index < 4; index += 1) {
      await seed({ providerTransactionId: `txn-${index}`, originalTransactionId: `orig-${index}` });
    }
    const report = await reconcilePayments(
      deps({ apple: fakeRail("apple", async (row) => refreshedFrom(row)) }),
      syncStep,
      { pageSize: 1, maxPages: 2 },
    );
    expect(report).toMatchObject({ pages: 2, scanned: 2, truncated: true });
  });

  test("a store that cannot be reached fails the step, so the Workflow retries instead of recording a repair", async () => {
    await seed();
    await expect(
      reconcilePayments(
        deps({
          apple: fakeRail("apple", async () => {
            throw new PaymentsProviderUnavailableError({ detail: "Apple did not answer." });
          }),
        }),
        syncStep,
      ),
    ).rejects.toBeInstanceOf(PaymentsProviderUnavailableError);
  });

  test("every other refusal is counted, so one bad row does not end the pass", async () => {
    await seed({ providerTransactionId: "txn-bad", originalTransactionId: "orig-bad" });
    await seed({ providerTransactionId: "txn-good", originalTransactionId: "orig-good" });

    const report = await reconcilePayments(
      deps({
        apple: fakeRail("apple", async (row) => {
          if (row.providerTransactionId === "txn-bad") {
            throw new PaymentsVerificationFailedError({ detail: "a state this build does not map" });
          }
          return refreshedFrom(row, { status: "canceled" });
        }),
      }),
      syncStep,
    );

    expect(report).toMatchObject({ scanned: 2, failed: 1, drifted: 1 });
    expect(await statusOf("txn-good")).toBe("canceled");
    expect(await statusOf("txn-bad")).toBe("active");
  });

  test("a purchase the store cannot address is skipped, and the row stands", async () => {
    await seed();
    const report = await reconcilePayments(deps({ apple: fakeRail("apple", async () => undefined) }), syncStep);
    expect(report).toMatchObject({ scanned: 1, skipped: 1, drifted: 0 });
    expect(await statusOf("txn-1")).toBe("active");
  });

  test("a rail with no credentials skips its purchases once, not once per purchase", async () => {
    // `providerFor` throws for the whole page, and the memoized promise is what keeps a hundred rows on a
    // switched-off rail from attempting a hundred mints.
    await seed();
    const report = await reconcilePayments(deps({}), syncStep);
    expect(report).toMatchObject({ scanned: 1, failed: 1 });
  });

  test("one-time purchases are never scanned — nothing about them drifts", async () => {
    await seed({
      providerTransactionId: "txn-ads",
      providerProductId: "com.acme.removeads",
      originalTransactionId: null,
      expiresAt: null,
      status: "active",
    });
    const asked: string[] = [];
    const report = await reconcilePayments(
      deps({ apple: fakeRail("apple", async (row) => refreshedFrom(row), asked) }),
      syncStep,
    );
    expect(report.scanned).toBe(0);
    expect(asked).toEqual([]);
  });

  test("terminal states are never re-asked — a resubscription is a new transaction, and a new row", async () => {
    for (const status of ["expired", "never_paid", "refunded", "revoked"] as const) {
      await seed({ providerTransactionId: `txn-${status}`, originalTransactionId: `orig-${status}`, status });
    }
    const report = await reconcilePayments(
      deps({ apple: fakeRail("apple", async (row) => refreshedFrom(row)) }),
      syncStep,
    );
    expect(report.scanned).toBe(0);
  });

  test("a subscription neither near expiry nor stale is left alone", async () => {
    await projectPurchase(
      env.DB,
      {
        rail: "apple",
        providerTransactionId: "txn-fresh",
        providerProductId: "com.acme.pro.monthly",
        userId: "ada",
        status: "active",
        environment: "production",
        purchasedAt: new Date(T0 - DAY),
        expiresAt: new Date(T0 + 300 * DAY),
        originalTransactionId: "orig-fresh",
        providerEventAt: new Date(T0 - DAY),
        payload: {},
      },
      { config: CONFIG, environment: "production", now: new Date(T0 - DAY) },
    );

    const report = await reconcilePayments(
      deps({ apple: fakeRail("apple", async (row) => refreshedFrom(row)) }),
      syncStep,
    );
    expect(report.scanned).toBe(0);
  });

  test("a stale subscription far from expiry is picked up by the second window", async () => {
    // A refund, a pause, a revocation whose notification never arrived: all change a subscription mid-period
    // and date nothing about its expiry, so the expiry window alone would never look.
    await projectPurchase(
      env.DB,
      {
        rail: "apple",
        providerTransactionId: "txn-stale",
        providerProductId: "com.acme.pro.monthly",
        userId: "ada",
        status: "active",
        environment: "production",
        purchasedAt: new Date(T0 - 300 * DAY),
        expiresAt: new Date(T0 + 300 * DAY),
        originalTransactionId: "orig-stale",
        providerEventAt: new Date(T0 - 300 * DAY),
        payload: {},
      },
      { config: CONFIG, environment: "production", now: new Date(T0 - 300 * DAY) },
    );

    const report = await reconcilePayments(
      deps({ apple: fakeRail("apple", async (row) => refreshedFrom(row, { status: "revoked" })) }),
      syncStep,
    );
    expect(report).toMatchObject({ scanned: 1, drifted: 1 });
  });

  test("narrows to one user — the same steps, which is what makes it the support tool", async () => {
    await seed({ userId: "ada", providerTransactionId: "txn-ada", originalTransactionId: "orig-ada" });
    await seed({ userId: "grace", providerTransactionId: "txn-grace", originalTransactionId: "orig-grace" });

    const asked: string[] = [];
    const report = await reconcilePayments(
      deps({ apple: fakeRail("apple", async (row) => refreshedFrom(row), asked) }),
      syncStep,
      { userId: "ada" },
    );
    expect(asked).toEqual(["txn-ada"]);
    expect(report.scanned).toBe(1);
  });

  test("narrows to one rail, so a single store's outage does not cost the other two", async () => {
    await seed({ providerTransactionId: "txn-apple", originalTransactionId: "orig-apple" });
    await seed({
      rail: "google",
      providerTransactionId: "txn-google",
      providerProductId: "pro_monthly",
      originalTransactionId: "orig-google",
    });

    const asked: string[] = [];
    const report = await reconcilePayments(
      deps({ google: fakeRail("google", async (row) => refreshedFrom(row), asked) }),
      syncStep,
      { rail: "google" },
    );
    expect(asked).toEqual(["txn-google"]);
    expect(report.scanned).toBe(1);
  });

  test("running twice over a reconciled catalog changes nothing the second time", async () => {
    // Idempotent by construction: the pass is safe to retry, to re-trigger after a cron, and to run twice by
    // hand. The second run finds the row already matching and writes nothing.
    await seed();
    const rail = fakeRail("apple", async (row) => refreshedFrom(row, { status: "canceled" }));

    const first = await reconcilePayments(deps({ apple: rail }), syncStep);
    const second = await reconcilePayments(deps({ apple: rail }), syncStep);

    expect(first.drifted).toBe(1);
    expect(second).toMatchObject({ drifted: 0, unchanged: 1 });
    expect(await statusOf("txn-1")).toBe("canceled");
  });

  test("a refresh never rebinds an owner — the user comes from the row, never from the rail", async () => {
    await seed({ userId: "ada" });
    await reconcilePayments(
      deps({ apple: fakeRail("apple", async (row) => refreshedFrom(row, { status: "canceled" })) }),
      syncStep,
    );
    const row = await env.DB.prepare("select user_id from pithy_payments_purchases where provider_transaction_id = ?")
      .bind("txn-1")
      .first<{ user_id: string }>();
    expect(row?.user_id).toBe("ada");
  });

  test("an empty catalog is one cheap page and a clean report", async () => {
    const report = await reconcilePayments(deps({}), syncStep);
    expect(report).toMatchObject({ pages: 1, scanned: 0, drifted: 0, truncated: false });
  });
});

/**
 * Fulfillment on repair.
 *
 * A renewal the webhook never delivered is exactly what this pass exists to find — and a `grants` product's
 * coins have to be credited by whoever finds the period, because nothing else ever will. Before this, the pass
 * projected the purchase and silently credited nothing.
 */
describe("reconcilePayments — fulfillment", () => {
  test("a renewal found only by reconciliation is fulfilled, not just projected", async () => {
    const purchase = await seed();
    const fulfilled: string[] = [];
    const report = await reconcilePayments(
      deps(
        { apple: fakeRail("apple", async (p) => refreshedFrom(p, { expiresAt: new Date(T0 + 31 * DAY) })) },
        { fulfill: async (projection) => void fulfilled.push(projection.purchase.id) },
      ),
      syncStep,
    );
    expect(report.drifted).toBe(1);
    expect(fulfilled).toEqual([purchase.id]);
  });

  test("a purchase the store agrees about is not fulfilled again", async () => {
    // Every rail dates a refresh `now`, so the writer reports `updated` for every row a pass touches. Keying
    // fulfillment on that would mean one ledger call per scanned row per pass, each a no-op. Drift is the
    // signal that tells a repair from a confirmation.
    await seed();
    const fulfilled: string[] = [];
    const report = await reconcilePayments(
      deps(
        { apple: fakeRail("apple", async (p) => refreshedFrom(p)) },
        { fulfill: async (projection) => void fulfilled.push(projection.purchase.id) },
      ),
      syncStep,
    );
    expect(report.unchanged).toBe(1);
    expect(fulfilled).toEqual([]);
  });

  test("a dry run fulfils nothing — it writes nothing at all", async () => {
    await seed();
    const fulfilled: string[] = [];
    const report = await reconcilePayments(
      deps(
        { apple: fakeRail("apple", async (p) => refreshedFrom(p, { expiresAt: new Date(T0 + 31 * DAY) })) },
        { fulfill: async (projection) => void fulfilled.push(projection.purchase.id) },
      ),
      syncStep,
      { dryRun: true },
    );
    expect(report.drifted).toBe(1);
    expect(fulfilled).toEqual([]);
  });

  test("a credit that will not land counts the row as failed, and the repair still stands", async () => {
    // The purchase is repaired and audited before fulfillment is attempted, so a refused credit is a row that
    // needs a human rather than a reconciliation that did not happen. The next pass retries the same ref.
    const purchase = await seed();
    const report = await reconcilePayments(
      deps(
        { apple: fakeRail("apple", async (p) => refreshedFrom(p, { expiresAt: new Date(T0 + 31 * DAY) })) },
        {
          fulfill: async () => {
            throw new PaymentsVerificationFailedError({ detail: "the ledger refused" });
          },
        },
      ),
      syncStep,
    );
    expect(report.failed).toBe(1);
    expect(report.drifted).toBe(0);

    // The repair itself is in the database — the purchase moved even though the credit did not.
    const row = await env.DB.prepare("SELECT expires_at FROM pithy_payments_purchases WHERE id = ?")
      .bind(purchase.id)
      .first<{ expires_at: number }>();
    expect(row?.expires_at).toBe(T0 + 31 * DAY);
  });
});

/**
 * Superseded rows.
 *
 * Every rail's `refresh` answers about the **family's current** transaction, not the row it was asked about.
 * So a renewal writes a new row and leaves the old one matching the selection forever: each pass re-asked the
 * store about it, compared it against its own successor, and reported drift. After a year one monthly
 * subscriber contributed twelve permanently drifting rows — and `drifted` is supposed to be the signal that
 * webhooks are being lost, so it was measuring how long the catalog had been selling instead.
 */
describe("reconcilePayments — superseded rows", () => {
  /**
   * What every real rail answers with: the family's CURRENT transaction, whichever row it was asked about.
   * That the shared `refreshedFrom` echoes back the row it was handed is exactly why this went unseen.
   */
  function currentFamilyState(overrides: Partial<UnboundProviderEvent> = {}): UnboundProviderEvent {
    return {
      rail: "apple",
      providerTransactionId: "txn-2",
      providerProductId: "com.acme.pro.monthly",
      status: "active",
      environment: "production",
      purchasedAt: new Date(T0 - 29 * DAY),
      expiresAt: new Date(T0 + DAY),
      revokedAt: null,
      originalTransactionId: "orig-1",
      amountMinor: null,
      currency: null,
      providerEventAt: new Date(T0),
      payload: { refreshed: true },
      ...overrides,
    };
  }

  /** The renewal that replaced `seed()`'s period: same family, bought later, its own transaction id. */
  async function renew(): Promise<void> {
    await projectPurchase(
      env.DB,
      {
        rail: "apple",
        providerTransactionId: "txn-2",
        providerProductId: "com.acme.pro.monthly",
        userId: "ada",
        status: "active",
        environment: "production",
        purchasedAt: new Date(T0 - 29 * DAY),
        expiresAt: new Date(T0 + DAY),
        originalTransactionId: "orig-1",
        providerEventAt: new Date(T0 - 29 * DAY),
        payload: { transactionId: "txn-2" },
      },
      { config: CONFIG, environment: "production", now: new Date(T0 - 29 * DAY) },
    );
  }

  test("an old period is settled once, not reported as drift against its own successor", async () => {
    await seed();
    await renew();
    const report = await reconcilePayments(
      deps({ apple: fakeRail("apple", async () => currentFamilyState()) }),
      syncStep,
    );
    // Both rows are scanned. The old one is superseded; the current one agrees with the store.
    expect(report).toMatchObject({ scanned: 2, superseded: 1, unchanged: 1, drifted: 0 });
    expect(await statusOf("txn-1")).toBe("expired");
    expect(await statusOf("txn-2")).toBe("active");
  });

  test("a settled row is terminal, so no later pass asks the store about it again", async () => {
    await seed();
    await renew();
    const asked: string[] = [];
    const rail = () => fakeRail("apple", async () => currentFamilyState(), asked);

    await reconcilePayments(deps({ apple: rail() }), syncStep);
    await reconcilePayments(deps({ apple: rail() }), syncStep);
    await reconcilePayments(deps({ apple: rail() }), syncStep);

    // Three passes, and the ended period was asked about exactly once. Before it was settled, every pass
    // re-asked and re-reported it as drift, for as long as the subscription had ever existed.
    expect(asked.filter((id) => id === "txn-1")).toEqual(["txn-1"]);
    // The live period is still watched every pass, which is the point of the scan.
    expect(asked.filter((id) => id === "txn-2")).toHaveLength(3);
  });

  test("the current period still drifts normally when the store moves it", async () => {
    await seed();
    await renew();
    const report = await reconcilePayments(
      // One answer for both rows, as a rail gives: the family's current transaction, whose expiry has moved.
      deps({ apple: fakeRail("apple", async () => currentFamilyState({ expiresAt: new Date(T0 + 31 * DAY) })) }),
      syncStep,
    );
    expect(report).toMatchObject({ scanned: 2, superseded: 1, drifted: 1 });
  });

  test("a dry run settles nothing", async () => {
    await seed();
    await renew();
    const report = await reconcilePayments(
      deps({ apple: fakeRail("apple", async () => currentFamilyState()) }),
      syncStep,
      { dryRun: true },
    );
    expect(report.superseded).toBe(1);
    expect(await statusOf("txn-1")).toBe("active");
  });
});

/**
 * Fulfillment through the **real** closure, with no `fulfill` override.
 *
 * The four tests above this file's fulfillment block all inject a spy, and every drift test runs against a
 * catalog with no `grants.ledger` — so `fulfillPurchase` short-circuits before it reaches the ledger seam and
 * the default closure is never actually exercised. Delete the `fulfill(projection)` call from `reconcile.ts`
 * and all of them stay green. This is the one that would not.
 */
describe("reconcilePayments — the default fulfillment path", () => {
  const COINS = PaymentsConfig.parse({
    rails: { apple: true },
    products: {
      pro_monthly: {
        type: "subscription",
        name: "Pro monthly",
        entitlements: ["pro"],
        // A subscription that pays out per period — the case where a lost renewal webhook costs a real balance.
        grants: { ledger: { currency: "coins", amount: 100 } },
        apple: { productId: "com.acme.pro.monthly" },
      },
    },
  });

  beforeEach(async () => {
    for (const table of ["pithy_ledger_accounts", "pithy_ledger_transactions", "pithy_ledger_holds"]) {
      await env.DB.exec(`DROP TABLE IF EXISTS ${table}`);
    }
    await ledger_0001_accounts.up(createDatabase(env.DB, {}) as unknown as Kysely<unknown>);
  });

  const balance = () => openLedger(env.DB, () => T0).balance("ada", "coins");

  test("a renewal found only by reconciliation credits the balance, through the real closure", async () => {
    // The purchase exists at its old period; the renewal notification never arrived.
    await projectPurchase(
      env.DB,
      {
        rail: "apple",
        providerTransactionId: "txn-1",
        providerProductId: "com.acme.pro.monthly",
        userId: "ada",
        status: "active",
        environment: "production",
        purchasedAt: new Date(T0 - 30 * DAY),
        expiresAt: new Date(T0 + DAY),
        originalTransactionId: "orig-1",
        providerEventAt: new Date(T0 - 30 * DAY),
        payload: {},
      },
      { config: COINS, environment: "production", now: new Date(T0 - 30 * DAY) },
    );
    expect((await balance()).balance).toBe(0);

    const report = await reconcilePayments(
      deps(
        {
          apple: fakeRail("apple", async (purchase) => refreshedFrom(purchase, { expiresAt: new Date(T0 + 31 * DAY) })),
        },
        { config: COINS },
      ),
      syncStep,
    );

    expect(report.drifted).toBe(1);
    // The whole point of the fix this pins: the period was repaired AND paid for.
    expect((await balance()).balance).toBe(100);
  });

  test("a second pass credits nothing more — the ref is a pure function of the purchase", async () => {
    await projectPurchase(
      env.DB,
      {
        rail: "apple",
        providerTransactionId: "txn-1",
        providerProductId: "com.acme.pro.monthly",
        userId: "ada",
        status: "active",
        environment: "production",
        purchasedAt: new Date(T0 - 30 * DAY),
        expiresAt: new Date(T0 + DAY),
        originalTransactionId: "orig-1",
        providerEventAt: new Date(T0 - 30 * DAY),
        payload: {},
      },
      { config: COINS, environment: "production", now: new Date(T0 - 30 * DAY) },
    );
    const rail = () =>
      fakeRail("apple", async (purchase) => refreshedFrom(purchase, { expiresAt: new Date(T0 + 31 * DAY) }));

    await reconcilePayments(deps({ apple: rail() }, { config: COINS }), syncStep);
    await reconcilePayments(deps({ apple: rail() }, { config: COINS }), syncStep);

    // A webhook that also delivered this renewal would have credited against the same ref, and the ledger's
    // UNIQUE (ref) is what makes the second attempt free rather than a double payout.
    expect((await balance()).balance).toBe(100);
  });
});

/**
 * The run record (#316) — the pass, kept where somebody can query it.
 *
 * Reconciliation is the compensating control for a delivery mechanism that is known to fail, and before this
 * it left nothing behind but log lines: *"has it been running"* had no answer, and *"what did it fix last
 * month"* had none at all. A nightly job that is silent and a nightly job that has stopped look identical,
 * which is what these tests are about.
 */
describe("the run record", () => {
  async function runs(): Promise<Record<string, unknown>[]> {
    const { results } = await env.DB.prepare(
      "select * from pithy_payments_reconcile_runs order by started_at desc",
    ).all<Record<string, unknown>>();
    return results;
  }

  test("a pass that repaired something records its tally", async () => {
    const purchase = await seed();
    const report = await reconcilePayments(
      deps({ apple: fakeRail("apple", async (row) => refreshedFrom(row, { status: "expired" })) }),
      syncStep,
    );

    const [row] = await runs();
    expect(row?.id).toBe(report.runId);
    expect(row?.scanned).toBe(1);
    expect(row?.drifted).toBe(1);
    expect(row?.failed).toBe(0);
    expect(row?.environment).toBe("production");
    // Null is the scheduled behaviour: this pass named no rail, so it was about every enabled one.
    expect(row?.rail).toBeNull();
    expect(row?.started_at).toBe(T0);
    expect(purchase.id).toBeDefined();
  });

  test("a pass that found nothing is recorded too, so silence is not ambiguous", async () => {
    // The load-bearing half. Storing only the passes that repaired something makes "no rows" mean either
    // "healthy" or "the cron stopped firing", and those are the two answers an operator must tell apart.
    const report = await reconcilePayments(deps({}), syncStep);
    const [row] = await runs();
    expect(await runs()).toHaveLength(1);
    expect(row?.id).toBe(report.runId);
    expect(row?.scanned).toBe(0);
    expect(row?.drifted).toBe(0);
  });

  test("a pass narrowed to one rail records which one", async () => {
    await seed();
    await reconcilePayments(deps({ apple: fakeRail("apple", async (row) => refreshedFrom(row)) }), syncStep, {
      rail: "apple",
    });
    expect((await runs())[0]?.rail).toBe("apple");
  });

  test("a dry run says so, so its `drifted` reads as a finding rather than a fix", async () => {
    await seed();
    await reconcilePayments(
      deps({ apple: fakeRail("apple", async (row) => refreshedFrom(row, { status: "expired" })) }),
      syncStep,
      { dryRun: true },
    );
    const [row] = await runs();
    expect(row?.dry_run).toBe(1);
    expect(row?.drifted).toBe(1);
  });

  test("every repair the pass audited names the run, so the run points at the trail rather than copying it", async () => {
    // AC: the audit trail is not duplicated. The runs table holds the tally; the repairs stay in the trail,
    // once, and `runId` is the join. A run record carrying its repairs would be a second audit trail with
    // different access rules — the mistake `admin/coverage.ts` refuses on the webhook log.
    await seed();
    const emitted: AuditEventInput[] = [];
    const report = await reconcilePayments(
      deps(
        { apple: fakeRail("apple", async (row) => refreshedFrom(row, { status: "expired" })) },
        {
          emit: async (event) => {
            emitted.push(event);
          },
        },
      ),
      syncStep,
    );

    const repairs = emitted.filter((event) => event.action === "payments/purchase_reconciled");
    expect(repairs).toHaveLength(1);
    expect(repairs[0]?.metadata?.runId).toBe(report.runId);
    // And the run holds no copy of them: the row's columns are counts, times and enums.
    const [row] = await runs();
    expect(Object.keys(row ?? {}).some((column) => /repair|purchase|payload/.test(column))).toBe(false);
  });

  test("a replayed step lands on the row it already wrote rather than counting one pass twice", async () => {
    // A Workflow step that wrote the row and then failed to journal its result replays the whole body.
    await seed();
    const replayingStep: ReconcileStep = {
      do: async (name, callback) => {
        const first = await callback();
        return name === "record-run" ? await callback() : first;
      },
    };
    await reconcilePayments(deps({ apple: fakeRail("apple", async (row) => refreshedFrom(row)) }), replayingStep);
    expect(await runs()).toHaveLength(1);
  });

  test("the record is written last, after every page — a run never claims a finish it had not reached", async () => {
    const names: string[] = [];
    await reconcilePayments(deps({}), namingStep(names), {});
    expect(names[names.length - 1]).toBe("record-run");
  });
});

/**
 * Replay (#328).
 *
 * A Workflow does not resume inside the step it died in — it **re-executes the driver body from the top**, and
 * every step it already completed returns its journalled value instead of running again. So anything the body
 * computes outside a step is computed a second time, on the newer clock, with a fresh `crypto`. That is fine
 * for the cutoffs, which the module doc argues for deliberately. It is not fine for the run id: the pages that
 * already ran audited their repairs under the first one, and a second mint makes the run record name an id no
 * repair carries. The run stops pointing at its own work, and the join the runs table exists for is broken.
 *
 * These drive the real thing — run, interrupt, resume against the same journal — rather than asserting about
 * replay from a single pass. A step runner that only re-invokes one callback cannot see this defect, because
 * the mint is not in a callback.
 */
describe("reconcilePayments — a replayed run", () => {
  /** The interruption a resumed Workflow is the recovery from. Not a `PithyError`: this is the platform. */
  class Interrupted extends Error {}

  /**
   * The Workflow journal, structurally: a completed step returns what it returned the first time, and a step
   * never reached runs. `interruptBefore` kills the run just before a named step, once, so the next call to
   * `reconcilePayments` over the same journal is a genuine resume.
   */
  function journalledStep(journal: Map<string, unknown>, interruptBefore?: string): ReconcileStep & { armed: boolean } {
    const runner = {
      armed: interruptBefore !== undefined,
      async do<T>(name: string, callback: () => Promise<T>): Promise<T> {
        if (journal.has(name)) return journal.get(name) as T;
        if (runner.armed && name === interruptBefore) {
          runner.armed = false;
          throw new Interrupted(`the run died before ${name}`);
        }
        const result = await callback();
        journal.set(name, result);
        return result;
      },
    };
    return runner;
  }

  /** Every repair the pass audited, by the run id its event carries. */
  function auditedRunIds(events: AuditEventInput[]): unknown[] {
    return events.filter((event) => event.action === "payments/purchase_reconciled").map((e) => e.metadata?.runId);
  }

  async function recordedRunIds(): Promise<string[]> {
    const { results } = await env.DB.prepare("select id from pithy_payments_reconcile_runs").all<{ id: string }>();
    return results.map((row) => row.id);
  }

  test("the recorded run is the one its repairs were written under", async () => {
    // Three rows, one page each, so the interruption lands with real repairs already audited behind it.
    for (let index = 0; index < 3; index += 1) {
      await seed({ providerTransactionId: `txn-${index}`, originalTransactionId: `orig-${index}` });
    }
    const events: AuditEventInput[] = [];
    // A minter that answers differently every time, which is what `crypto.randomUUID` does on the live path.
    let minted = 0;
    const mint = () => {
      minted += 1;
      return `run-${minted}`;
    };
    const runDeps = deps(
      { apple: fakeRail("apple", async (row) => refreshedFrom(row, { status: "canceled" })) },
      {
        newId: mint,
        emit: async (event) => {
          events.push(event);
        },
      },
    );

    const journal = new Map<string, unknown>();
    await expect(
      reconcilePayments(runDeps, journalledStep(journal, "page-000002"), { pageSize: 1 }),
    ).rejects.toBeInstanceOf(Interrupted);
    // The interruption is real: one page ran, one repair is on the trail, and no run has been recorded.
    expect(auditedRunIds(events)).toHaveLength(1);
    expect(await recordedRunIds()).toEqual([]);

    const report = await reconcilePayments(runDeps, journalledStep(journal), { pageSize: 1 });

    // One id for the whole pass: the record, the report, and every repair either half of it audited.
    expect(await recordedRunIds()).toEqual([report.runId]);
    expect(new Set(auditedRunIds(events))).toEqual(new Set([report.runId]));
  });

  test("the id survives a resume even when nothing was repaired before the interruption", async () => {
    // The report is the run's own summary, so a resumed pass must not return an id different from the row it
    // wrote — a caller that logged the returned id would name a run the table does not hold.
    await seed();
    let minted = 0;
    const runDeps = deps(
      { apple: fakeRail("apple", async (row) => refreshedFrom(row)) },
      {
        newId: () => {
          minted += 1;
          return `run-${minted}`;
        },
      },
    );

    const journal = new Map<string, unknown>();
    await expect(reconcilePayments(runDeps, journalledStep(journal, "record-run"), {})).rejects.toBeInstanceOf(
      Interrupted,
    );
    const report = await reconcilePayments(runDeps, journalledStep(journal), {});

    expect(report.runId).toBe("run-1");
    expect(await recordedRunIds()).toEqual(["run-1"]);
  });

  test("a resumed run does not re-ask the store about a page the journal already holds", async () => {
    // The journal is doing what a journal does, so the assertions above are about the id rather than about a
    // pass that quietly ran twice.
    for (let index = 0; index < 3; index += 1) {
      await seed({ providerTransactionId: `txn-${index}`, originalTransactionId: `orig-${index}` });
    }
    const asked: string[] = [];
    const runDeps = deps({ apple: fakeRail("apple", async (row) => refreshedFrom(row), asked) });

    const journal = new Map<string, unknown>();
    await expect(
      reconcilePayments(runDeps, journalledStep(journal, "page-000003"), { pageSize: 1 }),
    ).rejects.toBeInstanceOf(Interrupted);
    expect(asked).toHaveLength(2);
    await reconcilePayments(runDeps, journalledStep(journal), { pageSize: 1 });

    // Three, not five: the two completed pages came back from the journal and asked nothing.
    expect(asked).toHaveLength(3);
  });

  /**
   * The clock, journalled — the same rule as the id, one field over (#331).
   *
   * `now` is the pass's comparison instant *and* the instant it writes as `startedAt`, and it was read in the
   * driver body. A body re-executes on resume, so a run interrupted at nine and resumed at three recorded a
   * `startedAt` of three — six hours after the repairs the run's own id is stamped on. The runs table exists to
   * answer "when did this pass run and what did it fix", and the answer was a row claiming to have begun after
   * its own work.
   */
  test("the run began when the pass began, not when it resumed", async () => {
    for (let index = 0; index < 3; index += 1) {
      await seed({ providerTransactionId: `txn-${index}`, originalTransactionId: `orig-${index}` });
    }
    // A clock that moves across the interruption. Six hours is an ordinary Workflow retry backoff, not a
    // pathological one — the defect needs no unusual outage to appear.
    let clock = T0;
    const runDeps = deps(
      { apple: fakeRail("apple", async (row) => refreshedFrom(row, { status: "canceled" })) },
      { now: () => new Date(clock) },
    );

    const journal = new Map<string, unknown>();
    await expect(
      reconcilePayments(runDeps, journalledStep(journal, "page-000002"), { pageSize: 1 }),
    ).rejects.toBeInstanceOf(Interrupted);
    clock = T0 + 6 * 3600 * SECOND;
    const report = await reconcilePayments(runDeps, journalledStep(journal), { pageSize: 1 });

    const run = await env.DB.prepare("select started_at, finished_at from pithy_payments_reconcile_runs where id = ?")
      .bind(report.runId)
      .first<{ started_at: number; finished_at: number }>();

    // The instant the pass began, not the instant it came back.
    expect(run?.started_at).toBe(T0);
    // And the property that matters, stated over the work rather than over a constant: no row this run
    // repaired was written before the run says it started.
    const { results } = await env.DB.prepare("select updated_at from pithy_payments_purchases").all<{
      updated_at: number;
    }>();
    const earliestRepair = Math.min(...results.map((row) => row.updated_at));
    expect(run?.started_at).toBeLessThanOrEqual(earliestRepair);
    // `finishedAt` is the opposite rule, and it still holds: it is read when the run ends, so it moves.
    expect(run?.finished_at).toBe(T0 + 6 * 3600 * SECOND);
  });
});
