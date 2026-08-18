// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import { entitlementGrantsAccess, grantedEntitlementKeys } from "@pithy-sh/core/src/entitlement/entitlement";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import type { PaymentsSubject } from "../data/subject";
import { paymentsDatabase } from "../data/tables";
import { payments_0001_purchases } from "../migrations/0001_purchases";
import { resolveEntitlements } from "./resolve";

const SECOND = 1000;
const DAY = 86_400 * SECOND;
const T0 = 1_700_000_000_000;

const db = () => paymentsDatabase(env.DB);

/** The person most of these read as. */
const ADA: PaymentsSubject = { subjectType: "user", subjectId: "ada" };

/** Write an entitlement row directly, so the read path is tested without the writer's derivation in the way. */
async function row(options: {
  id: string;
  subject: PaymentsSubject;
  entitlement: string;
  active: 0 | 1;
  expiresAt: number | null;
  sourcePurchaseId?: string | null;
}) {
  await env.DB.prepare(
    "INSERT INTO pithy_payments_entitlements (id, subject_type, subject_id, entitlement, active, expires_at, source_purchase_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      options.id,
      options.subject.subjectType,
      options.subject.subjectId,
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
      subject: ADA,
      entitlement: "pro",
      active: 1,
      expiresAt: T0 + 30 * DAY,
      sourcePurchaseId: "p1",
    });

    const resolved = await resolveEntitlements(db(), ADA, new Date(T0));
    expect(resolved).toEqual([{ key: "pro", active: true, expiresAt: new Date(T0 + 30 * DAY), source: "p1" }]);
    expect(entitlementGrantsAccess(resolved[0] as never, new Date(T0))).toBe(true);
  });

  test("a row that still says active = 1 with a past expiry does not grant — the timestamp is the truth", async () => {
    // The lapse nobody was told about. A store can simply stop renewing, so the flag the projection wrote is
    // an optimization and `expiresAt` is what decides. This is why the read applies it rather than trusting
    // the flag, and why a read still never writes.
    await row({ id: "e1", subject: ADA, entitlement: "pro", active: 1, expiresAt: T0 - DAY, sourcePurchaseId: "p1" });

    const resolved = await resolveEntitlements(db(), ADA, new Date(T0));
    expect(resolved[0]?.active).toBe(false);
    expect(grantedEntitlementKeys(resolved, new Date(T0)).size).toBe(0);
    // The row and its date survive, so a paywall can say when access ended.
    expect(resolved[0]?.expiresAt).toEqual(new Date(T0 - DAY));
  });

  test("expiry is exclusive at the boundary — the instant it expires, it has expired", async () => {
    await row({ id: "e1", subject: ADA, entitlement: "pro", active: 1, expiresAt: T0 });
    expect((await resolveEntitlements(db(), ADA, new Date(T0)))[0]?.active).toBe(false);
    expect((await resolveEntitlements(db(), ADA, new Date(T0 - 1)))[0]?.active).toBe(true);
  });

  test("a grant with no expiry keeps granting forever — a non-consumable is owned, not rented", async () => {
    await row({ id: "e1", subject: ADA, entitlement: "ads_removed", active: 1, expiresAt: null });
    const resolved = await resolveEntitlements(db(), ADA, new Date(T0 + 3650 * DAY));
    expect(resolved[0]?.active).toBe(true);
    expect(resolved[0]?.expiresAt).toBe(null);
  });

  test("an inactive row never grants, whatever its expiry says", async () => {
    await row({ id: "e1", subject: ADA, entitlement: "pro", active: 0, expiresAt: T0 + 30 * DAY });
    expect((await resolveEntitlements(db(), ADA, new Date(T0)))[0]?.active).toBe(false);
  });

  test("resolves only the caller's own rows, in key order", async () => {
    const grace: PaymentsSubject = { subjectType: "user", subjectId: "grace" };
    await row({ id: "e1", subject: ADA, entitlement: "pro", active: 1, expiresAt: null });
    await row({ id: "e2", subject: ADA, entitlement: "ads_removed", active: 1, expiresAt: null });
    await row({ id: "e3", subject: grace, entitlement: "pro", active: 1, expiresAt: null });

    expect((await resolveEntitlements(db(), ADA, new Date(T0))).map((e) => e.key)).toEqual(["ads_removed", "pro"]);
    expect((await resolveEntitlements(db(), grace, new Date(T0))).map((e) => e.key)).toEqual(["pro"]);
  });

  test("a subject with no rows holds nothing, which is not an error", async () => {
    expect(await resolveEntitlements(db(), { subjectType: "user", subjectId: "nobody" }, new Date(T0))).toEqual([]);
  });

  test("the read does not write — resolving twice leaves the row byte-identical", async () => {
    await row({ id: "e1", subject: ADA, entitlement: "pro", active: 1, expiresAt: T0 - DAY });
    const before = await env.DB.prepare("SELECT * FROM pithy_payments_entitlements").all();
    await resolveEntitlements(db(), ADA, new Date(T0));
    await resolveEntitlements(db(), ADA, new Date(T0 + DAY));
    // Repairing a stale row belongs to the reconciliation Workflow. The hot path stays a pure read.
    expect((await env.DB.prepare("SELECT * FROM pithy_payments_entitlements").all()).results).toEqual(before.results);
  });
});

/**
 * The half a user-keyed read never had to answer: *which kind of holder*.
 *
 * Both halves are in the `where`, and both are load-bearing. Nothing in the kit keeps an organization id
 * from equalling some user's id — the two namespaces are minted by different things and neither knows about
 * the other — so a read that filtered on the id alone would hand one holder the other's grants. That is not
 * a leak of a name or a timestamp; it is somebody reading a plan they never bought.
 */
describe("the subject filter", () => {
  const acmeOrg: PaymentsSubject = { subjectType: "organization", subjectId: "acme" };
  const acmeUser: PaymentsSubject = { subjectType: "user", subjectId: "acme" };
  const otherOrg: PaymentsSubject = { subjectType: "organization", subjectId: "other" };

  beforeEach(async () => {
    await row({ id: "e1", subject: acmeOrg, entitlement: "team", active: 1, expiresAt: null });
  });

  test("an organization reads its own grant", async () => {
    expect((await resolveEntitlements(db(), acmeOrg, new Date(T0))).map((e) => e.key)).toEqual(["team"]);
  });

  test("a different organization reads nothing", async () => {
    expect(await resolveEntitlements(db(), otherOrg, new Date(T0))).toEqual([]);
  });

  test("the same id under the other kind reads nothing", async () => {
    // The collision the pair exists for. `user:acme` and `organization:acme` are two holders, and one of
    // them paid.
    expect(await resolveEntitlements(db(), acmeUser, new Date(T0))).toEqual([]);
  });

  test("a user and an organization sharing an id hold their own keys, and only their own", async () => {
    // Both rows are legal at once — the unique is on the pair plus the key — so the read is the only thing
    // keeping them apart.
    await row({ id: "e2", subject: acmeUser, entitlement: "pro", active: 1, expiresAt: null });
    expect((await resolveEntitlements(db(), acmeUser, new Date(T0))).map((e) => e.key)).toEqual(["pro"]);
    expect((await resolveEntitlements(db(), acmeOrg, new Date(T0))).map((e) => e.key)).toEqual(["team"]);
  });
});
