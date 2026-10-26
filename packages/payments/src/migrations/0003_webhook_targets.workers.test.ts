// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { payments_0001_purchases } from "./0001_purchases";
import { payments_0002_allowances } from "./0002_allowances";
import { payments_0003_webhook_targets } from "./0003_webhook_targets";

const db = () => createDatabase(env.DB, {}) as unknown as Kysely<unknown>;

/** Every table the chain creates, dropped before each case so `up` always starts from nothing. */
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

async function columns(): Promise<string[]> {
  const { results } = await env.DB.prepare("PRAGMA table_info(pithy_payments_webhook_events)").all<{ name: string }>();
  return results.map((row) => row.name);
}

async function indexes(): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'pithy_payments_webhook_events' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all<{ name: string }>();
  return results.map((row) => row.name);
}

/** A row written before `0003` existed — the shape every deployed database already holds. */
const insertOlder = () =>
  env.DB.prepare(
    "INSERT INTO pithy_payments_webhook_events (id, rail, provider_event_id, payload, received_at, processed_at, error, created_at) VALUES ('w-old', 'stripe', 'evt_old', '{}', 1000, 2000, null, 1000)",
  ).run();

beforeEach(async () => {
  for (const table of TABLES) await env.DB.exec(`DROP TABLE IF EXISTS ${table}`);
  await payments_0001_purchases.up(db());
  await payments_0002_allowances.up(db());
});

describe("payments_0003_webhook_targets", () => {
  test("up adds the projected-targets column and the received-order index, and keeps every row", async () => {
    await insertOlder();
    await payments_0003_webhook_targets.up(db());
    expect(await columns()).toContain("projected_targets");
    expect(await indexes()).toContain("pithy_payments_webhook_events_received_idx");
    // An event projected before this column existed reads as unrecorded — null, never an empty list that
    // would claim it changed nothing.
    const row = await env.DB.prepare(
      "SELECT processed_at, projected_targets FROM pithy_payments_webhook_events WHERE id = 'w-old'",
    ).first<{ processed_at: number; projected_targets: string | null }>();
    expect(row).toEqual({ processed_at: 2000, projected_targets: null });
  });

  test("down is the exact inverse, with rows recorded, and up is re-runnable after it", async () => {
    await payments_0003_webhook_targets.up(db());
    await insertOlder();
    await env.DB.prepare(
      `UPDATE pithy_payments_webhook_events SET projected_targets = '{"purchaseIds":[],"subscriptionIds":["s1"]}' WHERE id = 'w-old'`,
    ).run();
    const before = await indexes();
    await payments_0003_webhook_targets.down?.(db());
    expect(await columns()).not.toContain("projected_targets");
    expect(await indexes()).not.toContain("pithy_payments_webhook_events_received_idx");
    expect(await env.DB.prepare("SELECT id FROM pithy_payments_webhook_events").all()).toMatchObject({
      results: [{ id: "w-old" }],
    });
    await payments_0003_webhook_targets.up(db());
    expect(await indexes()).toEqual(before);
    expect(await columns()).toContain("projected_targets");
  });
});
