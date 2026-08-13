// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import type { PithyError } from "@pithy-sh/core/src/error/pithyError";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { PaymentsConfig } from "../config/config";
import { paymentsDatabase } from "../data/tables";
import { PaymentsEntitlementNotInCatalogError } from "../error/errors";
import { payments_0001_purchases } from "../migrations/0001_purchases";
import type { ProviderEventInput } from "../projection/event";
import { resolveEntitlements } from "../projection/resolve";
import { projectPurchase } from "../projection/writer";
import { grantEntitlement, revokeEntitlement } from "./manual";

/**
 * The manual entitlement writes behind the control-plane routes, against real D1.
 *
 * These are the only writes to the read model that no purchase produced, which is why the interaction with
 * the projection is pinned here rather than left to be discovered: a manual write is a repair of the read
 * model, and the purchase record stays authoritative for any key the catalog grants.
 *
 * The catalog check is exercised here, at the write, because that is where it now lives (#305). Every grant
 * in this file passes a config for the same reason a grant in production does: the key has to mean something
 * before a row claims it does.
 */

const SECOND = 1000;
const DAY = 86_400 * SECOND;
const T0 = 1_700_000_000_000;
const NOW = new Date(T0 + SECOND);

const CONFIG = PaymentsConfig.parse({
  rails: { apple: true },
  products: {
    pro_monthly: {
      type: "subscription",
      name: "Pro",
      entitlements: ["pro"],
      apple: { productId: "com.acme.pro.monthly" },
    },
  },
});

/**
 * The same catalog, with a key the adopter comps but does not sell. `beta_access` is granted nowhere in
 * `products`, so it exists only because `manualEntitlements` declares it — which is the escape hatch, and the
 * thing that has to keep working now that the check sits at the write.
 */
const COMPED = PaymentsConfig.parse({
  ...CONFIG,
  manualEntitlements: ["beta_access", "founder"],
});

const TABLES = [
  "pithy_payments_purchases",
  "pithy_payments_entitlements",
  "pithy_payments_provider_accounts",
  "pithy_payments_webhook_events",
  "pithy_payments_reconcile_runs",
  "pithy_payments_sync_cursors",
];

beforeEach(async () => {
  for (const table of TABLES) await env.DB.exec(`DROP TABLE IF EXISTS ${table}`);
  await payments_0001_purchases.up(createDatabase(env.DB, {}) as unknown as Kysely<unknown>);
});

const db = () => paymentsDatabase(env.DB);
const read = (userId: string, at: Date = NOW) => resolveEntitlements(db(), userId, at);

function event(overrides: Partial<ProviderEventInput> = {}): ProviderEventInput {
  return {
    rail: "apple",
    providerTransactionId: "txn-1",
    providerProductId: "com.acme.pro.monthly",
    userId: "ada",
    status: "active",
    environment: "production",
    purchasedAt: new Date(T0),
    expiresAt: new Date(T0 + 30 * DAY),
    providerEventAt: new Date(T0),
    payload: { transactionId: "txn-1" },
    ...overrides,
  };
}

const project = (input: ProviderEventInput = event()) =>
  projectPurchase(env.DB, input, { config: CONFIG, environment: "production", now: NOW });

async function rowCount(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM pithy_payments_entitlements").first<{ n: number }>();
  return row?.n ?? 0;
}

describe("grantEntitlement", () => {
  test("writes a granting row for a user who has bought nothing", async () => {
    const granted = await grantEntitlement(env.DB, CONFIG, { userId: "ada", entitlement: "pro" }, { now: NOW });

    expect(granted.entitlement).toBe("pro");
    expect(granted.active).toBe(true);
    expect(granted.expiresAt).toBeNull();
    // No purchase produced it, and the provenance says so rather than pointing at a row that does not exist.
    expect(granted.sourcePurchaseId).toBeNull();
    expect(await read("ada")).toEqual([{ key: "pro", active: true, expiresAt: null, source: null }]);
  });

  test("takes an expiry, so a comp can be for a month rather than forever", async () => {
    const until = new Date(T0 + 30 * DAY);
    const granted = await grantEntitlement(
      env.DB,
      CONFIG,
      { userId: "ada", entitlement: "pro", expiresAt: until },
      {
        now: NOW,
      },
    );
    expect(granted.expiresAt).toEqual(until);
    expect((await read("ada"))[0]?.active).toBe(true);
  });

  test("a lapsed comp stops granting on the read path, with no write", async () => {
    await grantEntitlement(
      env.DB,
      CONFIG,
      { userId: "ada", entitlement: "pro", expiresAt: new Date(T0 + DAY) },
      { now: NOW },
    );
    expect((await read("ada", new Date(T0 + 2 * DAY)))[0]?.active).toBe(false);
  });

  test("is idempotent — granting twice leaves one row", async () => {
    await grantEntitlement(env.DB, CONFIG, { userId: "ada", entitlement: "pro" }, { now: NOW });
    await grantEntitlement(env.DB, CONFIG, { userId: "ada", entitlement: "pro" }, { now: NOW });
    expect(await rowCount()).toBe(1);
  });

  test("overwrites a lapsed purchase-derived row, which is the repair case", async () => {
    await project(event({ status: "expired" }));
    expect((await read("ada"))[0]?.active).toBe(false);

    await grantEntitlement(env.DB, CONFIG, { userId: "ada", entitlement: "pro" }, { now: NOW });
    const [entitlement] = await read("ada");
    expect(entitlement?.active).toBe(true);
    expect(entitlement?.source).toBeNull();
    expect(await rowCount()).toBe(1);
  });
});

/**
 * The catalog check, exercised through the writer rather than through a route (#305).
 *
 * The route is not in this file and never enters it. That is the whole point: before #305 the rule lived in
 * the handler, so an adopter's own handler, a later route in this package, or a workflow could write a comp
 * for `pr` and nothing would say no.
 */
describe("the catalog check on a grant", () => {
  async function refusal(config: typeof CONFIG, key: string): Promise<unknown> {
    return await grantEntitlement(env.DB, config, { userId: "ada", entitlement: key }, { now: NOW }).then(
      () => undefined,
      (error: unknown) => error,
    );
  }

  test("refuses a key no product grants and nothing declared", async () => {
    const error = await refusal(CONFIG, "pr");
    expect(error).toBeInstanceOf(PaymentsEntitlementNotInCatalogError);
    expect((error as PithyError).payload.code).toBe("payments/entitlement_not_in_catalog");
  });

  test("writes no row when it refuses", async () => {
    // A refusal that still wrote would be the defect wearing an error message.
    await refusal(CONFIG, "pr");
    expect(await rowCount()).toBe(0);
  });

  test("names the key the caller sent and never the set", async () => {
    // The set is a disclosure behind `payments:catalog:read`. It goes in `detail`, which the HTTP codec strips.
    const error = (await refusal(CONFIG, "pr")) as PithyError;
    expect(error.payload.message).toContain("pr");
    expect(error.payload.message).not.toContain("pro,");
    expect(error.payload.detail).toContain("pro");
  });

  test("grants a key a product sells", async () => {
    const granted = await grantEntitlement(env.DB, CONFIG, { userId: "ada", entitlement: "pro" }, { now: NOW });
    expect(granted.active).toBe(true);
  });

  test("grants a key the adopter declared in `manualEntitlements` and no product sells", async () => {
    // The escape hatch travels with the check. If it did not, comping `founder` would have become impossible
    // at the moment the check moved — and comping a key nothing sells is the case comps exist for.
    const granted = await grantEntitlement(env.DB, COMPED, { userId: "ada", entitlement: "founder" }, { now: NOW });
    expect(granted.active).toBe(true);
    expect((await read("ada"))[0]?.key).toBe("founder");
  });

  test("refuses everything when the project defines nothing", async () => {
    // Empty is a real answer, not a bypass: a project with no products and no declarations has no vocabulary
    // to grant in, so every grant against it is refused.
    const error = await refusal(PaymentsConfig.parse({}), "pro");
    expect(error).toBeInstanceOf(PaymentsEntitlementNotInCatalogError);
  });
});

describe("revokeEntitlement", () => {
  test("takes no config, and a key the catalog has since dropped is still revocable", async () => {
    // The asymmetry #300 asserted and #305 must not undo. If a revoke were checked too, dropping a product
    // from the catalog would be irreversible for every account still holding its key.
    const revoked = await revokeEntitlement(env.DB, { userId: "ada", entitlement: "legacy_tier" }, { now: NOW });
    expect(revoked.active).toBe(false);
    expect(revoked.entitlement).toBe("legacy_tier");
  });

  test("clears a purchase-derived grant immediately", async () => {
    await project();
    expect((await read("ada"))[0]?.active).toBe(true);

    const revoked = await revokeEntitlement(env.DB, { userId: "ada", entitlement: "pro" }, { now: NOW });
    expect(revoked.active).toBe(false);
    expect(revoked.expiresAt).toBeNull();
    expect((await read("ada"))[0]?.active).toBe(false);
  });

  test("records the decision even for a user who never held the key", async () => {
    // Support tooling should not have to know whether a row exists, and an inactive row *is* the record that
    // somebody decided this account is not entitled.
    const revoked = await revokeEntitlement(env.DB, { userId: "grace", entitlement: "pro" }, { now: NOW });
    expect(revoked.active).toBe(false);
    expect(await rowCount()).toBe(1);
  });

  test("is idempotent", async () => {
    await revokeEntitlement(env.DB, { userId: "ada", entitlement: "pro" }, { now: NOW });
    await revokeEntitlement(env.DB, { userId: "ada", entitlement: "pro" }, { now: NOW });
    expect(await rowCount()).toBe(1);
  });
});

describe("a manual write against the projection", () => {
  test("survives a projection that does not touch the same key", async () => {
    await grantEntitlement(env.DB, COMPED, { userId: "ada", entitlement: "beta_access" }, { now: NOW });
    await project();
    const keys = (await read("ada")).filter((entitlement) => entitlement.active).map((e) => e.key);
    expect(keys.sort()).toEqual(["beta_access", "pro"]);
  });

  test("survives a later purchase event for the same key — a comp is not erased by the next renewal", async () => {
    // The reason `manual` exists. Without the hold, a comp of a key the catalog also sells was cleared by the
    // very next purchase event for that key: the derivation found no purchase behind the comp and did its job.
    // A support comp that silently evaporates on the user's next renewal is worse than no comp, because
    // nobody would notice.
    await grantEntitlement(env.DB, CONFIG, { userId: "ada", entitlement: "pro" }, { now: NOW });
    await project(event({ status: "refunded", providerEventAt: new Date(T0 + SECOND) }));
    const row = (await read("ada"))[0];
    expect(row?.active).toBe(true);
    expect(row?.key).toBe("pro");
  });

  test("a revoke releases the hold, so the purchases decide the key again", async () => {
    // The deliberate asymmetry: a grant takes a key into a human's hands, a revoke hands it back. It is what
    // keeps a revoke from becoming a permanent block on a user who later pays.
    await grantEntitlement(env.DB, CONFIG, { userId: "ada", entitlement: "pro" }, { now: NOW });
    await revokeEntitlement(env.DB, { userId: "ada", entitlement: "pro" }, { now: NOW });
    expect((await read("ada"))[0]?.active).toBe(false);

    // A live purchase now re-derives the key, because nothing is holding it any more.
    await project(event({ status: "active", providerEventAt: new Date(T0 + SECOND) }));
    expect((await read("ada"))[0]?.active).toBe(true);
  });

  test("the hold is recorded on the row, not inferred from the absence of a purchase", async () => {
    // `sourcePurchaseId` is null on a comp and also null on a row nothing grants, so the two are
    // indistinguishable without a column of its own — which is why `manual` is one.
    await project();
    await grantEntitlement(env.DB, COMPED, { userId: "ada", entitlement: "beta_access" }, { now: NOW });
    const rows = await env.DB.prepare(
      "SELECT entitlement, manual FROM pithy_payments_entitlements WHERE user_id = ? ORDER BY entitlement",
    )
      .bind("ada")
      .all<{ entitlement: string; manual: number }>();
    expect(rows.results).toEqual([
      { entitlement: "beta_access", manual: 1 },
      // Written by the projection, so it carries the derived shape.
      { entitlement: "pro", manual: 0 },
    ]);
  });
});
