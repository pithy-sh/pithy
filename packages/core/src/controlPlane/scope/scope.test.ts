// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import {
  ANY_VERIFIED_CALLER,
  ControlPlaneScope,
  KEYS_ROTATE_SCOPE,
  MANIFEST_READ_SCOPE,
  SEAM_SCOPES,
  scopeCovers,
} from "./scope";

describe("ControlPlaneScope", () => {
  test("accepts the seam's own scopes and a capability's federated ones", () => {
    for (const scope of [...SEAM_SCOPES, "payments:entitlements:grant", "support:threads:read", "users:read"]) {
      expect(ControlPlaneScope.parse(scope)).toBe(scope);
    }
  });

  test("rejects shapes that would silently never match", () => {
    // A scope that parses but can never equal a required one is worse than a rejection: it reads as a
    // grant in the row and denies at every call, which looks like a bug in the seam rather than in the
    // grant. So the boundary refuses them.
    for (const bad of ["", "ping", "Keys:rotate", "keys rotate", "keys/rotate", "keys:", ":rotate", "keys:-rotate"]) {
      expect(() => ControlPlaneScope.parse(bad), bad).toThrow();
    }
  });
});

describe("scopeCovers", () => {
  test("allows a call whose presented scope is the required one and is granted", () => {
    expect(scopeCovers(MANIFEST_READ_SCOPE, MANIFEST_READ_SCOPE, [MANIFEST_READ_SCOPE])).toBe(true);
  });

  test("denies a scope the adopter never granted, however the token is written", () => {
    // The connection row is the authority. A management client that mints itself a token claiming
    // `keys:rotate` gets nothing if the adopter did not grant it.
    expect(scopeCovers(KEYS_ROTATE_SCOPE, KEYS_ROTATE_SCOPE, [MANIFEST_READ_SCOPE])).toBe(false);
    expect(scopeCovers(KEYS_ROTATE_SCOPE, KEYS_ROTATE_SCOPE, [])).toBe(false);
  });

  test("denies a token minted for a different operation than the route requires", () => {
    // A broad grant does not make a token broad. One token, one call, one operation.
    expect(scopeCovers(KEYS_ROTATE_SCOPE, MANIFEST_READ_SCOPE, [KEYS_ROTATE_SCOPE, MANIFEST_READ_SCOPE])).toBe(false);
  });

  test("does not treat a scope as a prefix of a narrower one", () => {
    // `payments:entitlements` must not confer `payments:entitlements:revoke`. There is no wildcard
    // matching, deliberately — prefix semantics on an authorization check is how a read grant quietly
    // becomes a write one.
    expect(scopeCovers("payments:entitlements:revoke", "payments:entitlements", ["payments:entitlements"])).toBe(false);
    expect(scopeCovers("payments:entitlements", "payments:entitlements", ["payments:entitlements:revoke"])).toBe(false);
  });

  test("ANY_VERIFIED_CALLER admits a connection granted nothing at all", () => {
    // The safety property of rotation depends on this. Ping is how a newly registered key is proven
    // before the key it replaces is expired; if it could be withheld, a connection could reach a state
    // where the replacement can never be proven.
    expect(scopeCovers(ANY_VERIFIED_CALLER, "", [])).toBe(true);
    expect(scopeCovers(ANY_VERIFIED_CALLER, "anything:else", [])).toBe(true);
  });

  test("a caller cannot present the sentinel to open a scoped route", () => {
    // The exemption is on `required`, never on `presented`. Claims arrive as JSON strings, so nothing a
    // caller sends can be equal to the symbol — this asserts the property rather than assuming it.
    expect(scopeCovers(KEYS_ROTATE_SCOPE, String(ANY_VERIFIED_CALLER), [KEYS_ROTATE_SCOPE])).toBe(false);
    expect(scopeCovers(KEYS_ROTATE_SCOPE, "pithy.controlPlane.anyVerifiedCaller", [KEYS_ROTATE_SCOPE])).toBe(false);
  });
});

describe("SEAM_SCOPES", () => {
  test("names every grantable scope the seam's own routes use, and each is well-formed", () => {
    expect([...SEAM_SCOPES].sort()).toEqual([KEYS_ROTATE_SCOPE, MANIFEST_READ_SCOPE].sort());
    for (const scope of SEAM_SCOPES) expect(() => ControlPlaneScope.parse(scope)).not.toThrow();
  });
});
