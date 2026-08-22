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
import { email } from "../capability";
import { CALLBACK_BASE } from "../templates/engine";
import { registerCallbacks } from "./callbacks";
import {
  EMAIL_CONTROL_PLANE_SCOPES,
  EMAIL_JOBS_READ_SCOPE,
  EMAIL_JOBS_RETRY_SCOPE,
  EMAIL_SUPPRESSIONS_DELETE_SCOPE,
  EMAIL_SUPPRESSIONS_READ_SCOPE,
  EMAIL_SUPPRESSIONS_WRITE_SCOPE,
  emailAdminRoutes,
} from "./guards";
import { EMAIL_ADMIN_ROUTES, registerEmailAdminRoutes } from "./routes";

/**
 * Gate two of the route request contract, applied to `@pithy-sh/email`.
 *
 * The Biome GritQL plugin is gate one — it bans `c.req.param(`, `c.req.query(` and `c.req.json(` under
 * `packages/*​/src/http/**`, so `c.req.valid()` is the only way to reach a query or a body. Params have
 * no accessor to ban, so they need the positive check below instead.
 *
 * Everything here is composed and inspected rather than sent a real request, except the denial checks,
 * which are the only way to prove a *middleware* ran. No database, binding, or secret is needed: both
 * registrars only write to the router.
 *
 * This is a node test: nothing reachable from `http/` imports `cloudflare:workers`.
 */

const CONFIG = { fromAddress: "noreply@pithy.sh", baseUrl: "https://api.example.test" };

/**
 * The routes, mounted the way `createBackend` mounts them.
 *
 * The error handler and the seeded request variables are not decoration: `createBackend` installs
 * `pithyErrorHandler` and seeds `c.var` on every real deployment, so a bare Hono app would answer 500
 * where production answers 403. A gate that asserts against a different app than the one that ships is
 * not a gate. `controlPlaneVerifier` is null, as it is in a Worker that never composed `controlplane()`
 * — which is exactly the state the seam is meant to deny in, and therefore the one worth testing.
 */
function makeApp(basePath = "/email"): Hono<PithyHonoEnv> {
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
  registerCallbacks(app);
  registerEmailAdminRoutes({ basePath })(app);
  return app;
}

/** Every route Hono actually mounted, method included and the harness's own `ALL` middleware excluded. */
function realRoutes(app: Hono<PithyHonoEnv>): { method: string; path: string }[] {
  return app.routes
    .filter((route) => route.method !== "ALL")
    .map((route) => ({ method: route.method, path: route.path }));
}

describe("email route param contract", () => {
  test("every :segment route declares a param validator", async () => {
    const uncovered = await uncoveredParamRoutes(makeApp() as unknown as Hono<never>);
    expect(
      uncovered,
      `These email routes read path params without a zValidator("param", …): ${uncovered
        .map((route) => `${route.method} ${route.path} (:${route.params.join(", :")})`)
        .join("; ")}. Add a schema to src/http/schemas.ts and declare it on the route line.`,
    ).toEqual([]);
  });

  test("the gate is inspecting the real route tree, not an empty one", () => {
    const app = makeApp();
    expect(app.routes.length).toBeGreaterThan(0);

    // Five param-bearing paths: the three recipient callbacks on `:token`, and the two single-job admin
    // routes on `:id`. Pinning them means a future route that loses its validator cannot pass by
    // vanishing instead.
    const paramPaths = [...new Set(app.routes.filter((r) => pathParams(r.path).length > 0).map((r) => r.path))].sort();
    expect(paramPaths).toEqual([
      `${CALLBACK_BASE}/c/:token`,
      `${CALLBACK_BASE}/o/:token`,
      `${CALLBACK_BASE}/u/:token`,
      "/email/jobs/:id",
      "/email/jobs/:id/retry",
    ]);
  });
});

describe("email admin route contract", () => {
  test("the declared route set matches what Hono actually mounted, in both directions", () => {
    // The registry is a declaration, so it can drift. This is what stops it: a route added without an
    // entry and an entry naming a route nobody mounts both fail here. Method *and* path, so an extra
    // method on an already-declared path cannot slip in undeclared.
    const mounted = new Set(realRoutes(makeApp()).map((route) => `${route.method} ${route.path}`));
    for (const declared of EMAIL_ADMIN_ROUTES) {
      expect(mounted.has(`${declared.method} /email${declared.path}`), `${declared.method} ${declared.path}`).toBe(
        true,
      );
    }

    const declared = new Set(EMAIL_ADMIN_ROUTES.map((route) => `${route.method} /email${route.path}`));
    for (const route of realRoutes(makeApp())) {
      // The public callbacks are not admin routes and are declared in `callbacks.ts`, not here.
      if (route.path.startsWith(CALLBACK_BASE)) continue;
      expect(
        declared.has(`${route.method} ${route.path}`),
        `${route.method} ${route.path} is mounted but not declared in EMAIL_ADMIN_ROUTES`,
      ).toBe(true);
    }
  });

  test("every control-plane route actually runs its declared scope guard", async () => {
    // The real gate, and the one a middleware count could never be. Each admin route is called with no
    // credential at all: `requireControlPlane` must answer 403 `controlplane/not_connected`, which only
    // happens if the guard genuinely ran. A route that lost its guard would fall through to the handler
    // and fail differently — or, with a database bound, succeed.
    for (const route of EMAIL_ADMIN_ROUTES) {
      const response = await makeApp().request(`/email${route.path.replace(":id", "job-1")}`, {
        method: route.method,
        ...(route.method === "POST" ? { body: "{}", headers: { "content-type": "application/json" } } : {}),
      });
      expect(response.status, `${route.method} ${route.path}`).toBe(403);
      const body = (await response.json()) as { error?: { code?: string } };
      expect(body.error?.code, `${route.method} ${route.path}`).toBe("controlplane/not_connected");
    }
  });

  test("the guard runs BEFORE the validator, so a malformed body still gets 403 and not 400", async () => {
    // A validator ahead of the gate turns a 403 into a 400 and tells an unverified caller which requests
    // were well-formed. On the suppression routes that is a live oracle for which addresses this
    // deployment would accept, so the ordering is asserted rather than trusted to the order somebody
    // typed the arguments in.
    for (const route of EMAIL_ADMIN_ROUTES.filter((entry) => entry.method === "POST")) {
      const response = await makeApp().request(`/email${route.path.replace(":id", "job-1")}`, {
        method: "POST",
        body: JSON.stringify({ nonsense: true, email: 17 }),
        headers: { "content-type": "application/json" },
      });
      expect(response.status, `${route.method} ${route.path}`).toBe(403);
    }
  });

  test("a malformed path param is also refused by the gate first", async () => {
    // Same rule, the other input surface: `zValidator("param", …)` sits after the guard too, so an id
    // that could never match anything still answers 403 rather than 400.
    const response = await makeApp().request("/email/jobs/not a valid id");
    expect(response.status).toBe(403);
  });

  test("every admin route declares a scope this capability defines", () => {
    for (const route of EMAIL_ADMIN_ROUTES) {
      expect(route.strategy, route.path).toBe("control-plane");
      expect(EMAIL_CONTROL_PLANE_SCOPES, route.path).toContain(route.scope);
    }
  });

  test("the advertised admin surface names the same scope the route checks", () => {
    // Drift here means a management client grays out an action it may perform, or offers one it may not.
    // Keyed on method *and* path: `/email/suppressions` is one path with two methods and two very
    // different scopes, so a path-only key would compare the write route against the read route's
    // entry and quietly pass whichever one it happened to keep.
    const declared = new Map(EMAIL_ADMIN_ROUTES.map((route) => [`${route.method} /email${route.path}`, route.scope]));
    for (const advertised of emailAdminRoutes("/email")) {
      const key = `${advertised.method} ${advertised.path}`;
      expect(declared.get(key), key).toBe(advertised.scope);
    }
    expect(emailAdminRoutes("/email")).toHaveLength(EMAIL_ADMIN_ROUTES.length);
  });

  test("five scopes, and no two operations share one", () => {
    // One `email:admin` flag would mean a credential issued to read the send log could also mail
    // somebody, and one issued to block an address could also unblock every address a bounce ever
    // added. `scopeCovers` matches exactly, so the split is real rather than cosmetic.
    expect(
      new Set([
        EMAIL_JOBS_READ_SCOPE,
        EMAIL_JOBS_RETRY_SCOPE,
        EMAIL_SUPPRESSIONS_READ_SCOPE,
        EMAIL_SUPPRESSIONS_WRITE_SCOPE,
        EMAIL_SUPPRESSIONS_DELETE_SCOPE,
      ]).size,
    ).toBe(5);
    expect(EMAIL_CONTROL_PLANE_SCOPES).toHaveLength(5);
    for (const scope of EMAIL_CONTROL_PLANE_SCOPES) expect(scope.startsWith("email:")).toBe(true);
  });
});

describe("the advertised admin surface", () => {
  const capability = email(CONFIG) as unknown as Capability;

  test("every advertised admin route is actually mounted", async () => {
    const app = new Hono<PithyHonoEnv>();
    capability.routes?.(app);
    const drift = missingAdminRoutes(app as unknown as Hono<never>, [capability]);
    expect(
      drift,
      "The control-plane manifest advertises routes that no router mounts. A management client composes its calls from that manifest, so a drifted entry is a 404 nobody can diagnose.",
    ).toEqual([]);
  });

  test("the advertised paths follow a moved basePath, and so does the router", () => {
    const moved = email({ ...CONFIG, basePath: "/mail" }) as unknown as Capability;
    expect(moved.adminRoutes ?? []).toHaveLength(EMAIL_ADMIN_ROUTES.length);
    for (const route of moved.adminRoutes ?? []) expect(route.path.startsWith("/mail/")).toBe(true);

    // And the two halves read the same value: composing the moved capability must mount exactly what it
    // advertises, which is the failure a second default would cause and nothing else would catch.
    const app = new Hono<PithyHonoEnv>();
    moved.routes?.(app);
    expect(missingAdminRoutes(app as unknown as Hono<never>, [moved])).toEqual([]);
  });

  test("the recipient callbacks are not management surface", () => {
    // They are a tracking pixel, a click redirect, and an unsubscribe link, mounted at a fixed prefix
    // and gated by a signature. A dashboard has no business calling them, and advertising them would
    // invite exactly that.
    const advertised = (capability.adminRoutes ?? []).map((route) => route.path);
    for (const path of advertised) expect(path.startsWith(CALLBACK_BASE)).toBe(false);
  });
});
