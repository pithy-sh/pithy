import { env } from "cloudflare:test";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import { openLedger } from "@pithy-sh/ledger/src/ledger";
import { ledger_0001_accounts } from "@pithy-sh/ledger/src/migrations/0001_accounts";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { PaymentsConfig } from "../config/config";
import { payments_0001_purchases } from "../migrations/0001_purchases";
import type { ProviderEventInput } from "../projection/event";
import { type PurchaseProjection, projectPurchase } from "../projection/writer";
import { applyGrants, fulfillPurchase, grantRef } from "./apply";
import type { PaymentsLedger } from "./ledgerSeam";

/**
 * Ledger grants, against a real ledger in a real D1. The claim under test is not "a credit happens" — it is
 * that a credit happens **once**, whatever the delivery pattern, and that the guard is the ledger's own
 * `UNIQUE (ref)` rather than anything payments remembers. That can only be proved against the constraint.
 */

const SECOND = 1000;
const DAY = 86_400 * SECOND;
const T0 = 1_700_000_000_000;

const CONFIG = PaymentsConfig.parse({
  rails: { apple: true },
  products: {
    coins_100: {
      type: "consumable",
      name: "100 coins",
      grants: { ledger: { currency: "coins", amount: 100 } },
      apple: { productId: "com.acme.coins100" },
    },
    pro_monthly: {
      type: "subscription",
      name: "Pro",
      entitlements: ["pro"],
      grants: { ledger: { currency: "coins", amount: 50 } },
      apple: { productId: "com.acme.pro.monthly" },
    },
    remove_ads: {
      type: "non_consumable",
      name: "Remove ads",
      entitlements: ["ads_removed"],
      apple: { productId: "com.acme.removeads" },
    },
  },
});

const PAYMENTS_TABLES = [
  "pithy_payments_purchases",
  "pithy_payments_entitlements",
  "pithy_payments_provider_accounts",
  "pithy_payments_webhook_events",
];
const LEDGER_TABLES = ["pithy_ledger_accounts", "pithy_ledger_transactions", "pithy_ledger_holds"];

beforeEach(async () => {
  for (const table of [...PAYMENTS_TABLES, ...LEDGER_TABLES]) await env.DB.exec(`DROP TABLE IF EXISTS ${table}`);
  const db = createDatabase(env.DB, {}) as unknown as Kysely<unknown>;
  await payments_0001_purchases.up(db);
  await ledger_0001_accounts.up(db);
});

function event(overrides: Partial<ProviderEventInput> = {}): ProviderEventInput {
  return {
    rail: "apple",
    providerTransactionId: "txn-1",
    providerProductId: "com.acme.coins100",
    userId: "ada",
    status: "active",
    environment: "production",
    purchasedAt: new Date(T0),
    providerEventAt: new Date(T0),
    payload: { transactionId: "txn-1" },
    ...overrides,
  };
}

const project = (input: ProviderEventInput = event()): Promise<PurchaseProjection> =>
  projectPurchase(env.DB, input, { config: CONFIG, environment: "production", now: new Date(T0 + SECOND) });

const ledger = () => openLedger(env.DB, () => T0 + SECOND);

const balance = (userId: string, currency = "coins") => ledger().balance(userId, currency);

async function transactionRows(): Promise<{ ref: string; kind: string; amount: number; memo: string | null }[]> {
  const { results } = await env.DB.prepare(
    "SELECT ref, kind, amount, memo FROM pithy_ledger_transactions ORDER BY id",
  ).all<{ ref: string; kind: string; amount: number; memo: string | null }>();
  return results;
}

describe("grantRef", () => {
  test("is a pure function of the purchase id and the currency", () => {
    expect(grantRef("p-1", "coins")).toBe("payments:grant:p-1:coins");
    expect(grantRef("p-1", "coins")).toBe(grantRef("p-1", "coins"));
  });

  test("is per currency, never per purchase", () => {
    // The ledger's `ref` is UNIQUE across the whole ledger and a duplicate is swallowed as success, so one
    // ref for a purchase would credit the first currency and silently drop every other.
    expect(grantRef("p-1", "coins")).not.toBe(grantRef("p-1", "gems"));
  });

  test("never collides with a ledger-reserved suffix", () => {
    // `:out`, `:in`, and `:resolve` are derived by the ledger itself for transfers and hold resolutions.
    for (const suffix of [":out", ":in", ":resolve"]) expect(grantRef("p-1", "coins").endsWith(suffix)).toBe(false);
  });
});

describe("the ledger constraint the ref shape defends against", () => {
  test("a duplicate ref is swallowed as success, crediting only the first currency", async () => {
    const shared = "payments:grant:p-1";
    await ledger().credit("ada", "coins", 100, shared);
    await ledger().credit("ada", "gems", 5, shared);
    expect((await balance("ada")).balance).toBe(100);
    // Not an error, not a rejection — a silent no-op. This is why the currency is in the ref.
    expect((await balance("ada", "gems")).balance).toBe(0);
  });
});

describe("applyGrants", () => {
  test("credits the catalog's currency and amount when a purchase is fulfilled", async () => {
    const projection = await project();
    const applied = await applyGrants(ledger(), projection, { config: CONFIG });

    expect(applied).toEqual([{ currency: "coins", amount: 100, ref: grantRef(projection.purchase.id, "coins") }]);
    expect((await balance("ada")).balance).toBe(100);
  });

  test("names the rail and the product in the memo, and nothing a receipt would carry", async () => {
    await applyGrants(ledger(), await project(), { config: CONFIG });
    const [row] = await transactionRows();
    expect(row?.memo).toBe("payments apple coins_100");
    expect(row?.kind).toBe("credit");
  });

  test("credits once however many times it is applied — the ledger's ref is the guard", async () => {
    const projection = await project();
    await applyGrants(ledger(), projection, { config: CONFIG });
    await applyGrants(ledger(), projection, { config: CONFIG });
    await applyGrants(ledger(), projection, { config: CONFIG });

    expect((await balance("ada")).balance).toBe(100);
    expect(await transactionRows()).toHaveLength(1);
  });

  test("a redelivered webhook re-projects and re-applies to the same balance", async () => {
    // The whole delivery, twice, exactly as a provider retry would run it.
    for (let i = 0; i < 2; i++) await applyGrants(ledger(), await project(), { config: CONFIG });
    expect((await balance("ada")).balance).toBe(100);
  });

  test("a subscription's grant fires once per billing period, because each renewal is its own transaction", async () => {
    const first = await project(event({ providerProductId: "com.acme.pro.monthly", expiresAt: new Date(T0 + DAY) }));
    const renewal = await project(
      event({
        providerProductId: "com.acme.pro.monthly",
        providerTransactionId: "txn-2",
        purchasedAt: new Date(T0 + DAY),
        providerEventAt: new Date(T0 + DAY),
        expiresAt: new Date(T0 + 2 * DAY),
      }),
    );
    expect(renewal.purchase.id).not.toBe(first.purchase.id);

    await applyGrants(ledger(), first, { config: CONFIG });
    await applyGrants(ledger(), renewal, { config: CONFIG });
    // Two periods, two credits — and the refs differ only because the purchase ids do.
    expect((await balance("ada")).balance).toBe(100);
    expect((await transactionRows()).map((row) => row.amount)).toEqual([50, 50]);
  });

  test("a product with no grants clause credits nothing", async () => {
    const projection = await project(event({ providerProductId: "com.acme.removeads" }));
    expect(await applyGrants(ledger(), projection, { config: CONFIG })).toEqual([]);
    expect(await transactionRows()).toEqual([]);
  });

  test("an unpaid renewal credits nothing — the money never arrived", async () => {
    for (const status of ["in_grace", "on_hold"] as const) {
      const projection = await project(
        event({ providerTransactionId: `txn-${status}`, status, providerEventAt: new Date(T0) }),
      );
      expect(await applyGrants(ledger(), projection, { config: CONFIG })).toEqual([]);
    }
    expect((await balance("ada")).balance).toBe(0);
  });

  test("a reversed purchase credits nothing — the money came back", async () => {
    for (const status of ["refunded", "revoked"] as const) {
      const projection = await project(event({ providerTransactionId: `txn-${status}`, status }));
      expect(await applyGrants(ledger(), projection, { config: CONFIG })).toEqual([]);
    }
    expect((await balance("ada")).balance).toBe(0);
  });

  test("a lapsed period still credited, because the charge for it was paid", async () => {
    // `expired` is where a subscription ends up, not a statement about whether its invoice cleared.
    const projection = await project(event({ providerProductId: "com.acme.pro.monthly", status: "expired" }));
    expect(await applyGrants(ledger(), projection, { config: CONFIG })).toHaveLength(1);
    expect((await balance("ada")).balance).toBe(50);
  });

  test("a purchase that terminated before any money cleared credits nothing", async () => {
    // The one an `expired`-shaped termination hides: a delayed-payment checkout that failed, a Stripe
    // subscription abandoned at `incomplete_expired`, a Play deferred purchase cancelled before payment. All
    // three end without a charge, and crediting one hands out a 100-coin pack for money that never arrived —
    // with no clawback ever to follow, because there was no payment to reverse.
    const projection = await project(event({ status: "never_paid" }));
    expect(await applyGrants(ledger(), projection, { config: CONFIG })).toEqual([]);
    expect((await balance("ada")).balance).toBe(0);
    expect(await transactionRows()).toEqual([]);
  });

  test("a raw ledger failure propagates as an unknown outcome rather than a silent skip", async () => {
    // `isViolation` is a regex on the message, so a transient D1 fault reaches a caller unwrapped. Swallowing
    // it would drop a credit permanently; propagating it lets the stable ref settle it on the retry.
    const exploding: PaymentsLedger = {
      credit: () => Promise.reject(new Error("D1_ERROR: network")),
      debit: () => Promise.reject(new Error("unreachable")),
    };
    await expect(applyGrants(exploding, await project(), { config: CONFIG })).rejects.toThrow("D1_ERROR");
  });
});

describe("fulfillPurchase", () => {
  test("opens no ledger at all for a catalog with no grants clause", async () => {
    // The optional peer must not be resolved by a project that never asked for it. Nothing is injected here,
    // so a load would reach the real import; the assertion is that the report is empty and nothing was written.
    const report = await fulfillPurchase(env.DB, await project(event({ providerProductId: "com.acme.removeads" })), {
      config: CONFIG,
    });
    expect(report).toEqual({ granted: [], clawedBack: [] });
    expect(await transactionRows()).toEqual([]);
  });

  test("credits through the real guarded import when the catalog does ask", async () => {
    const report = await fulfillPurchase(env.DB, await project(), { config: CONFIG });
    expect(report.granted).toHaveLength(1);
    expect((await balance("ada")).balance).toBe(100);
  });
});
