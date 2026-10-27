// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { credentialFields, isRetained } from "@pithy-sh/core/src/capability/purge";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { payments } from "../capability";
import { payments_0001_purchases } from "../migrations/0001_purchases";
import { payments_0002_allowances } from "../migrations/0002_allowances";
import { payments_0003_webhook_targets } from "../migrations/0003_webhook_targets";
import { PAYMENTS_PURGE_SUMMARY, PAYMENTS_RETENTION_BASIS, paymentsUserPurge } from "./contribution";

/**
 * Payments' part of a person's purge and export (#814), over real D1: it retains, with a basis, and its export answers
 * for a user subject's rows — never an organization's under the same id, and never the provider's payload.
 */

const purge = paymentsUserPurge();
const context = (id: string) => ({ subject: { type: "user" as const, id }, env: { DB: env.DB } });

async function exportOf(id: string): Promise<Record<string, unknown>> {
  if (!purge.export) throw new Error("no export declared");
  return purge.export(context(id));
}

const PURCHASE =
  "INSERT INTO pithy_payments_purchases (id, subject_type, subject_id, rail, provider_transaction_id, product_id, provider_product_id, type, status, environment, purchased_at, amount_minor, currency, provider_event_at, payload, created_at, updated_at) VALUES (?, ?, ?, 'google', ?, 'pro', 'com.acme.pro', 'subscription', 'active', 'production', ?, 999, 'USD', 0, ?, 0, 0)";

beforeEach(async () => {
  const { results } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'pithy_payments_%'",
  ).all<{ name: string }>();
  for (const { name } of results) await env.DB.exec(`DROP TABLE IF EXISTS ${name}`);
  const db = createDatabase(env.DB, {}) as unknown as Kysely<unknown>;
  for (const migration of [payments_0001_purchases, payments_0002_allowances, payments_0003_webhook_targets]) {
    await migration.up(db);
  }
  const payload = JSON.stringify({ purchaseToken: "secret-google-token" });
  await env.DB.prepare(PURCHASE).bind("p1", "user", "ada", "t1", 1, payload).run();
  await env.DB.prepare(PURCHASE).bind("p2", "organization", "ada", "t2", 2, payload).run();
  await env.DB.prepare(PURCHASE).bind("p3", "user", "bob", "t3", 3, payload).run();
  await env.DB.prepare(
    "INSERT INTO pithy_payments_entitlements (id, subject_type, subject_id, entitlement, active, source_purchase_id, created_at, updated_at) VALUES ('e1', 'user', 'ada', 'pro', 1, 'p1', 0, 0)",
  ).run();
  await env.DB.prepare(
    "INSERT INTO pithy_payments_provider_accounts (id, rail, provider_account_id, subject_type, subject_id, created_at) VALUES ('a1', 'stripe', 'cus_123', 'user', 'ada', 0)",
  ).run();
});

describe("the payments user purge", () => {
  test("payments() declares it for the user subject: retained, with a basis and an export, and no erase", () => {
    const declared = payments({ billingSubject: "user" }).purge ?? [];
    expect(declared.map((contribution) => contribution.subject)).toEqual(["user"]);
    const [contribution] = declared;
    expect(contribution?.summary).toBe(PAYMENTS_PURGE_SUMMARY);
    expect(contribution && isRetained(contribution)).toBe(true);
    expect(contribution?.retain?.basis).toBe(PAYMENTS_RETENTION_BASIS);
    expect(contribution?.erase).toBeUndefined();
  });

  test("exports a user subject's purchases, entitlements and provider accounts, and no organization's", async () => {
    const data = await exportOf("ada");
    expect((data.purchases as { id: string }[]).map((row) => row.id)).toEqual(["p1"]);
    expect(data.entitlements).toEqual([expect.objectContaining({ id: "e1", entitlement: "pro", active: true })]);
    expect(data.providerAccounts).toEqual([expect.objectContaining({ providerAccountId: "cus_123" })]);
    expect(data.overrides).toEqual([]);
    expect(data.meterCounters).toEqual([]);
    expect(data.usageReports).toEqual([]);
  });

  test("never a Google Play purchase token, wherever the projection keeps it", async () => {
    const PLAY =
      "INSERT INTO pithy_payments_purchases (id, subject_type, subject_id, rail, provider_transaction_id, original_transaction_id, product_id, provider_product_id, type, status, environment, purchased_at, provider_event_at, payload, created_at, updated_at) VALUES (?, 'user', 'ada', ?, ?, ?, 'pro', 'com.acme.pro', ?, ?, 'production', ?, 0, ?, 0, 0)";
    const statements = [
      // A paid renewal: keyed on its order id, chained to the family by the token.
      [
        "g-paid",
        "google",
        "GPA.1111-2222",
        "play-token-subscription",
        "subscription",
        "active",
        10,
        { latestOrderId: "GPA.1111-2222" },
      ],
      // A subscription never paid for: no order yet, so the token keys it too.
      ["g-unpaid", "google", "play-token-unpaid", "play-token-unpaid", "subscription", "never_paid", 11, {}],
      // A pending one-time purchase: keyed on the token until its order arrives.
      ["g-pending", "google", "play-token-pending", null, "non_consumable", "never_paid", 12, { purchaseState: 2 }],
      // Another rail's ids are the person's record and stay.
      ["s-1", "stripe", "pi_123", "sub_456", "subscription", "active", 13, {}],
    ].map(([id, rail, transaction, original, type, status, at, payload]) =>
      env.DB.prepare(PLAY).bind(id, rail, transaction, original, type, status, at, JSON.stringify(payload)),
    );
    await env.DB.batch(statements);
    const data = await exportOf("ada");
    const text = JSON.stringify(data);
    for (const token of ["play-token-subscription", "play-token-unpaid", "play-token-pending"]) {
      expect(text).not.toContain(token);
    }
    const byId = Object.fromEntries((data.purchases as { id: string }[]).map((row) => [row.id, row]));
    expect(byId["g-paid"]).toMatchObject({ providerTransactionId: "GPA.1111-2222", originalTransactionId: null });
    expect(byId["g-unpaid"]).toMatchObject({ providerTransactionId: null, originalTransactionId: null });
    expect(byId["g-pending"]).toMatchObject({ providerTransactionId: null });
    expect(byId["s-1"]).toMatchObject({ providerTransactionId: "pi_123", originalTransactionId: "sub_456" });
  });

  test("never the provider's payload, and no credential", async () => {
    const data = await exportOf("ada");
    expect(JSON.stringify(data)).not.toContain("secret-google-token");
    expect(credentialFields(data)).toEqual([]);
  });
});
