// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import {
  isPermissionKey,
  isZoneScopedPermission,
  PERMISSION_GROUPS,
  resolvePermissionKeys,
  ZONE_SCOPED_PERMISSIONS,
} from "./permissions";

describe("resolvePermissionKeys", () => {
  test("maps short permission keys to their CF permission-group names, de-duped in order", () => {
    expect(resolvePermissionKeys(["d1:read", "d1:write"])).toEqual(["D1 Read", "D1 Write"]);
    expect(resolvePermissionKeys(["secrets:read", "secrets:write"])).toEqual([
      "Secrets Store Read",
      "Secrets Store Write",
    ]);
  });

  test("de-dupes a group name requested by two keys", () => {
    // Two keys that both grant "D1 Read" collapse to one name.
    expect(resolvePermissionKeys(["d1:read", "d1:read"])).toEqual(["D1 Read"]);
  });

  test("an unknown key fails with an actionable PithyError naming the valid keys", () => {
    const failure = (() => {
      try {
        resolvePermissionKeys(["d1:destroy"]);
      } catch (error) {
        return error;
      }
    })();
    expect(failure).toBeInstanceOf(PithyError);
    expect((failure as PithyError).payload.message).toMatch(/d1:destroy/);
    expect((failure as PithyError).payload.action).toMatch(/d1:read/);
  });
});

describe("isPermissionKey", () => {
  test("narrows a known key and rejects an unknown one", () => {
    expect(isPermissionKey("workers:write")).toBe(true);
    expect(isPermissionKey("workers:destroy")).toBe(false);
  });

  test("every catalog key maps to at least one CF group name", () => {
    for (const [key, names] of Object.entries(PERMISSION_GROUPS)) {
      expect(names.length, key).toBeGreaterThan(0);
    }
  });
});

describe("zone-scoped permission keys", () => {
  test("routes:write grants the Workers Routes group a custom domain needs", () => {
    // The group behind `POST /zones/<zone>/workers/routes`, the call `pithy deploy` makes to attach a
    // custom domain — and the one the `ci-system` token had no way to carry (#651).
    expect(resolvePermissionKeys(["routes:write"])).toEqual(["Workers Routes Write"]);
  });

  test("routes:write is the only zone-scoped key; every other key scopes to the account", () => {
    expect([...ZONE_SCOPED_PERMISSIONS]).toEqual(["routes:write"]);
    expect(isZoneScopedPermission("routes:write")).toBe(true);
    for (const key of Object.keys(PERMISSION_GROUPS)) {
      if (key === "routes:write") continue;
      expect(isZoneScopedPermission(key), key).toBe(false);
    }
  });

  test("no key in the catalog grants a group that can alter a zone", () => {
    // Routes *on* a zone, never the zone: a zone is the adopter's relationship with their registrar.
    // "Zone Read" is the one zone word the catalog is allowed to say.
    const zoneWords = Object.values(PERMISSION_GROUPS)
      .flat()
      .filter((name) => name.startsWith("Zone "));
    expect(zoneWords).toEqual(["Zone Read"]);
  });
});
