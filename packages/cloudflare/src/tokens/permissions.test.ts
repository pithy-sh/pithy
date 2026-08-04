// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import { isPermissionKey, PERMISSION_GROUPS, resolvePermissionKeys } from "./permissions";

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
