// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { controlplane } from "@pithy-sh/core/src/controlPlane/capability";
import type { AdminRoute } from "@pithy-sh/core/src/controlPlane/discovery/adminRoute";
import { SEAM_SCOPES } from "@pithy-sh/core/src/controlPlane/scope/scope";
import { describe, expect, test } from "vitest";
import { defaultGrant, grantableScopes } from "./grant";

/** A capability that declares nothing but an admin surface — enough for the derivation to read. */
function capabilityWith(name: string, adminRoutes: AdminRoute[]): Capability {
  return { name, requiredBindings: [], adminRoutes };
}

const support = capabilityWith("support", [
  { method: "GET", path: "/support/tickets", scope: "support:tickets:read", summary: "Page the queue." },
  { method: "GET", path: "/support/tickets/:id", scope: "support:tickets:read", summary: "One ticket in full." },
  { method: "POST", path: "/support/tickets/:id/close", scope: "support:tickets:close", summary: "Close a ticket." },
]);

describe("grantableScopes", () => {
  test("classifies a scope by every route that requires it, not by the first one", () => {
    // The shape `keys:rotate` has: a listing route and a mutating one, behind one scope.
    const lifecycle = capabilityWith("lifecycle", [
      { method: "GET", path: "/l/keys", scope: "l:keys:manage", summary: "List the keys." },
      { method: "POST", path: "/l/keys", scope: "l:keys:manage", summary: "Register a key." },
    ]);

    expect(grantableScopes([lifecycle])).toEqual([
      { scope: "l:keys:manage", read: false, capability: "lifecycle", summary: "List the keys.", routes: 2 },
    ]);
  });

  test("a scope named like a read is not a read when it opens a write", () => {
    const misnamed = capabilityWith("misnamed", [
      { method: "POST", path: "/m/purge", scope: "misnamed:things:read", summary: "Purge everything." },
    ]);

    expect(grantableScopes([misnamed])[0]?.read).toBe(false);
  });

  test("an unscoped route is not grantable and is never offered", () => {
    const seam = capabilityWith("seam", [
      { method: "GET", path: "/cp/ping", scope: null, summary: "Prove connectivity." },
    ]);

    expect(grantableScopes([seam])).toEqual([]);
  });

  test("reports each scope once, in composition order, with what it opens", () => {
    expect(grantableScopes([support])).toEqual([
      { scope: "support:tickets:read", read: true, capability: "support", summary: "Page the queue.", routes: 2 },
      { scope: "support:tickets:close", read: false, capability: "support", summary: "Close a ticket.", routes: 1 },
    ]);
  });

  test("a capability with no admin surface contributes nothing", () => {
    expect(grantableScopes([capabilityWith("quiet", [])])).toEqual([]);
  });
});

describe("defaultGrant", () => {
  test("adds every declared read, so a fresh connection opens to panes that read", () => {
    const audit = capabilityWith("audit", [
      { method: "GET", path: "/audit/events", scope: "audit:events:read", summary: "Page the trail." },
    ]);

    expect(defaultGrant([audit, support])).toEqual([...SEAM_SCOPES, "audit:events:read", "support:tickets:read"]);
  });

  test("never adds a write", () => {
    const added = defaultGrant([support]).filter((scope) => !SEAM_SCOPES.includes(scope));
    expect(added).toEqual(["support:tickets:read"]);
  });

  test("with nothing composed but the seam, it is the seam's own scopes and no more", () => {
    expect(defaultGrant([])).toEqual([...SEAM_SCOPES]);
  });
});

/**
 * The gate.
 *
 * **The invariant: every scope the default grant adds beyond the seam's own opens nothing but `GET`
 * routes.** Stated over whatever the project composes rather than over a list of scope names, because a
 * list is the thing this derivation exists to delete — a capability landing a route must not be able to
 * put a write into a read default by being new.
 *
 * Run against the real composed seam as well as a hostile synthetic set, because the seam is where the
 * trap actually is: `keys:rotate` gates `GET {base}/keys` *and* two `POST`s that register and expire
 * keys. Anything classifying a scope by its listing route, or by the shape of its name, admits it.
 */
describe("a read default never grants a write", () => {
  test("across the real seam and a hostile synthetic surface", () => {
    const hostile = capabilityWith("hostile", [
      { method: "GET", path: "/h/things", scope: "hostile:things:read", summary: "List things." },
      { method: "DELETE", path: "/h/things/:id", scope: "hostile:things:read", summary: "Delete a thing." },
      { method: "POST", path: "/h/wipe", scope: "hostile:wipe:read", summary: "Wipe everything." },
      { method: "PATCH", path: "/h/thing", scope: "hostile:thing:write", summary: "Amend a thing." },
    ]);
    const composed: Capability[] = [controlplane(), hostile, support];

    const added = defaultGrant(composed).filter((scope) => !SEAM_SCOPES.includes(scope));
    const routes = composed.flatMap((capability) => capability.adminRoutes ?? []);

    for (const scope of added) {
      const opened = routes.filter((route) => route.scope === scope);
      expect(opened.length, `${scope} is granted by default but no declared route requires it`).toBeGreaterThan(0);
      expect(
        opened.map((route) => route.method),
        `${scope} is in the read default but opens a route that is not a GET`,
      ).toEqual(opened.map(() => "GET"));
    }
    // Not vacuous — a genuine read is found and granted.
    expect(added).toContain("support:tickets:read");
    // And each trap is refused: a read name over a POST, and a read route sharing a scope with a DELETE.
    expect(added).not.toContain("hostile:wipe:read");
    expect(added).not.toContain("hostile:things:read");
  });
});
