// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Hono } from "hono";
import type { Capability } from "../../capability/capability";
import { isControlPlaneGuard } from "../http/guard";
import type { AdminRoute } from "./adminRoute";

/**
 * The gate that keeps `GET /control-plane/manifest` honest.
 *
 * A capability declares its admin routes by hand, and a hand-maintained list beside generated
 * behavior is a list that rots: someone renames a path, changes a `basePath` default, moves an
 * operation behind a different scope, and the declaration keeps confidently describing the old shape.
 *
 * **That failure is worse than having no manifest at all.** With no manifest a client knows it is
 * guessing. With a stale one it believes a route exists, calls it, and gets a 404 it has no way to
 * interpret — and the adopter sees a management client that is broken for reasons entirely inside
 * somebody else's package.
 *
 * So the declaration is checked against the router that actually mounted, the same way
 * `uncoveredParamRoutes` checks that every `:segment` carries a validator. Each capability asserts this
 * in its own `routeContract.test.ts`, so a drifting declaration fails that package's CI rather than
 * some integration run much later.
 */

/** One declared route that no composed route answers, and which capability claimed it. */
export interface AdminRouteDrift {
  /** The capability whose declaration is wrong. */
  capability: string;
  /** The route it claims to expose. */
  route: AdminRoute;
}

/** One mounted control-plane route that no capability declares. */
export interface UndeclaredAdminRoute {
  /** The method it answers on. */
  method: string;
  /** The path it is mounted at. */
  path: string;
}

/** `app.routes` entries, reduced to the pairs worth comparing. */
function mounted(app: Hono<never>): Set<string> {
  return new Set(app.routes.map((route) => `${route.method.toUpperCase()} ${route.path}`));
}

/**
 * Every admin route a capability declares that the composed app does not actually serve.
 *
 * Empty is the passing state. A non-empty result names the capability and the route, because the fix
 * is always in one of two places — the declaration or the registration — and knowing which capability
 * owns both is most of the diagnosis.
 *
 * The comparison is on method and path only. Whether the route carries the right *scope* is not
 * knowable from the router (a middleware is an opaque function to Hono), so that half stays the
 * capability's responsibility and is covered by its own route tests.
 */
export function missingAdminRoutes(app: Hono<never>, capabilities: readonly Capability[]): AdminRouteDrift[] {
  const served = mounted(app);
  const drift: AdminRouteDrift[] = [];
  for (const capability of capabilities) {
    for (const route of capability.adminRoutes ?? []) {
      if (!served.has(`${route.method} ${route.path}`)) drift.push({ capability: capability.name, route });
    }
  }
  return drift;
}

/**
 * Every control-plane route the app actually serves that no capability declares — the other direction.
 *
 * {@link missingAdminRoutes} walks declared → mounted and catches a declaration that lies. This walks
 * mounted → declared and catches the opposite: a route that is guarded, reachable, and invisible.
 *
 * **That gap stopped being cosmetic when CORS started deriving from this table** (#468). An undeclared
 * admin route was previously discoverable-by-trying — the manifest omitted it, a client that knew the
 * path could still call it. Now it also gets no `app.use`, so its preflight 404s and no browser can
 * reach it at all, while every test in the capability that owns it keeps passing. The failure is
 * invisible from the capability's own suite and shows up as a pane that will not load.
 *
 * A route is control-plane if its handler chain carries a {@link isControlPlaneGuard} gate, which is
 * the only thing that distinguishes one — a middleware is otherwise an opaque function to Hono, and
 * inferring it from the path would be guessing about the one table this is meant to check.
 */
export function undeclaredAdminRoutes(app: Hono<never>, capabilities: readonly Capability[]): UndeclaredAdminRoute[] {
  const declared = new Set<string>();
  for (const capability of capabilities) {
    for (const route of capability.adminRoutes ?? []) declared.add(`${route.method} ${route.path}`);
  }

  const guarded = new Map<string, UndeclaredAdminRoute>();
  for (const route of app.routes) {
    if (!isControlPlaneGuard(route.handler)) continue;
    const method = route.method.toUpperCase();
    guarded.set(`${method} ${route.path}`, { method, path: route.path });
  }

  return [...guarded.entries()].filter(([key]) => !declared.has(key)).map(([, route]) => route);
}
