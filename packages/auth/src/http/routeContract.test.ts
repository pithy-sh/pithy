// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { noopEmit } from "@pithy-sh/core/src/audit/recorder";
import type { Capability, PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { missingAdminRoutes } from "@pithy-sh/core/src/controlPlane/discovery/drift";
import { pithyErrorHandler } from "@pithy-sh/core/src/error/http";
import { pathParams, uncoveredParamRoutes } from "@pithy-sh/core/src/http/routeContract";
import { noopLogger } from "@pithy-sh/core/src/logger/logger";
import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { AuthConfig, type AuthWiring, auth } from "../capability";
import {
  AUTH_CONTROL_PLANE_SCOPES,
  AUTH_DEVICES_READ_SCOPE,
  AUTH_DEVICES_REVOKE_SCOPE,
  AUTH_SESSIONS_REVOKE_SCOPE,
  AUTH_USERS_LOGOUT_SCOPE,
  AUTH_USERS_READ_SCOPE,
  authAdminRoutes,
} from "./guards";
import { createAuthRoutes } from "./routes";

/**
 * The path-param half of the route request contract (issue #74), and the control-plane half of the
 * verification contract (issue #89).
 *
 * Query and body are covered by the `no-raw-request-input` Biome plugin — `c.req.query()` and
 * `c.req.json()` are banned, so a handler can only read them through a validator it declared. A path
 * param has no such chokepoint: `c.req.param()` hands one over whether or not a schema exists. The
 * first block is the positive check that replaces the ban.
 *
 * The rest is about the admin surface, and one of its assertions cannot be made by inspecting
 * `app.routes` at all — see "registered before the catch-all" below.
 */

/** The wiring `createAuthRoutes` needs to register: config only. The email and turnstile seams are optional. */
function buildWiring(turnstile?: { mode: "visible" }, basePath = "/auth"): AuthWiring {
  return {
    config: AuthConfig.parse({ baseURL: "http://localhost", basePath, trustedOrigins: ["http://localhost"] }),
    enqueueEmail: undefined,
    turnstile,
  };
}

/**
 * The composed route table, mounted the way `createBackend` mounts it.
 *
 * The error handler and the seeded request variables are not decoration: `createBackend` installs
 * `pithyErrorHandler` and seeds `c.var` on every real deployment, so a bare Hono app would answer 500
 * where production answers 403 and would crash where production audits a denial. Turnstile is composed
 * so the gate sees the maximal route surface — the humanity check mounts two extra middleware paths
 * that a turnstile-less project never registers.
 *
 * `controlPlaneVerifier` is null, as it is in a Worker that never composed `controlplane()` — which is
 * exactly the state the seam is meant to deny in, and therefore the one worth testing.
 */
function makeApp(basePath = "/auth") {
  const app = new Hono<PithyHonoEnv>();
  app.onError(pithyErrorHandler);
  app.use("*", async (c, next) => {
    c.set("auth", null);
    c.set("controlPlane", null);
    c.set("controlPlaneVerifier", null);
    c.set("emit", noopEmit);
    c.set("log", noopLogger);
    await next();
  });
  createAuthRoutes(buildWiring({ mode: "visible" }, basePath))(app);
  return app;
}

/** Every admin route, as `guards.ts` advertises it — the one list both the routes and the manifest read. */
const ADMIN_ROUTES = authAdminRoutes("/auth");

describe("route contract: every path param is validated", () => {
  test("the param-bearing routes are the admin ones that name a user, and nothing else", () => {
    const app = makeApp();
    expect(app.routes.length).toBeGreaterThan(0);

    // Auth was a zero-param capability until the control-plane admin surface landed; the previous
    // revision of this file pinned the empty set on purpose, so that adding a `:segment` would point
    // its author at the contract. This is that list, updated rather than worked around.
    const paramPaths = [...new Set(app.routes.filter((r) => pathParams(r.path).length > 0).map((r) => r.path))].sort();
    expect(
      paramPaths,
      `Auth grew a path-param route. Give it a zValidator("param", …) schema in src/http/schemas.ts, then add its path here.`,
    ).toEqual([
      "/auth/admin/users/:userId",
      "/auth/admin/users/:userId/devices/revoke",
      "/auth/admin/users/:userId/sessions/revoke",
    ]);
  });

  test("no auth route reads a path param it never declared a schema for", async () => {
    const uncovered = await uncoveredParamRoutes(makeApp() as unknown as Hono<never>);
    expect(
      uncovered,
      `These routes declare path params but register no zValidator("param", …):\n${uncovered
        .map((r) => `  ${r.method} ${r.path} — :${r.params.join(", :")}`)
        .join("\n")}\nAdd a param schema in src/http/schemas.ts and declare it on the route line.`,
    ).toEqual([]);
  });
});

describe("the control-plane admin surface", () => {
  test("every admin route actually runs its gate, with no credential at all", async () => {
    // The real gate, and the one a middleware count could never be. `requireControlPlane` must answer
    // 403 `controlplane/not_connected`, which only happens if the guard genuinely ran. A route that
    // lost its guard would fall through to the handler and fail differently — or worse, succeed.
    for (const route of ADMIN_ROUTES) {
      const response = await makeApp().request(route.path.replace(":userId", "u-1"), {
        method: route.method,
        ...(route.method === "POST" ? { body: "{}", headers: { "content-type": "application/json" } } : {}),
      });
      expect(response.status, `${route.method} ${route.path}`).toBe(403);
      const body = (await response.json()) as { error?: { code?: string } };
      expect(body.error?.code, `${route.method} ${route.path}`).toBe("controlplane/not_connected");
    }
  });

  test("the admin routes are registered BEFORE the Better Auth catch-all", async () => {
    // The assertion `app.routes` cannot make, and the reason this is a request test.
    //
    // `createAuthRoutes` ends with `app.all(`${base}/*`, handleBetterAuth)`, and `handleBetterAuth`
    // returns a Response, which ends the chain. An admin route registered after that line would still
    // be *mounted* — it would appear in `app.routes`, it would satisfy `missingAdminRoutes`, and it
    // would never run. Every management call would instead reach Better Auth, which knows no such
    // endpoint and, on this wiring (no email seam composed), fails building its instance: a 500 with
    // `core/internal`, not a 403 from a gate.
    //
    // So the 403 above is itself the ordering proof; this pins the discriminator explicitly, because
    // the failure it guards against is invisible to every other kind of check in this file.
    const response = await makeApp().request("/auth/admin/users");
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error?: { code?: string } };
    expect(body.error?.code).not.toBe("core/internal");

    // And the catch-all really is there, taking everything else — so the ordering above is a genuine
    // race that was won rather than an absence of a catch-all.
    const better = await makeApp().request("/auth/sign-in/anything");
    expect(better.status).toBe(500);
    expect(((await better.json()) as { error?: { code?: string } }).error?.code).toBe("core/internal");
  });

  test("the guard runs BEFORE the validator, so a malformed body still gets 403 and not 400", async () => {
    // A validator ahead of the gate turns a 403 into a 400 and tells an unverified caller which requests
    // were well-formed. On an identity surface that is a live oracle for the adopter's user model, so
    // the ordering is asserted rather than trusted to the order somebody typed the arguments in.
    for (const route of ADMIN_ROUTES.filter((entry) => entry.method === "POST")) {
      const response = await makeApp().request(route.path.replace(":userId", "u-1"), {
        method: "POST",
        body: JSON.stringify({ nonsense: true, sessionId: 42, deviceId: null }),
        headers: { "content-type": "application/json" },
      });
      expect(response.status, `${route.method} ${route.path}`).toBe(403);
    }
  });

  test("and before the query validator too", async () => {
    // Same oracle, the other input surface: an out-of-range `limit` must not be reported to a caller who
    // has not proved anything.
    const response = await makeApp().request("/auth/admin/users?limit=99999");
    expect(response.status).toBe(403);
  });

  test("each advertised route names a scope this capability defines", () => {
    for (const route of ADMIN_ROUTES) {
      expect(AUTH_CONTROL_PLANE_SCOPES, route.path).toContain(route.scope);
    }
  });

  test("read, revoke, and sign-out-everywhere are separate scopes", () => {
    // One `auth:admin` flag would mean a credential issued to look a customer up could also sign the
    // entire user base out — and, the other way round, an incident-response credential that kills a
    // stolen session would carry every customer's email address with it. `scopeCovers` matches exactly,
    // with no prefix rule, so these five confer nothing about each other.
    expect(
      new Set([
        AUTH_USERS_READ_SCOPE,
        AUTH_DEVICES_READ_SCOPE,
        AUTH_SESSIONS_REVOKE_SCOPE,
        AUTH_USERS_LOGOUT_SCOPE,
        AUTH_DEVICES_REVOKE_SCOPE,
      ]).size,
    ).toBe(5);
    expect(AUTH_CONTROL_PLANE_SCOPES).toHaveLength(5);
  });

  test("nothing on this surface is named for impersonation", () => {
    // Excluded from #89 on purpose: signing in as a user produces a credential indistinguishable from
    // their own, so every action taken with it reads in the trail as theirs. It gets its own design and
    // its own security review, not a scope quietly added to this list.
    for (const scope of AUTH_CONTROL_PLANE_SCOPES) {
      expect(scope).not.toMatch(/impersonat|sudo|assume|masquerade/);
    }
    for (const route of ADMIN_ROUTES) {
      expect(route.path).not.toMatch(/impersonat|sudo|assume|masquerade/);
    }
  });

  test("no admin route is a user-facing one and no user-facing route is an admin one", () => {
    // The two surfaces share a `basePath`, so this is the check that they do not share a route: a
    // `requireAuth()` route appearing in the manifest would tell a management client to call something
    // its credential can never open, and an admin route reachable with a user's bearer token would be
    // the escalation `controlPlaneIsolation.workers.test.ts` exists to forbid.
    const advertised = new Set(ADMIN_ROUTES.map((route) => route.path));
    for (const path of ["/auth/devices", "/auth/devices/revoke", "/auth/token/rotate"]) {
      expect(advertised.has(path), path).toBe(false);
    }
    for (const route of ADMIN_ROUTES) {
      expect(route.path.startsWith("/auth/admin/"), route.path).toBe(true);
    }
  });
});

describe("the advertised admin surface matches what is mounted", () => {
  const capability = auth({ baseURL: "http://localhost" }) as unknown as Capability;

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
    // An adopter who mounts auth at `/identity` must get a manifest naming `/identity/admin/users`, or a
    // client composing its calls from it 404s against exactly the adopters who customised anything.
    const moved = auth({ baseURL: "http://localhost", basePath: "/identity" }) as unknown as Capability;
    expect(moved.adminRoutes ?? []).not.toHaveLength(0);
    for (const route of moved.adminRoutes ?? []) {
      expect(route.path.startsWith("/identity/admin/")).toBe(true);
    }
  });

  test("and the routes move with them, so the manifest still describes the router", async () => {
    const app = makeApp("/identity");
    const response = await app.request("/identity/admin/users");
    expect(response.status).toBe(403);
    // The default mount is genuinely gone, rather than both being registered.
    expect((await makeApp("/identity").request("/auth/admin/users")).status).toBe(404);
  });
});
