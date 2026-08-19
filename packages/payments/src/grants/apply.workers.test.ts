// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { openLedger } from "@pithy-sh/ledger/src/ledger";
import { ledger_0001_accounts } from "@pithy-sh/ledger/src/migrations/0001_accounts";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { PaymentsConfig } from "../config/config";
import type { PaymentsSubject } from "../data/subject";
import { payments_0001_purchases } from "../migrations/0001_purchases";
import type { ProviderEventInput } from "../projection/event";
import { type PurchaseProjection, projectPurchase } from "../projection/writer";
import { applyGrants, fulfillPurchase, grantRef } from "./apply";
import { ledgerAccountId, type PaymentsLedger } from "./ledgerSeam";

/**
 * Ledger grants, against a real ledger in a real D1. The claim under test is not "a credit happens" — it is
 * that a credit happens **once**, whatever the delivery pattern, and that the guard is the ledger's own
 * `UNIQUE (ref)` rather than anything payments remembers. That can only be proved against the constraint.
 */

const SECOND = 1000;
const DAY = 86_400 * SECOND;
const T0 = 1_700_000_000_000;

/** The buyer, as every event and every balance assertion names her: a pair, never a bare id. */
const ADA: PaymentsSubject = { subjectType: "user", subjectId: "ada" };

const CONFIG = PaymentsConfig.parse({
  billingSubject: "user",
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
  "pithy_payments_reconcile_runs",
  "pithy_payments_sync_cursors",
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
    ...ADA,
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

/** A subject's balance, addressed the way `applyGrants` addresses it — through the one derivation. */
const balance = (subject: PaymentsSubject, currency = "coins") => ledger().balance(ledgerAccountId(subject), currency);

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
    const account = ledgerAccountId(ADA);
    await ledger().credit(account, "coins", 100, shared);
    await ledger().credit(account, "gems", 5, shared);
    expect((await balance(ADA)).balance).toBe(100);
    // Not an error, not a rejection — a silent no-op. This is why the currency is in the ref.
    expect((await balance(ADA, "gems")).balance).toBe(0);
  });
});

describe("applyGrants", () => {
  test("credits the catalog's currency and amount when a purchase is fulfilled", async () => {
    const projection = await project();
    const applied = await applyGrants(ledger(), projection, { config: CONFIG });

    expect(applied).toEqual([{ currency: "coins", amount: 100, ref: grantRef(projection.purchase.id, "coins") }]);
    expect((await balance(ADA)).balance).toBe(100);
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

    expect((await balance(ADA)).balance).toBe(100);
    expect(await transactionRows()).toHaveLength(1);
  });

  test("a redelivered webhook re-projects and re-applies to the same balance", async () => {
    // The whole delivery, twice, exactly as a provider retry would run it.
    for (let i = 0; i < 2; i++) await applyGrants(ledger(), await project(), { config: CONFIG });
    expect((await balance(ADA)).balance).toBe(100);
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
    expect((await balance(ADA)).balance).toBe(100);
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
    expect((await balance(ADA)).balance).toBe(0);
  });

  test("a reversed purchase credits nothing — the money came back", async () => {
    for (const status of ["refunded", "revoked"] as const) {
      const projection = await project(event({ providerTransactionId: `txn-${status}`, status }));
      expect(await applyGrants(ledger(), projection, { config: CONFIG })).toEqual([]);
    }
    expect((await balance(ADA)).balance).toBe(0);
  });

  test("a lapsed period still credited, because the charge for it was paid", async () => {
    // `expired` is where a subscription ends up, not a statement about whether its invoice cleared.
    const projection = await project(event({ providerProductId: "com.acme.pro.monthly", status: "expired" }));
    expect(await applyGrants(ledger(), projection, { config: CONFIG })).toHaveLength(1);
    expect((await balance(ADA)).balance).toBe(50);
  });

  test("a purchase that terminated before any money cleared credits nothing", async () => {
    // The one an `expired`-shaped termination hides: a delayed-payment checkout that failed, a Stripe
    // subscription abandoned at `incomplete_expired`, a Play deferred purchase cancelled before payment. All
    // three end without a charge, and crediting one hands out a 100-coin pack for money that never arrived —
    // with no clawback ever to follow, because there was no payment to reverse.
    const projection = await project(event({ status: "never_paid" }));
    expect(await applyGrants(ledger(), projection, { config: CONFIG })).toEqual([]);
    expect((await balance(ADA)).balance).toBe(0);
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
    expect((await balance(ADA)).balance).toBe(100);
  });
});

/**
 * Organization billing, against the real ledger.
 *
 * `@pithy-sh/ledger` keys an account on one flat id, and nothing in the kit keeps an organization id and a
 * user id apart — they are minted by different systems, and under organization billing the id comes from a
 * membership model this package never sees. So the only honest way to test the derivation is to give the two
 * subjects the **same** id and prove there are still two balances.
 */
describe("a grant to an organization", () => {
  /**
   * There is no such thing, and that is the behaviour.
   *
   * `@pithy-sh/ledger` is a per-user model: an account is `(userId, currency)` and every route it serves
   * reads a user id. A company's credit has no account to land in that anything would read, so
   * `checkLedgerGrants` refuses the pairing at **composition** — proved in `capability.test.ts`, before a
   * project deploys rather than after a customer has paid for coins nothing can deliver. What is left to
   * prove here is the address itself, which is what this module owns.
   */

  test("ledgerAccountId refuses an organization outright — the backstop below composition", () => {
    // Unreachable through a composed Worker. Present so a path that skipped composition fails loudly rather
    // than writing a row into `pithy_ledger_accounts` whose `user_id` is not a user.
    expect(() => ledgerAccountId({ subjectType: "organization", subjectId: "acme" })).toThrow(PithyError);
  });

  test("a user keeps the address the ledger's own routes read", async () => {
    // The half that regressed, asserted against the real ledger rather than against the helper alone: a
    // grant credited to `user:ada` landed in an account no ledger route reads, so the player's balance
    // stayed empty and nothing on either side reported a fault.
    const ada: PaymentsSubject = { subjectType: "user", subjectId: "ada" };
    await applyGrants(
      ledger(),
      await projectPurchase(env.DB, event(ada), {
        config: CONFIG,
        environment: "production",
        now: new Date(T0 + SECOND),
      }),
      { config: CONFIG },
    );

    const { results } = await env.DB.prepare(
      "SELECT user_id AS accountId, balance FROM pithy_ledger_accounts ORDER BY user_id",
    ).all<{ accountId: string; balance: number }>();
    expect(results).toEqual([{ accountId: "ada", balance: 100 }]);
  });
});

/**
 * The Lemon Squeezy shape, against the real ledger and a real D1.
 *
 * That rail writes two kinds of row because its store splits money from subscription state at the source: a
 * `state` row carrying access, and a `charge` row per billing invoice carrying the money. The claim under
 * test is the one the whole split exists to make true — **N renewals credit exactly N times** — and it can
 * only be proved against the ledger's own `UNIQUE (ref)`, because the guard is that constraint rather than
 * anything payments remembers.
 */
describe("a subscription whose money and state are separate rows", () => {
  const LS_CONFIG = PaymentsConfig.parse({
    billingSubject: "user",
    rails: { lemonSqueezy: true },
    lemonSqueezy: { successUrl: "https://acme.test/thanks", cancelUrl: "https://acme.test/paywall" },
    products: {
      pro_monthly: {
        type: "subscription",
        name: "Pro",
        entitlements: ["pro"],
        grants: { ledger: { currency: "coins", amount: 50 } },
        clawback: true,
        lemonSqueezy: { variantId: "55555" },
      },
    },
  });

  const lsEvent = (overrides: Partial<ProviderEventInput>): ProviderEventInput => ({
    rail: "lemonSqueezy",
    providerProductId: "55555",
    ...ADA,
    environment: "production",
    purchasedAt: new Date(T0),
    providerEventAt: new Date(T0),
    payload: {},
    providerTransactionId: "subscription:90001",
    originalTransactionId: "subscription:90001",
    status: "active",
    ...overrides,
  });

  const projectLs = (input: ProviderEventInput): Promise<PurchaseProjection> =>
    projectPurchase(env.DB, input, { config: LS_CONFIG, environment: "production", now: new Date(T0 + SECOND) });

  const fulfilLs = async (input: ProviderEventInput) =>
    await fulfillPurchase(env.DB, await projectLs(input), { config: LS_CONFIG });

  /** One billing period's invoice row. Born `expired`: a closed window that took money. */
  const invoice = (id: string, at: number, overrides: Partial<ProviderEventInput> = {}): ProviderEventInput =>
    lsEvent({
      providerTransactionId: `subscription_invoice:${id}`,
      role: "charge",
      status: "expired",
      amountMinor: 999,
      currency: "USD",
      purchasedAt: new Date(at),
      expiresAt: new Date(at),
      providerEventAt: new Date(at),
      ...overrides,
    });

  test("two consecutive renewals produce two rows and credit twice", async () => {
    await fulfilLs(lsEvent({ role: "state", status: "active", expiresAt: new Date(T0 + 30 * DAY) }));
    await fulfilLs(invoice("8001", T0));
    await fulfilLs(invoice("8002", T0 + 30 * DAY));

    // 50 per period, twice — and not three times, which is what a crediting state row would have made it.
    expect((await balance(ADA)).balance).toBe(100);
    const credits = (await transactionRows()).filter((row) => row.kind === "credit");
    expect(credits).toHaveLength(2);
  });

  test("the state row never credits, whatever its status says", async () => {
    // An honest `active` on a live subscription passes every paid-status check there is. `role` is the only
    // thing that stops it, and without it every subscriber is credited once more than they paid for.
    const report = await fulfilLs(lsEvent({ role: "state", status: "active" }));
    expect(report.granted).toEqual([]);
    expect(await transactionRows()).toEqual([]);
  });

  test("an invoice event cannot move the subscription's watermark, because it addresses another row", async () => {
    // The ordering defect the split exists to prevent. The invoice's clock runs in the invoice domain; a
    // `subscription_updated` stamped earlier must still advance the standing.
    await projectLs(lsEvent({ role: "state", status: "active", providerEventAt: new Date(T0) }));
    await projectLs(invoice("8001", T0 + 10 * SECOND));

    const later = await projectLs(
      lsEvent({ role: "state", status: "canceled", providerEventAt: new Date(T0 + 5 * SECOND) }),
    );
    expect(later.purchase.status).toBe("canceled");
    expect(later.outcome).toBe("updated");
  });

  test("a refund claws back once, against the row that took the money", async () => {
    await fulfilLs(invoice("8001", T0));
    expect((await balance(ADA)).balance).toBe(50);

    const report = await fulfilLs(
      invoice("8001", T0, { status: "refunded", revokedAt: new Date(T0 + DAY), providerEventAt: new Date(T0 + DAY) }),
    );
    expect(report.clawedBack).toHaveLength(1);
    expect((await balance(ADA)).balance).toBe(0);
  });

  test("the revocation that accompanies a refund claws back nothing of its own", async () => {
    // Both halves of one refund land, in the order the route projects them. The state row is `revoked`,
    // which is a reversed status — so only `role` stops it debiting a second time for money it never took.
    await fulfilLs(invoice("8001", T0));
    await fulfilLs(
      invoice("8001", T0, { status: "refunded", revokedAt: new Date(T0 + DAY), providerEventAt: new Date(T0 + DAY) }),
    );
    const report = await fulfilLs(
      lsEvent({ role: "state", status: "revoked", revokedAt: new Date(T0 + DAY), providerEventAt: new Date(T0 + DAY) }),
    );

    expect(report.clawedBack).toEqual([]);
    // One credit and one debit. A second debit would take currency the buyer was never given.
    expect((await balance(ADA)).balance).toBe(0);
    const rows = await transactionRows();
    expect(rows.filter((row) => row.kind === "credit")).toHaveLength(1);
    expect(rows.filter((row) => row.kind === "debit")).toHaveLength(1);
  });

  test("a refund revokes the entitlement the money paid for", async () => {
    await fulfilLs(lsEvent({ role: "state", status: "active", expiresAt: new Date(T0 + 30 * DAY) }));
    const granted = await projectLs(lsEvent({ role: "state", status: "active", expiresAt: new Date(T0 + 30 * DAY) }));
    expect(granted.entitlements.some((held) => held.entitlement === "pro" && held.active)).toBe(true);

    const revoked = await projectLs(
      lsEvent({ role: "state", status: "revoked", revokedAt: new Date(T0 + DAY), providerEventAt: new Date(T0 + DAY) }),
    );
    expect(revoked.entitlements.some((held) => held.entitlement === "pro" && held.active)).toBe(false);
  });
});
