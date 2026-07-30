import { describe, expect, test } from "vitest";
import {
  type Entitlement,
  EntitlementKey,
  entitlementGrantsAccess,
  grantedEntitlementKeys,
  noEntitlementProvider,
} from "./entitlement";

const at = (iso: string) => new Date(iso);

/** A held entitlement, with the fields a case is about spelled out and the rest inert. */
function held(overrides: Partial<Entitlement> = {}): Entitlement {
  return { key: "pro", active: true, expiresAt: null, source: "purchase_1", ...overrides };
}

describe("entitlement keys", () => {
  test("a key is lowercase letters, digits, and underscores", () => {
    for (const key of ["pro", "ads_removed", "tier_2"]) {
      expect(EntitlementKey.safeParse(key).success, key).toBe(true);
    }
  });

  test("a store SKU shape is rejected, because a product is not an entitlement", () => {
    // The reason the pattern exists: `com.acme.pro.monthly` is a rail's SKU, never a gate's key.
    for (const key of ["com.acme.pro.monthly", "Pro", "pro-monthly", "price_1Abc", "2pro", ""]) {
      expect(EntitlementKey.safeParse(key).success, key).toBe(false);
    }
  });
});

describe("the read-time rule", () => {
  test("an active grant with no expiry always grants", () => {
    expect(entitlementGrantsAccess(held({ expiresAt: null }), at("2026-07-29T00:00:00Z"))).toBe(true);
  });

  test("an active grant grants until its expiry", () => {
    const entitlement = held({ expiresAt: at("2026-08-01T00:00:00Z") });
    expect(entitlementGrantsAccess(entitlement, at("2026-07-31T23:59:59Z"))).toBe(true);
  });

  test("an active grant past its expiry does not grant, with no write in between", () => {
    // The point of rechecking on read: a subscription can lapse with no notification arriving, so the
    // stored flag is stale and the timestamp is the truth.
    const entitlement = held({ active: true, expiresAt: at("2026-07-01T00:00:00Z") });
    expect(entitlementGrantsAccess(entitlement, at("2026-07-29T00:00:00Z"))).toBe(false);
  });

  test("expiry is exclusive at the boundary", () => {
    const expiresAt = at("2026-08-01T00:00:00Z");
    expect(entitlementGrantsAccess(held({ expiresAt }), expiresAt)).toBe(false);
  });

  test("an inactive grant never grants, however far off its expiry is", () => {
    expect(entitlementGrantsAccess(held({ active: false, expiresAt: at("2099-01-01T00:00:00Z") }), new Date())).toBe(
      false,
    );
  });
});

describe("granted keys", () => {
  test("only the grants that pass the read-time rule are keyed", () => {
    const now = at("2026-07-29T00:00:00Z");
    const keys = grantedEntitlementKeys(
      [
        held({ key: "pro", expiresAt: at("2026-08-29T00:00:00Z") }),
        held({ key: "ads_removed", expiresAt: null }),
        held({ key: "lapsed", expiresAt: at("2026-01-01T00:00:00Z") }),
        held({ key: "revoked", active: false }),
      ],
      now,
    );
    expect([...keys].sort()).toEqual(["ads_removed", "pro"]);
  });

  test("two purchases granting one key collapse to one", () => {
    // `pro_monthly` and `pro_annual` both grant `pro`; a gate asks about the key, not the count.
    const now = at("2026-07-29T00:00:00Z");
    const keys = grantedEntitlementKeys([held({ source: "purchase_1" }), held({ source: "purchase_2" })], now);
    expect([...keys]).toEqual(["pro"]);
  });

  test("nothing held grants nothing", () => {
    expect(grantedEntitlementKeys([], new Date()).size).toBe(0);
  });
});

describe("the uncomposed default", () => {
  test("names no provider and holds nothing, so every gate denies", async () => {
    expect(noEntitlementProvider.provider).toBeNull();
    await expect(noEntitlementProvider.list()).resolves.toEqual([]);
  });
});
