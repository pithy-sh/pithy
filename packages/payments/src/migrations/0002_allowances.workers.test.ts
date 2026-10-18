// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { payments_0001_purchases } from "./0001_purchases";
import { payments_0002_allowances } from "./0002_allowances";

const db = () => createDatabase(env.DB, {}) as unknown as Kysely<unknown>;

/** Every table either migration creates, dropped before each case so `up` always starts from nothing. */
const TABLES = [
  "pithy_payments_purchases",
  "pithy_payments_entitlements",
  "pithy_payments_provider_accounts",
  "pithy_payments_webhook_events",
  "pithy_payments_reconcile_runs",
  "pithy_payments_sync_cursors",
  "pithy_payments_overrides",
  "pithy_payments_meter_counters",
  "pithy_payments_usage_reports",
  "pithy_payments_usage_runs",
];

/** The objects `0002` adds, by name — written out, because an index a read was planned on is part of its contract. */
const ADDED = [
  "pithy_payments_meter_counters",
  "pithy_payments_overrides",
  "pithy_payments_overrides_unrestricted_idx",
  "pithy_payments_overrides_updated_idx",
  "pithy_payments_usage_reports",
  "pithy_payments_usage_runs",
  "pithy_payments_usage_runs_started_idx",
];

async function names(): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE name LIKE 'pithy_payments_%' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all<{ name: string }>();
  return results.map((row) => row.name);
}

async function purchaseColumns(): Promise<string[]> {
  const { results } = await env.DB.prepare("PRAGMA table_info(pithy_payments_purchases)").all<{ name: string }>();
  return results.map((row) => row.name);
}

const insertOverride = (id: string, subjectType = "organization", version = 1, unrestricted = 0) =>
  env.DB.prepare(
    `INSERT INTO pithy_payments_overrides (id, subject_type, subject_id, unrestricted, quotas, features, version, reason, created_at, updated_at) VALUES ('${id}', '${subjectType}', 'acme', ${unrestricted}, '{}', '{}', ${version}, 'contract', 0, 0)`,
  ).run();

const insertCounter = (id: string, periodStart: number, used = 1) =>
  env.DB.prepare(
    `INSERT INTO pithy_payments_meter_counters (id, subject_type, subject_id, meter, period_start, used, created_at, updated_at) VALUES ('${id}', 'organization', 'acme', 'emails', ${periodStart}, ${used}, 0, 0)`,
  ).run();

const insertReport = (id: string, period: string, status = "reported") =>
  env.DB.prepare(
    `INSERT INTO pithy_payments_usage_reports (id, rail, provider_subscription_id, purchase_id, product_id, subject_type, subject_id, cadence, period, quantity, status, sampled_at, reported_at, created_at, updated_at) VALUES ('${id}', 'stripe', 'sub_1', 'p1', 'academy_seats', 'organization', 'acme', 'period-end', '${period}', 25, '${status}', 0, 0, 0, 0)`,
  ).run();

beforeEach(async () => {
  for (const table of TABLES) await env.DB.exec(`DROP TABLE IF EXISTS ${table}`);
  await payments_0001_purchases.up(db());
  await payments_0002_allowances.up(db());
});

describe("payments_0002_allowances", () => {
  test("up adds four tables, their indexes, and a quantity column — and leaves 0001's objects alone", async () => {
    const all = await names();
    for (const name of ADDED) expect(all).toContain(name);
    expect(all.filter((name) => !ADDED.includes(name))).toHaveLength(13);
    expect(await purchaseColumns()).toContain("quantity");
  });

  test("one override per subject, and a user and an organization sharing an id are two", async () => {
    await insertOverride("o1");
    await expect(insertOverride("o2")).rejects.toThrow(/UNIQUE constraint failed/i);
    await insertOverride("o3", "user");
  });

  test("an override's version starts at 1 and its subject kind is closed", async () => {
    await expect(insertOverride("o1", "organization", 0)).rejects.toThrow(/CHECK constraint failed/i);
    await expect(insertOverride("o2", "org")).rejects.toThrow(/CHECK constraint failed/i);
    await expect(insertOverride("o3", "organization", 1, 2)).rejects.toThrow(/CHECK constraint failed/i);
  });

  test("one counter per subject, meter and period — a new period is a new row", async () => {
    await insertCounter("c1", 1000);
    await expect(insertCounter("c2", 1000)).rejects.toThrow(/UNIQUE constraint failed/i);
    await insertCounter("c3", 2000);
    await expect(insertCounter("c4", 3000, -1)).rejects.toThrow(/CHECK constraint failed/i);
  });

  test("one report per rail, subscription and period — the idempotency key", async () => {
    await insertReport("r1", "2026-10-01T00:00:00.000Z");
    await expect(insertReport("r2", "2026-10-01T00:00:00.000Z")).rejects.toThrow(/UNIQUE constraint failed/i);
    await expect(insertReport("r3", "2026-11-01T00:00:00.000Z", "pending")).rejects.toThrow(/CHECK constraint failed/i);
  });

  test("down is the exact inverse, with rows recorded, and up is re-runnable after it", async () => {
    await insertOverride("o1");
    await insertCounter("c1", 1000);
    await insertReport("r1", "2026-10-01T00:00:00.000Z");
    await payments_0002_allowances.down?.(db());
    const all = await names();
    for (const name of ADDED) expect(all).not.toContain(name);
    expect(await purchaseColumns()).not.toContain("quantity");
    await payments_0002_allowances.up(db());
    for (const name of ADDED) expect(await names()).toContain(name);
  });
});
