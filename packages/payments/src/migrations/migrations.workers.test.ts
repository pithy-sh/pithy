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
  "pithy_payments_sync_cursors",
];

/** Every payments object SQLite knows about, by name. Proves the `pithy_payments_` prefix rather than trusting it. */
async function catalog(): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE name LIKE 'pithy_payments_%' ORDER BY name",
  ).all<{ name: string }>();
  return results.map((r) => r.name);
}

/**
 * Every object the one migration creates, in `sqlite_master` name order — six tables and seven indexes.
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
  "pithy_payments_sync_cursors",
  "pithy_payments_webhook_events",
  "pithy_payments_webhook_events_pending_idx",
];

/** A complete purchase row, so a constraint test varies exactly one column. */
const PURCHASE_COLUMNS =
  "id, subject_type, subject_id, rail, provider_transaction_id, product_id, provider_product_id, type, status, environment, purchased_at, expires_at, revoked_at, original_transaction_id, amount_minor, currency, provider_event_at, payload, created_at, updated_at";

function purchaseValues(
  overrides: { id?: string; transaction?: string; environment?: string; amount?: string; subjectType?: string } = {},
) {
  const id = overrides.id ?? "p1";
  const transaction = overrides.transaction ?? "t1";
  const environment = overrides.environment ?? "production";
  const amount = overrides.amount ?? "999";
  const subjectType = overrides.subjectType ?? "user";
  return `('${id}', '${subjectType}', 'ada', 'apple', '${transaction}', 'pro_monthly', 'com.acme.pro.monthly', 'subscription', 'active', '${environment}', 0, null, null, null, ${amount}, 'USD', 0, '{}', 0, 0)`;
}

/** An entitlement row, varying only the holder and the key. `manual` is defaulted, as a writer leaves it. */
const insertEntitlement = (id: string, subjectType: string, subjectId: string, entitlement = "pro") =>
  env.DB.prepare(
    `INSERT INTO pithy_payments_entitlements (id, subject_type, subject_id, entitlement, active, expires_at, source_purchase_id, created_at, updated_at) VALUES ('${id}', '${subjectType}', '${subjectId}', '${entitlement}', 1, null, null, 0, 0)`,
  ).run();

/** A provider-identity link, varying only the holder. */
const insertProviderAccount = (id: string, subjectType: string, subjectId: string, providerAccountId = "cus_123") =>
  env.DB.prepare(
    `INSERT INTO pithy_payments_provider_accounts (id, rail, provider_account_id, subject_type, subject_id, created_at) VALUES ('${id}', 'stripe', '${providerAccountId}', '${subjectType}', '${subjectId}', 0)`,
  ).run();

const insertPurchase = (overrides?: Parameters<typeof purchaseValues>[0]) =>
  env.DB.prepare(
    `INSERT INTO pithy_payments_purchases (${PURCHASE_COLUMNS}) VALUES ${purchaseValues(overrides)}`,
  ).run();

beforeEach(async () => {
  for (const table of TABLES) await env.DB.exec(`DROP TABLE IF EXISTS ${table}`);
  await payments_0001_purchases.up(db());
});

describe("payments_0001_purchases", () => {
  test("up creates the six tables and all seven indexes, all prefixed pithy_payments_", async () => {
    // The exact catalog, not a `toContain`: a table added without a prefix, or an index quietly renamed
    // or dropped, has to fail here rather than in an adopter's database. Six tables, and seven indexes — three for the
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
      `INSERT INTO pithy_payments_purchases (${PURCHASE_COLUMNS}) VALUES ('p3', 'user', 'ada', 'google', 't1', 'pro_monthly', 'pro_monthly', 'subscription', 'active', 'production', 0, null, null, null, 999, 'USD', 0, '{}', 0, 0)`,
    ).run();
  });

  test("the environment CHECK refuses anything but production or sandbox", async () => {
    await expect(insertPurchase({ environment: "staging" })).rejects.toThrow(/CHECK constraint failed/i);
  });

  test("the amount CHECK refuses a negative amount, and allows the null a rail reports for a renewal", async () => {
    await expect(insertPurchase({ amount: "-1" })).rejects.toThrow(/CHECK constraint failed/i);
    await insertPurchase({ id: "p4", transaction: "t4", amount: "null" });
  });

  test("UNIQUE (subjectType, subjectId, entitlement) refuses a second row for one subject's entitlement", async () => {
    await insertEntitlement("e1", "user", "ada");
    // This is what makes the table a read model rather than a log — the upsert conflict target.
    await expect(insertEntitlement("e2", "user", "ada")).rejects.toThrow(/UNIQUE constraint failed/i);
  });

  test("the entitlement key is per subject, so a user and an organization sharing an id are two holders", async () => {
    // Nothing in the kit makes the two id namespaces disjoint, and an adopter whose organization ids come
    // from its own model may well mint `acme` for both. Keyed on the id alone, the organization's grant
    // would *be* the user's — one of them silently reading what the other paid for.
    await insertEntitlement("e1", "user", "acme");
    await insertEntitlement("e2", "organization", "acme");
    expect(
      await env.DB.prepare("SELECT count(*) as n FROM pithy_payments_entitlements").first<{ n: number }>(),
    ).toEqual({ n: 2 });
    // And one holder still holds a key once. The kind widened the key; it did not loosen it.
    await expect(insertEntitlement("e3", "organization", "acme")).rejects.toThrow(/UNIQUE constraint failed/i);
  });

  test("the entitlement active CHECK refuses anything but 0 or 1", async () => {
    await expect(
      env.DB.prepare(
        "INSERT INTO pithy_payments_entitlements (id, subject_type, subject_id, entitlement, active, expires_at, source_purchase_id, created_at, updated_at) VALUES ('e3', 'user', 'grace', 'pro', 2, null, null, 0, 0)",
      ).run(),
    ).rejects.toThrow(/CHECK constraint failed/i);
  });

  test("every subject_type CHECK refuses a spelling no gate would ever match", async () => {
    // `organisation` is the British spelling and `team` is the plausible invention. Both are rows nobody
    // is entitled by: every ownership check compares the pair, so a third spelling is a holder that
    // matches nothing and a purchase that grants nothing. The column is closed at the database for the
    // same reason `environment` is — the writer is not the place to trust it.
    for (const bad of ["organisation", "team"]) {
      await expect(insertPurchase({ id: `p_${bad}`, transaction: `t_${bad}`, subjectType: bad })).rejects.toThrow(
        /CHECK constraint failed/i,
      );
      await expect(insertEntitlement(`e_${bad}`, bad, "ada")).rejects.toThrow(/CHECK constraint failed/i);
      await expect(insertProviderAccount(`a_${bad}`, bad, "ada", `cus_${bad}`)).rejects.toThrow(
        /CHECK constraint failed/i,
      );
    }
  });

  test("UNIQUE (rail, providerAccountId) refuses mapping one provider identity to two subjects", async () => {
    await insertProviderAccount("a1", "user", "ada");
    // A webhook resolves a holder through this row, so two of them would make the answer a coin flip.
    await expect(insertProviderAccount("a2", "user", "grace")).rejects.toThrow(/UNIQUE constraint failed/i);
    // And the subject did **not** widen this key. A different kind is still the same provider identity, so
    // an organization cannot claim `cus_123` alongside the user who already holds it and collect the
    // renewals. Rebinding is a deliberate delete, never an insert a purchase flow can make.
    await expect(insertProviderAccount("a3", "organization", "acme")).rejects.toThrow(/UNIQUE constraint failed/i);
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

  test("a webhook event carries both timestamps, each nullable and each defaulting to null", async () => {
    // #337: "this delivery is finished with" and "a repair pass gave up on it" are different claims, and
    // the webhook guard short-circuits on the first alone. One column meaning both is what let a failed
    // delivery and a quarantined sweep event each answer a redelivery `duplicate` for ever.
    const { results } = await env.DB.prepare("PRAGMA table_info(pithy_payments_webhook_events)").all<{
      name: string;
      notnull: number;
      dflt_value: string | null;
    }>();
    const columns = new Map(results.map((row) => [row.name, row]));
    for (const name of ["processed_at", "abandoned_at"]) {
      expect(columns.get(name), name).toBeDefined();
      expect(columns.get(name)?.notnull, name).toBe(0);
      expect(columns.get(name)?.dflt_value, name).toBeNull();
    }

    // And a row written without them really does read back null on both, so "nullable" is the database's
    // behaviour rather than the pragma's opinion.
    await env.DB.prepare(
      "INSERT INTO pithy_payments_webhook_events (id, rail, provider_event_id, payload, received_at, created_at) VALUES ('w0', 'paddle', 'evt_pragma', '{}', 0, 0)",
    ).run();
    const stored = await env.DB.prepare(
      "SELECT processed_at, abandoned_at FROM pithy_payments_webhook_events WHERE id = 'w0'",
    ).first<{ processed_at: number | null; abandoned_at: number | null }>();
    expect(stored).toEqual({ processed_at: null, abandoned_at: null });
  });

  test("the pending read plans on its index — abandoned and failed rows are found, not scanned for", async () => {
    // Everything not yet finished with, oldest first: pending, failed and abandoned alike. An operator
    // hunting the row a sweep gave up on runs exactly this, and a scan over every delivery a store has
    // ever sent is the difference between a usable answer and a timeout.
    const { results } = await env.DB.prepare(
      "EXPLAIN QUERY PLAN SELECT id FROM pithy_payments_webhook_events WHERE processed_at IS NULL ORDER BY received_at",
    ).all<{ detail: string }>();
    const plan = results.map((row) => row.detail).join(" | ");
    expect(plan).toContain("pithy_payments_webhook_events_pending_idx");
    expect(plan).not.toContain("TEMP B-TREE");
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

  test("one subject's entitlements read off the unique's leading columns, with no scan", async () => {
    // The per-holder read has no index of its own, on purpose: the unique starts with both subject
    // columns, so this is a range scan of it — SQLite's own automatic index for the constraint, which is
    // why the name here is `sqlite_autoindex_…` and not one of ours. Put the entitlement first and this
    // read becomes a full scan of every holder's grants, so the plan is asserted rather than assumed.
    const { results } = await env.DB.prepare(
      "EXPLAIN QUERY PLAN SELECT entitlement FROM pithy_payments_entitlements WHERE subject_type = 'user' AND subject_id = 'ada'",
    ).all<{ detail: string }>();
    const plan = results.map((row) => row.detail).join(" | ");
    expect(plan).toContain("USING COVERING INDEX sqlite_autoindex_pithy_payments_entitlements");
    expect(plan).toContain("(subject_type=? AND subject_id=?)");
    expect(plan).not.toContain("SCAN pithy_payments_entitlements");
  });

  test("one subject's purchases read off the owner index, newest first and without a sort", async () => {
    const { results } = await env.DB.prepare(
      "EXPLAIN QUERY PLAN SELECT id FROM pithy_payments_purchases WHERE subject_type = 'user' AND subject_id = 'ada' ORDER BY purchased_at DESC",
    ).all<{ detail: string }>();
    const plan = results.map((row) => row.detail).join(" | ");
    expect(plan).toContain("pithy_payments_purchases_owner_idx");
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
