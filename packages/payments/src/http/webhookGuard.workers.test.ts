// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { PAYMENTS_WEBHOOK_EVENTS_TABLE, paymentsDatabase } from "../data/tables";
import { PaymentsWebhookEvent } from "../data/webhookEvent";
import { payments_0001_purchases } from "../migrations/0001_purchases";
import { payments_0002_allowances } from "../migrations/0002_allowances";
import { payments_0003_webhook_targets } from "../migrations/0003_webhook_targets";
import { completeWebhook } from "./webhookGuard";

/**
 * `completeWebhook`, executed against real D1 (#830). Three outcomes and three different records of what the
 * event changed: a failure records nothing, a note records that it changed nothing, a projection records what
 * it changed. The routes reach two of the three; this holds all of them, the note's above all.
 */

const RECEIVED = new Date("2026-10-05T09:00:00.000Z");
const FINISHED = new Date("2026-10-05T09:01:00.000Z");

beforeEach(async () => {
  for (const table of [
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
  ]) {
    await env.DB.exec(`DROP TABLE IF EXISTS ${table}`);
  }
  await payments_0001_purchases.up(createDatabase(env.DB, {}) as unknown as Kysely<unknown>);
  await payments_0002_allowances.up(createDatabase(env.DB, {}) as unknown as Kysely<unknown>);
  await payments_0003_webhook_targets.up(createDatabase(env.DB, {}) as unknown as Kysely<unknown>);
  await paymentsDatabase(env.DB)
    .insertInto(PAYMENTS_WEBHOOK_EVENTS_TABLE)
    .values(
      PaymentsWebhookEvent.encode({
        id: "row-1",
        rail: "stripe",
        providerEventId: "evt_1",
        payload: { type: "invoice.paid" },
        receivedAt: RECEIVED,
        processedAt: null,
        error: null,
        projectedTargets: null,
        createdAt: RECEIVED,
      }),
    )
    .execute();
});

async function row(): Promise<PaymentsWebhookEvent> {
  const stored = await paymentsDatabase(env.DB)
    .selectFrom(PAYMENTS_WEBHOOK_EVENTS_TABLE)
    .selectAll()
    .where("id", "=", "row-1")
    .executeTakeFirstOrThrow();
  return PaymentsWebhookEvent.parse(stored);
}

describe("completeWebhook", () => {
  test("a failure stays unfinished and records nothing it changed", async () => {
    await completeWebhook(env.DB, "row-1", { at: FINISHED, error: "projection failed" });
    const stored = await row();
    expect(stored.processedAt).toBeNull();
    expect(stored.error).toBe("projection failed");
    expect(stored.projectedTargets).toBeNull();
  });

  test("a note finishes the event and records that it changed nothing — two empty lists, not null", async () => {
    await completeWebhook(env.DB, "row-1", { at: FINISHED, note: "a partial refund takes nothing away" });
    const stored = await row();
    expect(stored.processedAt).toEqual(FINISHED);
    expect(stored.error).toBe("a partial refund takes nothing away");
    expect(stored.projectedTargets).toEqual({ purchaseIds: [], subscriptionIds: [] });
  });

  test("a projection finishes the event and records every row it changed", async () => {
    const targets = { purchaseIds: ["p-1", "p-2"], subscriptionIds: ["s-1"] };
    await completeWebhook(env.DB, "row-1", { at: FINISHED, targets });
    const stored = await row();
    expect(stored.processedAt).toEqual(FINISHED);
    expect(stored.error).toBeNull();
    expect(stored.projectedTargets).toEqual(targets);
  });

  test("a failure after a recorded projection leaves what was recorded alone", async () => {
    const targets = { purchaseIds: ["p-1"], subscriptionIds: [] };
    await completeWebhook(env.DB, "row-1", { at: FINISHED, targets });
    await completeWebhook(env.DB, "row-1", { at: new Date(FINISHED.getTime() + 60_000), error: "later failure" });
    const stored = await row();
    expect(stored.processedAt).toBeNull();
    expect(stored.error).toBe("later failure");
    expect(stored.projectedTargets).toEqual(targets);
  });
});
