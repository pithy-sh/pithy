// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import { entitlementGrantsAccess, grantedEntitlementKeys } from "@pithy-sh/core/src/entitlement/entitlement";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { paymentsDatabase } from "../data/tables";
import { payments_0001_purchases } from "../migrations/0001_purchases";
import { resolveEntitlements } from "./resolve";

const SECOND = 1000;
const DAY = 86_400 * SECOND;
const T0 = 1_700_000_000_000;

const db = () => paymentsDatabase(env.DB);

/** Write an entitlement row directly, so the read path is tested without the writer's derivation in the way. */
async function row(options: {
  id: string;
  userId: string;
  entitlement: string;
  active: 0 | 1;
  expiresAt: number | null;
  sourcePurchaseId?: string | null;
}) {
  await env.DB.prepare(
    "INSERT INTO pithy_payments_entitlements (id, user_id, entitlement, active, expires_at, source_purchase_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      options.id,
      options.userId,
      options.entitlement,
      options.active,
      options.expiresAt,
      options.sourcePurchaseId ?? null,
      T0,
      T0,
    )
    .run();
}

beforeEach(async () => {
  await env.DB.exec("DROP TABLE IF EXISTS pithy_payments_entitlements");
  await env.DB.exec("DROP TABLE IF EXISTS pithy_payments_purchases");
  await env.DB.exec("DROP TABLE IF EXISTS pithy_payments_provider_accounts");
  await env.DB.exec("DROP TABLE IF EXISTS pithy_payments_webhook_events");
  await env.DB.exec("DROP TABLE IF EXISTS pithy_payments_reconcile_runs");
  await env.DB.exec("DROP TABLE IF EXISTS pithy_payments_sync_cursors");
  await payments_0001_purchases.up(createDatabase(env.DB, {}) as unknown as Kysely<unknown>);
});

describe("resolveEntitlements", () => {
  test("returns a live grant as granting, in the core seam's shape", async () => {
    await row({
      id: "e1",
      userId: "ada",
      entitlement: "pro",
      active: 1,
      expiresAt: T0 + 30 * DAY,
      sourcePurchaseId: "p1",
    });

    const resolved = await resolveEntitlements(db(), "ada", new Date(T0));
    expect(resolved).toEqual([{ key: "pro", active: true, expiresAt: new Date(T0 + 30 * DAY), source: "p1" }]);
    expect(entitlementGrantsAccess(resolved[0] as never, new Date(T0))).toBe(true);
  });

  test("a row that still says active = 1 with a past expiry does not grant — the timestamp is the truth", async () => {
    // The lapse nobody was told about. A store can simply stop renewing, so the flag the projection wrote is
    // an optimization and `expiresAt` is what decides. This is why the read applies it rather than trusting
    // the flag, and why a read still never writes.
    await row({ id: "e1", userId: "ada", entitlement: "pro", active: 1, expiresAt: T0 - DAY, sourcePurchaseId: "p1" });

    const resolved = await resolveEntitlements(db(), "ada", new Date(T0));
    expect(resolved[0]?.active).toBe(false);
    expect(grantedEntitlementKeys(resolved, new Date(T0)).size).toBe(0);
    // The row and its date survive, so a paywall can say when access ended.
    expect(resolved[0]?.expiresAt).toEqual(new Date(T0 - DAY));
  });

  test("expiry is exclusive at the boundary — the instant it expires, it has expired", async () => {
    await row({ id: "e1", userId: "ada", entitlement: "pro", active: 1, expiresAt: T0 });
    expect((await resolveEntitlements(db(), "ada", new Date(T0)))[0]?.active).toBe(false);
    expect((await resolveEntitlements(db(), "ada", new Date(T0 - 1)))[0]?.active).toBe(true);
  });

  test("a grant with no expiry keeps granting forever — a non-consumable is owned, not rented", async () => {
    await row({ id: "e1", userId: "ada", entitlement: "ads_removed", active: 1, expiresAt: null });
    const resolved = await resolveEntitlements(db(), "ada", new Date(T0 + 3650 * DAY));
    expect(resolved[0]?.active).toBe(true);
    expect(resolved[0]?.expiresAt).toBe(null);
  });

  test("an inactive row never grants, whatever its expiry says", async () => {
    await row({ id: "e1", userId: "ada", entitlement: "pro", active: 0, expiresAt: T0 + 30 * DAY });
    expect((await resolveEntitlements(db(), "ada", new Date(T0)))[0]?.active).toBe(false);
  });

  test("resolves only the caller's own rows, in key order", async () => {
    await row({ id: "e1", userId: "ada", entitlement: "pro", active: 1, expiresAt: null });
    await row({ id: "e2", userId: "ada", entitlement: "ads_removed", active: 1, expiresAt: null });
    await row({ id: "e3", userId: "grace", entitlement: "pro", active: 1, expiresAt: null });

    expect((await resolveEntitlements(db(), "ada", new Date(T0))).map((e) => e.key)).toEqual(["ads_removed", "pro"]);
    expect((await resolveEntitlements(db(), "grace", new Date(T0))).map((e) => e.key)).toEqual(["pro"]);
  });

  test("a user with no rows holds nothing, which is not an error", async () => {
    expect(await resolveEntitlements(db(), "nobody", new Date(T0))).toEqual([]);
  });

  test("the read does not write — resolving twice leaves the row byte-identical", async () => {
    await row({ id: "e1", userId: "ada", entitlement: "pro", active: 1, expiresAt: T0 - DAY });
    const before = await env.DB.prepare("SELECT * FROM pithy_payments_entitlements").all();
    await resolveEntitlements(db(), "ada", new Date(T0));
    await resolveEntitlements(db(), "ada", new Date(T0 + DAY));
    // Repairing a stale row belongs to the reconciliation Workflow. The hot path stays a pure read.
    expect((await env.DB.prepare("SELECT * FROM pithy_payments_entitlements").all()).results).toEqual(before.results);
  });
});
