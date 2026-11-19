// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import type { Capability, PithyHonoEnv } from "../../capability/capability";
import { defineCapability } from "../../capability/capability";
import { mountRoutes, routesOf } from "../../http/lazyRoutes";
import { requireControlPlane } from "../http/guard";
import type { AdminRouteDeclaration } from "./adminRoute";
import { missingAdminRoutes, undeclaredAdminRoutes } from "./drift";

/** A capability that declares `adminRoutes` and registers whatever `mounts` says. */
function capability(name: string, declared: AdminRouteDeclaration[], mounts: AdminRouteDeclaration[]): Capability {
  return defineCapability({
    name,
    requiredBindings: [],
    adminRoutes: declared,
    routes: routesOf((app: Hono<PithyHonoEnv>) => {
      for (const route of mounts) {
        if (route.method === "GET") app.get(route.path, (c) => c.text("ok"));
        else app.post(route.path, (c) => c.text("ok"));
      }
    }),
  }) as Capability;
}

function route(method: AdminRouteDeclaration["method"], path: string): AdminRouteDeclaration {
  return { method, path, scope: "admin:do", kind: "writes", summary: "…" };
}

/** Compose the capabilities into one app, the way `createBackend` does. */
async function compose(capabilities: Capability[]): Promise<Hono<PithyHonoEnv>> {
  const app = new Hono<PithyHonoEnv>();
  for (const cap of capabilities) await mountRoutes(cap.routes, app);
  return app;
}

describe("missingAdminRoutes", () => {
  test("a declaration matching the mounted routes reports no drift", async () => {
    const routes = [route("POST", "/billing/entitlements/grant"), route("GET", "/billing/entitlements")];
    const caps = [capability("payments", routes, routes)];

    expect(missingAdminRoutes((await compose(caps)) as unknown as Hono<never>, caps)).toEqual([]);
  });

  test("catches a declared route that was never mounted — the manifest would be lying", async () => {
    // The rot this exists for: the path changed in `routes.ts` and the declaration kept describing the
    // old one. A client reads the manifest, calls the route, and gets a 404 it cannot interpret.
    const caps = [
      capability(
        "payments",
        [route("POST", "/payments/entitlements/grant")],
        [route("POST", "/billing/entitlements/grant")],
      ),
    ];

    const drift = missingAdminRoutes((await compose(caps)) as unknown as Hono<never>, caps);
    expect(drift).toHaveLength(1);
    expect(drift[0]?.capability).toBe("payments");
    expect(drift[0]?.route.path).toBe("/payments/entitlements/grant");
  });

  test("catches a method that drifted while the path stayed", async () => {
    const caps = [capability("audit", [route("POST", "/audit/events")], [route("GET", "/audit/events")])];
    expect(missingAdminRoutes((await compose(caps)) as unknown as Hono<never>, caps)).toHaveLength(1);
  });

  test("a capability declaring nothing is not drift — most capabilities have no admin surface", async () => {
    const caps = [capability("storage", [], [route("GET", "/storage/objects")])];
    expect(missingAdminRoutes((await compose(caps)) as unknown as Hono<never>, caps)).toEqual([]);
  });

  test("names every drifting capability, not just the first", async () => {
    // An author fixing one stale declaration per run is a bad afternoon, the same reasoning
    // `checkLedgerGrants` gives for reporting every mismatch at once.
    const caps = [
      capability("payments", [route("POST", "/payments/a")], []),
      capability("support", [route("GET", "/support/b")], []),
    ];
    expect(missingAdminRoutes((await compose(caps)) as unknown as Hono<never>, caps).map((d) => d.capability)).toEqual([
      "payments",
      "support",
    ]);
  });

  test("a route mounted but not declared is not drift — declaring is opt-in", async () => {
    // The check is one-directional on purpose. A capability may serve routes it does not want a
    // management client to know about; the failure being guarded is a promise that is not kept, not a
    // surface that is not advertised.
    const caps = [capability("payments", [], [route("POST", "/payments/entitlements/grant")])];
    expect(missingAdminRoutes((await compose(caps)) as unknown as Hono<never>, caps)).toEqual([]);
  });
});

describe("undeclaredAdminRoutes", () => {
  /** A capability that guards what it mounts, and declares only what `declared` says. */
  function guarded(name: string, declared: AdminRouteDeclaration[], mounts: AdminRouteDeclaration[]): Capability {
    return defineCapability({
      name,
      requiredBindings: [],
      adminRoutes: declared,
      routes: routesOf((app: Hono<PithyHonoEnv>) => {
        for (const mount of mounts) {
          const handler = (c: { text: (body: string) => Response }) => c.text("ok");
          if (mount.method === "GET") app.get(mount.path, requireControlPlane("admin:do"), handler);
          else app.post(mount.path, requireControlPlane("admin:do"), handler);
        }
      }),
    }) as Capability;
  }

  test("a capability that declares everything it guards reports nothing", async () => {
    const routes = [route("GET", "/vault/admin/secrets"), route("POST", "/vault/admin/rotate")];
    const caps = [guarded("vault", routes, routes)];
    expect(undeclaredAdminRoutes((await compose(caps)) as unknown as Hono<never>, caps)).toEqual([]);
  });

  test("it bites — a guarded route nobody declared is named", async () => {
    // The failure it exists for: an undeclared admin route also gets no CORS registration,
    // so its preflight 404s and no browser can reach it — while the capability's own suite stays green.
    const declared = [route("GET", "/vault/admin/secrets")];
    const mounted = [...declared, route("POST", "/vault/admin/rotate")];
    const caps = [guarded("vault", declared, mounted)];
    expect(undeclaredAdminRoutes((await compose(caps)) as unknown as Hono<never>, caps)).toEqual([
      { method: "POST", path: "/vault/admin/rotate" },
    ]);
  });

  test("an unguarded route is not an admin route, and is left alone", async () => {
    // The adopter's own API is mounted on the same router. Only the gate marks a route as this seam's.
    const app = await compose([capability("app", [], [route("GET", "/api/things")])]);
    expect(undeclaredAdminRoutes(app as unknown as Hono<never>, [])).toEqual([]);
  });
});
