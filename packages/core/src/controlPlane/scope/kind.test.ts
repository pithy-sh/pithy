// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { TOOL_EFFECTS } from "../../http/routeSpec";
import { AdminRoute } from "../discovery/adminRoute";
import { MOST_RESTRICTIVE_SCOPE_KIND, SCOPE_KINDS, ScopeKind, scopeKindConflicts, scopeKindOf } from "./kind";

describe("ScopeKind", () => {
  test("is the app tools' effects, plus reads and credentials", () => {
    expect(SCOPE_KINDS).toEqual(["reads", ...TOOL_EFFECTS, "credentials"]);
    for (const kind of SCOPE_KINDS) expect(ScopeKind.parse(kind)).toBe(kind);
  });

  test("refuses a word outside the vocabulary", () => {
    for (const bad of ["read", "admin", "", "Writes"]) expect(() => ScopeKind.parse(bad), bad).toThrow();
  });

  test("the most restrictive kind is credentials", () => {
    expect(MOST_RESTRICTIVE_SCOPE_KIND).toBe("credentials");
  });
});

describe("scopeKindOf", () => {
  test("reads a route's declared kind", () => {
    expect(scopeKindOf({ scope: "payments:entitlements:grant", kind: "charges" })).toBe("charges");
  });

  test("treats a scoped route with no kind, from an older Worker, as the most restrictive", () => {
    expect(scopeKindOf({ scope: "payments:entitlements:grant" })).toBe("credentials");
  });

  test("reads a manifest route from an older Worker, which sends no kind, as the most restrictive", () => {
    const older = AdminRoute.parse({
      method: "POST",
      path: "/payments/entitlements/grant",
      scope: "payments:entitlements:grant",
      summary: "Grant an entitlement.",
    });
    expect(older.kind).toBeUndefined();
    expect(scopeKindOf(older)).toBe("credentials");
  });

  test("has no kind for a route with no scope", () => {
    expect(scopeKindOf({ scope: null })).toBeNull();
  });
});

describe("scopeKindConflicts", () => {
  test("is empty when every route sharing a scope declares one kind", () => {
    expect(
      scopeKindConflicts([
        { scope: "keys:rotate", kind: "credentials" },
        { scope: "keys:rotate", kind: "credentials" },
        { scope: "manifest:read", kind: "reads" },
        { scope: null },
      ]),
    ).toEqual([]);
  });

  test("names a scope whose routes disagree, with every kind declared for it", () => {
    expect(
      scopeKindConflicts([
        { scope: "keys:rotate", kind: "reads" },
        { scope: "keys:rotate", kind: "credentials" },
        { scope: "keys:rotate", kind: "reads" },
      ]),
    ).toEqual([{ scope: "keys:rotate", kinds: ["reads", "credentials"] }]);
  });

  test("counts a missing kind as a disagreement with a declared one", () => {
    expect(
      scopeKindConflicts([{ scope: "support:threads:reply", kind: "sends" }, { scope: "support:threads:reply" }]),
    ).toEqual([{ scope: "support:threads:reply", kinds: ["sends", "credentials"] }]);
  });
});
