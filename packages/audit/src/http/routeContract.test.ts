// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import { noopEmit } from "@pithy-sh/core/src/audit/recorder";
import type { Capability, PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { missingAdminRoutes } from "@pithy-sh/core/src/controlPlane/discovery/drift";
import { ControlPlaneScope } from "@pithy-sh/core/src/controlPlane/scope/scope";
import { pithyErrorHandler } from "@pithy-sh/core/src/error/http";
import { pathParams, uncoveredParamRoutes } from "@pithy-sh/core/src/http/routeContract";
import { noopLogger } from "@pithy-sh/core/src/logger/logger";
import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { AuditConfig, audit } from "../capability";
import type { AuditDatabase } from "../data/tables";
import {
  AUDIT_CONTROL_PLANE_SCOPES,
  AUDIT_EVENT_DETAIL_READ_SCOPE,
  AUDIT_TRAIL_READ_SCOPE,
  auditAdminRoutes,
} from "./guards";
import { AUDIT_ROUTES, registerAuditRoutes } from "./routes";

/**
 * Gate two of the request contract. The Biome GritQL plugin is gate one — it bans the raw accessors,
 * so `c.req.valid()` is the only way to reach a query or a body. Params have no accessor to ban, so
 * they need this positive check instead.
 *
 * No database is ever touched: every request here is refused by the gate before a handler runs, which
 * is the property being asserted. The handler bodies are exercised in `controlPlane.workers.test.ts`,
 * against real D1.
 */

const BASE = AuditConfig.parse({}).basePath;

/**
 * The routes, mounted the way `createBackend` mounts them.
 *
 * The error handler and the seeded request variables are not decoration: `createBackend` installs
 * `pithyErrorHandler` and seeds `c.var` on every real deployment, so a bare Hono app would answer 500
 * where production answers 403 and would crash where production audits a denial. A gate that asserts
 * against a different app than the one that ships is not a gate.
 */
function makeApp(basePath = BASE) {
  const app = new Hono<PithyHonoEnv>();
  app.onError(pithyErrorHandler);
  app.use("*", async (c, next) => {
    c.set("auth", null);
    c.set("controlPlane", null);
    // Null, as it is in a Worker that never composed `controlplane()` — which is exactly the state the
    // seam is meant to deny in, and therefore the one worth testing.
    c.set("controlPlaneVerifier", null);
    c.set("emit", noopEmit);
    c.set("log", noopLogger);
    await next();
  });
  registerAuditRoutes({
    basePath,
    // Never called: every request in this file is refused before a handler runs.
    database: () => ({}) as unknown as AuditDatabase,
  })(app);
  return app;
}

/** The paths this capability mounted, excluding the `*` entry the harness's own middleware registers. */
function mountedPaths(app: Hono<PithyHonoEnv>, base = BASE): string[] {
  return [...new Set(app.routes.map((route) => route.path))].filter((path) => path.startsWith(`${base}/`));
}

/**
 * Every route Hono actually mounted, method included and middleware excluded. Filtered by method
 * rather than by path prefix, so a route mounted under a prefix somebody typed wrong shows up as
 * undeclared rather than being quietly skipped.
 */
function realRoutes(app: Hono<PithyHonoEnv>): { method: string; path: string }[] {
  return app.routes
    .filter((route) => route.method !== "ALL")
    .map((route) => ({ method: route.method, path: route.path }));
}

describe("audit route contract", () => {
  test("every route that declares a path param validates it", async () => {
    const uncovered = await uncoveredParamRoutes(makeApp() as unknown as Hono<never>);
    expect(
      uncovered,
      `These audit routes read a path param they never declared a schema for. Add \`zValidator("param", <Schema>, validationHook)\` to each route line, with the schema in src/http/schemas.ts:\n${uncovered
        .map((route) => `  ${route.method} ${route.path} (:${route.params.join(", :")})`)
        .join("\n")}`,
    ).toEqual([]);
  });

  test("the gate is inspecting the real audit routes, not an empty app", () => {
    expect(mountedPaths(makeApp()).sort()).toEqual(["/audit/events", "/audit/events/:eventId"]);
    const paramPaths = mountedPaths(makeApp()).filter((path) => pathParams(path).length > 0);
    expect(paramPaths).toEqual(["/audit/events/:eventId"]);
  });

  test("mounts under the configured basePath", () => {
    const moved = mountedPaths(makeApp("/trail"), "/trail");
    expect(moved).toHaveLength(AUDIT_ROUTES.length);
    for (const path of moved) expect(path.startsWith("/trail/")).toBe(true);
  });

  test("the declared route set matches what Hono actually mounted, in both directions", () => {
    // The registry is a declaration, so it can drift. A route added without an entry and an entry
    // naming a route nobody mounts both fail here. Method *and* path: comparing paths alone would let
    // an extra method on a declared path through, and the registry is the only record of a route's
    // verification strategy — invisible here means undeclared everywhere.
    const mounted = new Set(makeApp().routes.map((route) => `${route.method} ${route.path}`));
    for (const declared of AUDIT_ROUTES) {
      expect(mounted.has(`${declared.method} ${BASE}${declared.path}`), `${declared.method} ${declared.path}`).toBe(
        true,
      );
    }
    const declared = new Set(AUDIT_ROUTES.map((route) => `${route.method} ${BASE}${route.path}`));
    for (const route of realRoutes(makeApp())) {
      expect(
        declared.has(`${route.method} ${route.path}`),
        `${route.method} ${route.path} is mounted but not declared in AUDIT_ROUTES`,
      ).toBe(true);
    }
  });

  test("every route is control-plane — the trail has no public or bearer surface", () => {
    for (const route of AUDIT_ROUTES) {
      expect(route.strategy, route.path).toBe("control-plane");
      expect(AUDIT_CONTROL_PLANE_SCOPES).toContain(route.scope);
    }
  });

  test("every route is a read — nothing on this surface mutates the trail", () => {
    // A management credential that could delete an audit row could delete the evidence of its own use.
    // The append-only guarantee is only as strong as the absence of a write route, so the absence is
    // asserted rather than assumed.
    for (const route of AUDIT_ROUTES) expect(route.method, route.path).toBe("GET");
    for (const route of realRoutes(makeApp())) expect(route.method, route.path).toBe("GET");
  });

  test("every control-plane route actually runs its declared scope guard", async () => {
    // The real gate, and one a middleware count could never be. Each route is called with no
    // credential at all: `requireControlPlane` must answer 403 `controlplane/not_connected`, which
    // only happens if the guard genuinely ran. A route that lost its guard would fall through to the
    // handler and fail differently — or worse, succeed.
    for (const route of AUDIT_ROUTES) {
      const path = `${BASE}${route.path.replace(":eventId", "0f1d2e40-7b3a-4c9e-8d51-2a4b6c8e0f13")}`;
      const response = await makeApp().request(path, { method: route.method });
      expect(response.status, `${route.method} ${route.path}`).toBe(403);
      const body = (await response.json()) as { error?: { code?: string } };
      expect(body.error?.code, `${route.method} ${route.path}`).toBe("controlplane/not_connected");
    }
  });

  test("the guard runs BEFORE the validator, so a malformed request still gets 403 and not 400", async () => {
    // A validator ahead of the gate turns a 403 into a 400 and tells an unverified caller which
    // requests were well-formed — here that is a live oracle for which projects, Workers and action
    // codes this deployment records. So the ordering is asserted rather than trusted to the order
    // somebody typed the arguments in.
    const malformed = [`${BASE}/events?limit=nonsense&from=not-a-date`, `${BASE}/events/not-a-uuid`];
    for (const path of malformed) {
      const response = await makeApp().request(path);
      expect(response.status, path).toBe(403);
    }
  });

  test("the advertised admin surface names the same scope the route checks", () => {
    // Drift here means a management client greys out an action it may perform, or offers one it may not.
    const declared = new Map(AUDIT_ROUTES.map((route) => [`${BASE}${route.path}`, route.scope]));
    for (const advertised of auditAdminRoutes(BASE)) {
      expect(declared.get(advertised.path), advertised.path).toBe(advertised.scope);
    }
  });
});

describe("the advertised admin surface", () => {
  const capability = audit() as unknown as Capability;

  test("every advertised admin route is actually mounted", async () => {
    const app = new Hono<PithyHonoEnv>();
    capability.routes?.(app);
    const drift = missingAdminRoutes(app as unknown as Hono<never>, [capability]);
    expect(
      drift,
      "The control-plane manifest advertises routes that no router mounts. A management client composes its calls from that manifest, so a drifted entry is a 404 nobody can diagnose.",
    ).toEqual([]);
  });

  test("the advertised paths follow a moved basePath", () => {
    const moved = audit({ basePath: "/trail" }) as unknown as Capability;
    expect(moved.adminRoutes?.length).toBe(AUDIT_ROUTES.length);
    for (const route of moved.adminRoutes ?? []) expect(route.path.startsWith("/trail/")).toBe(true);
  });

  test("each advertised route names a scope this capability defines, and each parses", () => {
    for (const route of auditAdminRoutes(BASE)) expect(AUDIT_CONTROL_PLANE_SCOPES).toContain(route.scope);
    for (const scope of AUDIT_CONTROL_PLANE_SCOPES) expect(ControlPlaneScope.parse(scope)).toBe(scope);
  });

  test("listing the trail and reading one event in full are separate scopes", () => {
    // One `audit:read` would mean a credential issued to render a recent-activity pane could also
    // harvest every client IP, user-agent, and capability metadata bag in the project.
    expect(AUDIT_TRAIL_READ_SCOPE).not.toBe(AUDIT_EVENT_DETAIL_READ_SCOPE);
    expect(new Set(AUDIT_CONTROL_PLANE_SCOPES).size).toBe(2);
    // `scopeCovers` matches exactly, so neither is a prefix of a grant that would confer the other.
    expect(AUDIT_CONTROL_PLANE_SCOPES.every((scope) => scope.startsWith("audit:"))).toBe(true);
  });
});
