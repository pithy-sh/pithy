// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { type ScopeKind, scopeKindConflicts } from "@pithy-sh/core/src/controlPlane/scope/kind";
import { describe, expect, test } from "vitest";
import { kitComposition } from "./kitDocument";

/**
 * Every kit scope that grants more than a read, by kind. Every scope absent here is `reads`.
 *
 * A management client maps its roles onto these, so changing a scope's kind changes what an agent may be granted.
 * Adding a scope that is not a read is adding a row; moving one is a reviewed edit to this table.
 */
const PUBLISHED: Readonly<Record<Exclude<ScopeKind, "reads">, readonly string[]>> = {
  writes: [
    "auth:users:suspend",
    "leaderboard:entries:moderate",
    "matchmaking:queues:moderate",
    "multiplayer:sessions:moderate",
    "organization:accounts:suspend",
    "organization:accounts:write",
    "organization:members:write",
    "organization:ownership:transfer",
    "payments:reconcile:run",
    "rating:players:adjust",
    "retention:hold",
    "support:threads:archive",
    "support:threads:assign",
    "support:threads:flag",
    "support:threads:reclassify",
    "email:suppressions:write",
    "testers:roster:write",
  ],
  sends: ["email:jobs:retry", "support:threads:reply", "testers:nudge:send"],
  charges: [
    "ledger:accounts:adjust",
    "payments:discounts:create",
    "payments:entitlements:grant",
    "payments:entitlements:revoke",
    "payments:overrides:clear",
    "payments:overrides:set",
    "payments:overrides:unrestricted",
  ],
  deletes: ["auth:users:delete", "email:suppressions:delete", "organization:accounts:delete"],
  credentials: [
    "artifacts:tokens:revoke",
    "auth:devices:revoke",
    "auth:sessions:revoke",
    "auth:users:logout",
    "connections:revoke",
    "keys:rotate",
    "secrets:rotate",
  ],
};

/** Every kit admin route, as its capability declares it. */
function declared() {
  return kitComposition().capabilities.flatMap((capability) =>
    (capability.adminRoutes ?? []).map((route) => ({
      capability: capability.name,
      method: route.method,
      path: route.path,
      scope: route.scope,
      kind: route.kind,
    })),
  );
}

describe("scope kinds", () => {
  test("every kit admin route with a scope declares a kind", () => {
    const missing = declared().filter((route) => route.scope !== null && route.kind === undefined);
    expect(missing.map((route) => `${route.capability} ${route.method} ${route.path}`)).toEqual([]);
  });

  test("every route sharing a scope declares the same kind", () => {
    expect(scopeKindConflicts(declared())).toEqual([]);
  });

  test("every scope's kind is the published one", () => {
    const actual = new Map<string, ScopeKind>();
    for (const route of declared()) if (route.scope !== null && route.kind) actual.set(route.scope, route.kind);

    const expected = new Map<string, ScopeKind>();
    for (const scope of actual.keys()) expected.set(scope, "reads");
    for (const [kind, scopes] of Object.entries(PUBLISHED) as [ScopeKind, readonly string[]][]) {
      for (const scope of scopes) expected.set(scope, kind);
    }
    expect(Object.fromEntries([...actual].sort())).toEqual(Object.fromEntries([...expected].sort()));
  });
});
