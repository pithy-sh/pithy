// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { AuditEventInput } from "@pithy-sh/core/src/audit/auditEvent";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { openLedger } from "@pithy-sh/ledger/src/ledger";
import { ledger_0001_accounts } from "@pithy-sh/ledger/src/migrations/0001_accounts";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { PaymentsAuditActions } from "../audit/actions";
import { PaymentsConfig } from "../config/config";
import type { PaymentsSubject } from "../data/subject";
import { payments_0001_purchases } from "../migrations/0001_purchases";
import type { ProviderEventInput } from "../projection/event";
import { type PurchaseProjection, projectPurchase } from "../projection/writer";
import { fulfillPurchase } from "./apply";
import { clawbackGrants, clawbackRef } from "./clawback";
import { ledgerAccountId, type PaymentsLedger } from "./ledgerSeam";

/**
 * The refund clawback, against a real ledger's `CHECK (balance >= 0)`.
 *
 * The interesting case is the failing one, and it is the reason the module exists in this shape: a player who
 * spent their coins before the refund arrived **cannot** be debited, the database says so, and that refusal is
 * correct. The tests below prove the three things that follow from accepting it — the refund still stands, the
 * shortfall is recorded, and nothing retries its way into a negative balance.
 */

const SECOND = 1000;
const T0 = 1_700_000_000_000;

/** The buyer, as a pair. The ledger never sees the id half alone. */
const ADA: PaymentsSubject = { subjectType: "user", subjectId: "ada" };

const CONFIG = PaymentsConfig.parse({
  billingSubject: "user",
  rails: { apple: true },
  products: {
    coins_100: {
      type: "consumable",
      name: "100 coins",
      grants: { ledger: { currency: "coins", amount: 100 } },
      clawback: true,
      apple: { productId: "com.acme.coins100" },
    },
    coins_500: {
      type: "consumable",
      name: "500 coins",
      grants: { ledger: { currency: "coins", amount: 500 } },
      apple: { productId: "com.acme.coins500" },
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

/** Every audit event the fulfillment emitted, so the recorded state is asserted rather than assumed. */
let emitted: AuditEventInput[];

beforeEach(async () => {
  for (const table of [...PAYMENTS_TABLES, ...LEDGER_TABLES]) await env.DB.exec(`DROP TABLE IF EXISTS ${table}`);
  const db = createDatabase(env.DB, {}) as unknown as Kysely<unknown>;
  await payments_0001_purchases.up(db);
  await ledger_0001_accounts.up(db);
  emitted = [];
});

const emit = async (event: AuditEventInput) => {
  emitted.push(event);
};

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
/** A subject's balance, addressed through the one derivation the grant and the clawback both use. */
const balance = (subject: PaymentsSubject, currency = "coins") => ledger().balance(ledgerAccountId(subject), currency);

/** Buy, then refund: the two projections a refunded purchase produces, in order. */
async function boughtThenRefunded(overrides: Partial<ProviderEventInput> = {}): Promise<PurchaseProjection> {
  await project(event(overrides));
  return project(event({ ...overrides, status: "refunded", providerEventAt: new Date(T0 + SECOND) }));
}

describe("clawbackRef", () => {
  test("is a pure function of the purchase id and the currency, and distinct from the grant's", () => {
    expect(clawbackRef("p-1", "coins")).toBe("payments:clawback:p-1:coins");
    // Sharing the grant's ref would make the reversal a swallowed no-op — the ledger recognizes it as a replay.
    expect(clawbackRef("p-1", "coins")).not.toBe("payments:grant:p-1:coins");
  });
});

describe("clawbackGrants", () => {
  test("reverses the credit when the catalog opts in and the balance covers it", async () => {
    const purchase = await project();
    await fulfillPurchase(env.DB, purchase, { config: CONFIG, emit });
    expect((await balance(ADA)).balance).toBe(100);

    const refund = await boughtThenRefunded();
    const outcomes = await clawbackGrants(ledger(), refund, { config: CONFIG });

    expect(outcomes).toEqual([
      { outcome: "reversed", currency: "coins", amount: 100, ref: clawbackRef(refund.purchase.id, "coins") },
    ]);
    expect((await balance(ADA)).balance).toBe(0);
  });

  test("is off by default — a refunded product that never opted in keeps its balance", async () => {
    await fulfillPurchase(env.DB, await project(event({ providerProductId: "com.acme.coins500" })), {
      config: CONFIG,
      emit,
    });
    const refund = await boughtThenRefunded({ providerProductId: "com.acme.coins500" });

    expect(await clawbackGrants(ledger(), refund, { config: CONFIG })).toEqual([]);
    expect((await balance(ADA)).balance).toBe(500);
  });

  test("does nothing for a purchase that still stands", async () => {
    expect(await clawbackGrants(ledger(), await project(), { config: CONFIG })).toEqual([]);
  });

  test("does nothing for a product with no grants clause at all", async () => {
    const refund = await boughtThenRefunded({ providerProductId: "com.acme.removeads" });
    expect(await clawbackGrants(ledger(), refund, { config: CONFIG })).toEqual([]);
  });

  test("a revoked purchase claws back too — the money came back either way", async () => {
    await fulfillPurchase(env.DB, await project(), { config: CONFIG, emit });
    await project(event({ status: "revoked", providerEventAt: new Date(T0 + SECOND) }));
    const revoked = await project(event({ status: "revoked", providerEventAt: new Date(T0 + 2 * SECOND) }));

    expect((await clawbackGrants(ledger(), revoked, { config: CONFIG }))[0]?.outcome).toBe("reversed");
    expect((await balance(ADA)).balance).toBe(0);
  });

  test("reverses once however many times the refund is delivered", async () => {
    await fulfillPurchase(env.DB, await project(), { config: CONFIG, emit });
    const refund = await boughtThenRefunded();
    for (let i = 0; i < 3; i++) await clawbackGrants(ledger(), refund, { config: CONFIG });
    expect((await balance(ADA)).balance).toBe(0);
  });

  test("a spent balance refuses the reversal, and the refusal is the outcome rather than an exception", async () => {
    await fulfillPurchase(env.DB, await project(), { config: CONFIG, emit });
    // The player spent it. The refund arrives anyway, as refunds do.
    await ledger().debit(ledgerAccountId(ADA), "coins", 60, "game:spend:1");
    const refund = await boughtThenRefunded();

    const [outcome] = await clawbackGrants(ledger(), refund, { config: CONFIG });
    expect(outcome?.outcome).toBe("refused");
    if (outcome?.outcome !== "refused") throw new Error("narrowing failed");
    expect(outcome.error.payload.code).toBe("payments/clawback_failed");
    expect(outcome.error.payload.status).toBe(409);
    // Neither a negative balance nor a partial write-off. The ledger is exactly where it was.
    expect((await balance(ADA)).balance).toBe(40);
  });

  test("a failure that is not the ledger's refusal is an unknown outcome, and propagates", async () => {
    // `isViolation` regexes the message, so a transient D1 fault is neither typed nor a refusal. Recording it
    // as "refused" would claim we know the balance was short when we know nothing at all.
    const exploding: PaymentsLedger = {
      credit: () => Promise.reject(new Error("unreachable")),
      debit: () => Promise.reject(new Error("D1_ERROR: network")),
    };
    await expect(clawbackGrants(exploding, await boughtThenRefunded(), { config: CONFIG })).rejects.toThrow("D1_ERROR");
  });
});

describe("fulfillPurchase — the recorded state a refused clawback becomes", () => {
  test("emits a critical audit event naming the code, the account, and the shortfall", async () => {
    await fulfillPurchase(env.DB, await project(), { config: CONFIG, emit });
    await ledger().debit(ledgerAccountId(ADA), "coins", 100, "game:spend:1");
    emitted = [];

    const report = await fulfillPurchase(env.DB, await boughtThenRefunded(), { config: CONFIG, emit });

    expect(report.clawedBack[0]?.outcome).toBe("refused");
    expect(emitted).toHaveLength(1);
    const [recorded] = emitted;
    expect(recorded?.action).toBe(PaymentsAuditActions.clawbackFailed);
    expect(recorded?.outcome).toBe("failure");
    expect(recorded?.severity).toBe("critical");
    expect(recorded?.metadata).toMatchObject({
      currency: "coins",
      amount: 100,
      // Both halves. Whoever answers this alert has to know whether the shortfall is a person's balance or a
      // company's, and an id alone does not say.
      subjectType: "user",
      subjectId: "ada",
      productId: "coins_100",
      reason: "payments/clawback_failed",
    });
  });

  test("records nothing when the reversal succeeded — the ledger row is already the record", async () => {
    await fulfillPurchase(env.DB, await project(), { config: CONFIG, emit });
    emitted = [];
    const report = await fulfillPurchase(env.DB, await boughtThenRefunded(), { config: CONFIG, emit });

    expect(report.clawedBack[0]?.outcome).toBe("reversed");
    expect(emitted).toEqual([]);
  });

  test("the refund still stands, whatever the clawback did", async () => {
    await fulfillPurchase(env.DB, await project(), { config: CONFIG, emit });
    await ledger().debit(ledgerAccountId(ADA), "coins", 100, "game:spend:1");
    await fulfillPurchase(env.DB, await boughtThenRefunded(), { config: CONFIG, emit });

    const { results } = await env.DB.prepare("SELECT status FROM pithy_payments_purchases").all<{ status: string }>();
    expect(results).toEqual([{ status: "refunded" }]);
  });

  test("needs no audit recorder composed — the seam defaults to core's no-op", async () => {
    await fulfillPurchase(env.DB, await project(), { config: CONFIG });
    await ledger().debit(ledgerAccountId(ADA), "coins", 100, "game:spend:1");
    const report = await fulfillPurchase(env.DB, await boughtThenRefunded(), { config: CONFIG });
    expect(report.clawedBack[0]?.outcome).toBe("refused");
  });
});
/**
 * The reversal under organization billing, and the invariant the account derivation exists for.
 *
 * A clawback that composed the ledger account any other way than the credit did would debit an account
 * nothing was ever credited to. The ledger would answer that with `insufficient_funds` — the same refusal a
 * genuinely spent balance produces — so the miss would be recorded as a shortfall and the company would keep
 * the currency for a purchase it was refunded. Hence: reverse *exactly* the account the grant credited.
 */
describe("a clawback under organization billing", () => {
  /**
   * There is none, and the reversal is the reason it matters most.
   *
   * `@pithy-sh/ledger` is a per-user model, so `checkLedgerGrants` refuses a balance-crediting catalog under
   * organization billing at composition — see `capability.test.ts`. That refusal is what keeps this file's
   * central property intact: a credit and its clawback address one account. Had an organization been given a
   * namespaced account instead, the credit would have landed somewhere the ledger's own routes cannot read,
   * and the reversal would have been a debit against a balance nobody could see either.
   */

  test("an organization never reaches the clawback path, because it never reaches the credit", () => {
    expect(() => ledgerAccountId({ subjectType: "organization", subjectId: "acme" })).toThrow(PithyError);
  });
});
