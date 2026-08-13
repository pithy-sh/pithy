// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { payments_0001_purchases } from "./0001_purchases";

/** `createDatabase(env.DB, {})` — the empty map is the idiom for handing a migration an untyped Kysely. */
const db = () => createDatabase(env.DB, {}) as unknown as Kysely<unknown>;

const TABLES = [
  "pithy_payments_purchases",
  "pithy_payments_entitlements",
  "pithy_payments_provider_accounts",
  "pithy_payments_webhook_events",
  "pithy_payments_reconcile_runs",
];

/** Every payments object SQLite knows about, by name. Proves the `pithy_payments_` prefix rather than trusting it. */
async function catalog(): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE name LIKE 'pithy_payments_%' ORDER BY name",
  ).all<{ name: string }>();
  return results.map((r) => r.name);
}

/**
 * Every object the one migration creates, in `sqlite_master` name order — five tables and seven indexes.
 * Written out rather than counted: an index a read was planned around is part of that read's contract,
 * and folding a chain into one migration is exactly the change that can lose one silently.
 */
const EXPECTED_CATALOG = [
  "pithy_payments_entitlements",
  "pithy_payments_entitlements_created_idx",
  "pithy_payments_provider_accounts",
  "pithy_payments_purchases",
  "pithy_payments_purchases_expiry_idx",
  "pithy_payments_purchases_owner_idx",
  "pithy_payments_purchases_purchased_idx",
  "pithy_payments_purchases_type_purchased_idx",
  "pithy_payments_reconcile_runs",
  "pithy_payments_reconcile_runs_started_idx",
  "pithy_payments_webhook_events",
  "pithy_payments_webhook_events_pending_idx",
];

/** A complete purchase row, so a constraint test varies exactly one column. */
const PURCHASE_COLUMNS =
  "id, user_id, rail, provider_transaction_id, product_id, provider_product_id, type, status, environment, purchased_at, expires_at, revoked_at, original_transaction_id, amount_minor, currency, provider_event_at, payload, created_at, updated_at";

function purchaseValues(overrides: { id?: string; transaction?: string; environment?: string; amount?: string } = {}) {
  const id = overrides.id ?? "p1";
  const transaction = overrides.transaction ?? "t1";
  const environment = overrides.environment ?? "production";
  const amount = overrides.amount ?? "999";
  return `('${id}', 'u1', 'apple', '${transaction}', 'pro_monthly', 'com.acme.pro.monthly', 'subscription', 'active', '${environment}', 0, null, null, null, ${amount}, 'USD', 0, '{}', 0, 0)`;
}

const insertPurchase = (overrides?: Parameters<typeof purchaseValues>[0]) =>
  env.DB.prepare(
    `INSERT INTO pithy_payments_purchases (${PURCHASE_COLUMNS}) VALUES ${purchaseValues(overrides)}`,
  ).run();

beforeEach(async () => {
  for (const table of TABLES) await env.DB.exec(`DROP TABLE IF EXISTS ${table}`);
  await payments_0001_purchases.up(db());
});

describe("payments_0001_purchases", () => {
  test("up creates the five tables and all seven indexes, all prefixed pithy_payments_", async () => {
    // The exact catalog, not a `toContain`: a table added without a prefix, or an index quietly renamed
    // or dropped, has to fail here rather than in an adopter's database. Seven indexes — three for the
    // capability's own reads, three for the control-plane reads (#247), one for the reconciliation run
    // log's listing and its retention prune (#316) — and an index a query was planned around is part of
    // that read's contract, so it is named rather than counted.
    expect(await catalog()).toEqual(EXPECTED_CATALOG);
  });

  test("UNIQUE (rail, providerTransactionId) refuses a second row for one provider transaction", async () => {
    await insertPurchase();
    // The idempotency anchor, enforced by SQLite. Nothing in the application layer can be trusted with it:
    // two concurrent write paths both see "no row" and both insert, and only the database can arbitrate.
    await expect(insertPurchase({ id: "p2" })).rejects.toThrow(/UNIQUE constraint failed/i);
    // A different rail may carry the same transaction id — the ids are each rail's own namespace.
    await env.DB.prepare(
      `INSERT INTO pithy_payments_purchases (${PURCHASE_COLUMNS}) VALUES ('p3', 'u1', 'google', 't1', 'pro_monthly', 'pro_monthly', 'subscription', 'active', 'production', 0, null, null, null, 999, 'USD', 0, '{}', 0, 0)`,
    ).run();
  });

  test("the environment CHECK refuses anything but production or sandbox", async () => {
    await expect(insertPurchase({ environment: "staging" })).rejects.toThrow(/CHECK constraint failed/i);
  });

  test("the amount CHECK refuses a negative amount, and allows the null a rail reports for a renewal", async () => {
    await expect(insertPurchase({ amount: "-1" })).rejects.toThrow(/CHECK constraint failed/i);
    await insertPurchase({ id: "p4", transaction: "t4", amount: "null" });
  });

  test("UNIQUE (userId, entitlement) refuses a second row for one user's entitlement", async () => {
    const insert = (id: string) =>
      env.DB.prepare(
        `INSERT INTO pithy_payments_entitlements (id, user_id, entitlement, active, expires_at, source_purchase_id, created_at, updated_at) VALUES ('${id}', 'u1', 'pro', 1, null, null, 0, 0)`,
      ).run();
    await insert("e1");
    // This is what makes the table a read model rather than a log — the upsert conflict target.
    await expect(insert("e2")).rejects.toThrow(/UNIQUE constraint failed/i);
  });

  test("the entitlement active CHECK refuses anything but 0 or 1", async () => {
    await expect(
      env.DB.prepare(
        "INSERT INTO pithy_payments_entitlements (id, user_id, entitlement, active, expires_at, source_purchase_id, created_at, updated_at) VALUES ('e3', 'u2', 'pro', 2, null, null, 0, 0)",
      ).run(),
    ).rejects.toThrow(/CHECK constraint failed/i);
  });

  test("UNIQUE (rail, providerAccountId) refuses mapping one provider identity to two users", async () => {
    const insert = (id: string, userId: string) =>
      env.DB.prepare(
        `INSERT INTO pithy_payments_provider_accounts (id, rail, provider_account_id, user_id, created_at) VALUES ('${id}', 'stripe', 'cus_123', '${userId}', 0)`,
      ).run();
    await insert("a1", "u1");
    // A webhook resolves a user through this row, so two of them would make the answer a coin flip.
    await expect(insert("a2", "u2")).rejects.toThrow(/UNIQUE constraint failed/i);
  });

  test("UNIQUE (rail, providerEventId) refuses recording one delivery twice", async () => {
    const insert = (id: string) =>
      env.DB.prepare(
        `INSERT INTO pithy_payments_webhook_events (id, rail, provider_event_id, payload, received_at, processed_at, error, created_at) VALUES ('${id}', 'stripe', 'evt_1Abc', '{}', 0, null, null, 0)`,
      ).run();
    await insert("w1");
    // All three providers retry, so a redelivery is the normal case and must be recognized, not reprocessed.
    await expect(insert("w2")).rejects.toThrow(/UNIQUE constraint failed/i);
  });

  test("the purchase listing plans on its index rather than sorting the table", async () => {
    // SQLite's own answer, not ours. `USE TEMP B-TREE FOR ORDER BY` in this plan is the defect the
    // index exists to prevent, and it is the one thing a correctness test of the read can never catch.
    const { results } = await env.DB.prepare(
      "EXPLAIN QUERY PLAN SELECT id FROM pithy_payments_purchases ORDER BY purchased_at DESC, id DESC LIMIT 26",
    ).all<{ detail: string }>();
    const plan = results.map((row) => row.detail).join(" | ");
    expect(plan).toContain("pithy_payments_purchases_purchased_idx");
    expect(plan).not.toContain("TEMP B-TREE");
  });

  test("the subscription listing plans on its own index", async () => {
    const { results } = await env.DB.prepare(
      "EXPLAIN QUERY PLAN SELECT id FROM pithy_payments_purchases WHERE type = 'subscription' ORDER BY purchased_at DESC, id DESC LIMIT 26",
    ).all<{ detail: string }>();
    const plan = results.map((row) => row.detail).join(" | ");
    expect(plan).toContain("pithy_payments_purchases_type_purchased_idx");
    expect(plan).not.toContain("TEMP B-TREE");
  });

  test("the entitlement listing plans on its own index", async () => {
    const { results } = await env.DB.prepare(
      "EXPLAIN QUERY PLAN SELECT id FROM pithy_payments_entitlements ORDER BY created_at DESC, id DESC LIMIT 26",
    ).all<{ detail: string }>();
    const plan = results.map((row) => row.detail).join(" | ");
    expect(plan).toContain("pithy_payments_entitlements_created_idx");
    expect(plan).not.toContain("TEMP B-TREE");
  });

  test("down is the exact inverse, with rows recorded, and up is re-runnable after it", async () => {
    // Rolled back against a populated database: `down` drops every index before the table it belongs
    // to, and a rollback only ever run on an empty schema is a rollback nobody has tested.
    await insertPurchase();
    await payments_0001_purchases.down?.(db());
    expect(await catalog()).toEqual([]);
    await payments_0001_purchases.up(db());
    expect(await catalog()).toEqual(EXPECTED_CATALOG);
  });
});
