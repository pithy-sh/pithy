import { composeSeeds } from "@pithy-sh/core/src/seed/compose";
import { EXAMPLE_ADA, EXAMPLE_ALAN, EXAMPLE_GRACE } from "@pithy-sh/core/src/seed/exampleIdentities";
import { describe, expect, test } from "vitest";
import { payments } from "../capability";
import { PaymentsEntitlement } from "../data/entitlement";
import { PaymentsPurchase } from "../data/purchase";
import { PAYMENTS_ENTITLEMENTS_TABLE, PAYMENTS_PURCHASES_TABLE } from "../data/tables";
import { paymentsExampleSeed } from "./example";

/** The purchase rows, typed the way the fixture declares them. */
function purchases(): PaymentsPurchase[] {
  const group = paymentsExampleSeed.d1?.find((entry) => entry.table === PAYMENTS_PURCHASES_TABLE);
  return (group?.rows ?? []) as PaymentsPurchase[];
}

/** The entitlement rows. */
function entitlements(): PaymentsEntitlement[] {
  const group = paymentsExampleSeed.d1?.find((entry) => entry.table === PAYMENTS_ENTITLEMENTS_TABLE);
  return (group?.rows ?? []) as PaymentsEntitlement[];
}

describe("paymentsExampleSeed", () => {
  test("is flagged as an example, and never lists production", () => {
    expect(paymentsExampleSeed.example).toBe(true);
    expect(paymentsExampleSeed.environments).toEqual(["dev", "staging"]);
    expect(paymentsExampleSeed.environments).not.toContain("production");
  });

  test("sorts at 250 — after auth's users (100), which own these purchases", () => {
    expect(paymentsExampleSeed.order).toBe(250);
  });

  test("spreads three purchases across the taxonomy, one per rail", () => {
    // The three shapes the projection has to get right, and the three a dashboard has to render.
    expect(purchases().map((row) => [row.rail, row.type, row.status])).toEqual([
      ["apple", "subscription", "active"],
      ["stripe", "non_consumable", "active"],
      ["google", "consumable", "refunded"],
    ]);
  });

  test("hangs off the canonical cast, so the seeded backend is connected rather than scattered", () => {
    expect(purchases().map((row) => row.userId)).toEqual([EXAMPLE_ADA.id, EXAMPLE_GRACE.id, EXAMPLE_ALAN.id]);
  });

  test("the live subscription has not lapsed, and the owned-forever purchase never does", () => {
    const [subscription, forever] = purchases();
    expect(subscription?.expiresAt?.getTime() ?? 0).toBeGreaterThan(Date.now());
    expect(forever?.expiresAt).toBeNull();
  });

  test("the refunded purchase carries its revocation, so the refund branch is real data", () => {
    const refunded = purchases()[2];
    expect(refunded?.revokedAt).toBeInstanceOf(Date);
    expect(refunded?.status).toBe("refunded");
  });

  test("every row is fixed — re-seeding writes identical bytes, never a second copy", () => {
    // `pithy seed` is INSERT OR IGNORE on the primary key, so a generated id would accumulate a new
    // Ada subscription on every run. Fixed ids and a fixed clock are what make the set idempotent.
    const ids = purchases().map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const row of purchases()) {
      expect(row.createdAt.toISOString()).toBe("2026-01-01T00:00:00.000Z");
      expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  test("the entitlement rows are the derivation the projection would have written", () => {
    // Two, not three: Alan's refunded consumable granted a balance, not a key, so it leaves no row.
    // That is the derivation, and seeding a third would show a shape the writer never produces.
    expect(entitlements().map((row) => [row.userId, row.entitlement, row.active])).toEqual([
      [EXAMPLE_ADA.id, "pro", true],
      [EXAMPLE_GRACE.id, "ads_removed", true],
    ]);
  });

  test("every entitlement points back at the purchase granting it", () => {
    const ids = new Set(purchases().map((row) => row.id));
    for (const row of entitlements()) {
      expect(row.sourcePurchaseId, row.entitlement).not.toBeNull();
      expect(ids.has(row.sourcePurchaseId ?? ""), row.entitlement).toBe(true);
    }
  });

  test("every row encodes cleanly — a bad fixture fails here, not at write time", () => {
    for (const row of purchases()) expect(() => PaymentsPurchase.encode(row)).not.toThrow();
    for (const row of entitlements()) expect(() => PaymentsEntitlement.encode(row)).not.toThrow();
  });

  test("no receipt, no token, no signature — a fixture is committed and a payload is a bearer artifact", () => {
    const serialized = JSON.stringify(paymentsExampleSeed.d1);
    for (const shape of ["sk_live_", "whsec_", "BEGIN PRIVATE KEY", "receipt-data"]) {
      expect(serialized, shape).not.toContain(shape);
    }
  });
});

describe("payments() with seed.includeExamples", () => {
  const catalog = { rails: { apple: true }, products: {} };

  test("composes the example set only when includeExamples is on", () => {
    const capability = payments(catalog);
    expect(composeSeeds([capability], { env: "dev", includeExamples: false }).sets).toHaveLength(0);

    const withExamples = composeSeeds([capability], { env: "dev", includeExamples: true });
    expect(withExamples.sets).toHaveLength(1);
    expect(withExamples.sets[0]?.key).toContain("payments");
  });

  test("never composes it for production, even with includeExamples on", () => {
    const result = composeSeeds([payments(catalog)], { env: "production", includeExamples: true });
    expect(result.sets).toHaveLength(0);
    expect(result.skippedByEnv.length).toBeGreaterThan(0);
  });

  test("composes for staging, which is the other environment it lists", () => {
    const result = composeSeeds([payments(catalog)], { env: "staging", includeExamples: true });
    expect(result.sets).toHaveLength(1);
  });
});
