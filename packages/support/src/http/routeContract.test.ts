// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { noopEmit } from "@pithy-sh/core/src/audit/recorder";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { missingAdminRoutes } from "@pithy-sh/core/src/controlPlane/discovery/drift";
import { pithyErrorHandler } from "@pithy-sh/core/src/error/http";
import { pathParams, uncoveredParamRoutes } from "@pithy-sh/core/src/http/routeContract";
import { noopLogger } from "@pithy-sh/core/src/logger/logger";
import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { support } from "../capability";
import { registerSupportRoutes } from "./routes";

/**
 * Support's half of gate 2 of the route request contract. The Biome ban covers query and body — with
 * the raw accessors gone, `c.req.valid()` is the only way to reach either — but a handler can always
 * reach a path param through a validator it never declared, so params need the positive check.
 *
 * No request is made. The app is composed and inspected, so no control-plane seam, no `DB` binding,
 * and no R2 are needed. That is also why this is a node test, and why nothing reachable from
 * `routes.ts` may import `cloudflare:workers`.
 */

/** The composed support sub-router. Deps are never resolved — no handler here is ever reached. */
function makeApp() {
  const app = new Hono<PithyHonoEnv>();
  registerSupportRoutes({ resolveDeps: async () => ({}) as never })(app);
  return app;
}

/**
 * The same router, mounted the way `createBackend` mounts it: the error handler installed and the
 * request variables seeded.
 *
 * Only the denial probe needs it, and it needs all of it. A bare Hono app answers 500 where production
 * answers 403, and `requireControlPlane` audits its denial through `c.var.emit` before throwing — so a
 * probe run against a bare app would be reading the wrong status for the wrong reason.
 * `controlPlaneVerifier` is null, as it is in a Worker that never composed `controlplane()`, which is
 * exactly the state the guard exists to deny in.
 */
function makeMountedApp() {
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
  registerSupportRoutes({ resolveDeps: async () => ({}) as never })(app);
  return app;
}

/** Every distinct `METHOD /path` support mounts. The seeded `ALL *` middleware is not a route. */
function mountedRoutes(): { method: string; path: string }[] {
  const seen = new Map<string, { method: string; path: string }>();
  for (const route of makeMountedApp().routes) {
    if (route.method === "ALL") continue;
    seen.set(`${route.method} ${route.path}`, { method: route.method, path: route.path });
  }
  return [...seen.values()];
}

/**
 * The routes that actually answer `controlplane/not_connected` to a request carrying no credential —
 * the management surface as the router behaves, not as `scopes.ts` describes it.
 *
 * Read from behavior on purpose. A set computed from `supportAdminRoutes` cannot observe a route
 * mounted with `requireControlPlane` and never declared, and that is the whole failure this exists for.
 * A path-prefix rule would be no better: `/support/threads` and `/support/feedback` are told apart by
 * their guard, not by their shape, so the guard is what gets asked.
 */
async function gatedRoutes(): Promise<string[]> {
  const found: string[] = [];
  for (const route of mountedRoutes()) {
    const response = await makeMountedApp().request(route.path.replace(":id", "t-1"), {
      method: route.method,
      ...(route.method === "POST" ? { body: "{}", headers: { "content-type": "application/json" } } : {}),
    });
    if (response.status !== 403) continue;
    const body = (await response.json()) as { error?: { code?: string } };
    if (body.error?.code === "controlplane/not_connected") found.push(`${route.method} ${route.path}`);
  }
  return found.sort();
}

describe("support route contract", () => {
  test("every route that declares a path param validates it", async () => {
    const uncovered = await uncoveredParamRoutes(makeApp() as unknown as Hono<never>);
    expect(
      uncovered,
      `These support routes read a path param they never declared a schema for. Add \`zValidator("param", <Schema>, validationHook)\` to each route line, with the schema in src/http/schemas.ts:\n${uncovered
        .map((route) => `  ${route.method} ${route.path} (:${route.params.join(", :")})`)
        .join("\n")}`,
    ).toEqual([]);
  });

  test("the gate is inspecting the real support routes, not an empty app", () => {
    // Without this the check above passes vacuously on a router that mounted nothing. Every
    // `:segment`-bearing path support serves is one of the thread family, and listing them here is
    // what makes adding another a deliberate edit rather than a surprise.
    const app = makeApp();
    expect(app.routes.length).toBeGreaterThan(0);
    const paramPaths = [...new Set(app.routes.filter((r) => pathParams(r.path).length > 0).map((r) => r.path))].sort();
    expect(paramPaths).toEqual([
      "/support/feedback/:id",
      "/support/threads/:id",
      "/support/threads/:id/archive",
      "/support/threads/:id/flags",
      "/support/threads/:id/reclassify",
      "/support/threads/:id/reply",
    ]);
  });

  test("the submission routes are mounted, and vanish when the channel is off", () => {
    // Not mounted rather than guarded inside a handler: a route that is not served answers 404, which
    // is the honest answer for a feature this deployment does not have. A 403 would say "this exists
    // and you may not use it".
    const mounted = new Hono<PithyHonoEnv>();
    registerSupportRoutes({ resolveDeps: async () => ({}) as never })(mounted);
    expect(mounted.routes.some((route) => route.path === "/support/feedback")).toBe(true);

    const off = new Hono<PithyHonoEnv>();
    registerSupportRoutes({ submission: false, resolveDeps: async () => ({}) as never })(off);
    expect(off.routes.some((route) => route.path.startsWith("/support/feedback"))).toBe(false);
    // The management surface is untouched by the switch — the two are separate surfaces, not two
    // strengths of one.
    expect(off.routes.some((route) => route.path === "/support/threads")).toBe(true);
  });

  test("the submission surface is never advertised as an admin route", () => {
    // `GET /control-plane/manifest` describes what a *management* client may call. The feedback routes
    // answer to a user's session and to no scope at all, so a manifest entry for one would offer a
    // management client a path its credential can never open.
    const capability = support({ inboundAddresses: ["support@help.example.com"] });
    expect(capability.adminRoutes?.some((route) => route.path.includes("/feedback"))).toBe(false);
  });

  test("every advertised admin route is one support actually mounts", () => {
    // `GET /control-plane/manifest` hands a management client these paths to dispatch from. A
    // declaration that drifted from `routes.ts` would have the client calling a path nothing serves,
    // and blaming the adopter's Worker for the 404.
    const capability = support({ inboundAddresses: ["support@help.example.com"] });
    const app = new Hono<PithyHonoEnv>();
    capability.routes?.(app);
    expect(capability.adminRoutes?.length).toBeGreaterThan(0);
    expect(missingAdminRoutes(app as unknown as Hono<never>, [capability])).toEqual([]);
  });

  test("and nothing support mounts behind the control-plane gate is left undeclared", () => {
    // The other direction, which audit, email, ledger, secrets and testers all assert and support did
    // not. `missingAdminRoutes` only asks whether a declaration has a route; a route added with
    // `requireControlPlane(...)` and no entry in `supportAdminRoutes` is invisible to it, so the
    // management surface can grow without ever reaching the manifest a client dispatches from.
    //
    // Method and path together. An extra method on an already-declared path is an undeclared route, and
    // on this capability the declared paths are exactly where a write would be added.
    const declared = support({ inboundAddresses: ["support@help.example.com"] }).adminRoutes ?? [];
    return expect(gatedRoutes()).resolves.toEqual(declared.map((route) => `${route.method} ${route.path}`).sort());
  });

  test("the probe reads the whole mounted surface, not a slice of it", () => {
    // Anti-vacuity for the check above, exact rather than a floor: ten routes carry a method — the seven
    // the management surface serves and the three a signed-in customer calls. An eleventh is either a
    // new management route, which the check above then demands a declaration for, or a new customer
    // route, which is a deliberate edit here.
    expect(
      mountedRoutes()
        .map((route) => `${route.method} ${route.path}`)
        .sort(),
    ).toEqual([
      "GET /support/feedback",
      "GET /support/feedback/:id",
      "GET /support/replies",
      "GET /support/threads",
      "GET /support/threads/:id",
      "POST /support/feedback",
      "POST /support/threads/:id/archive",
      "POST /support/threads/:id/flags",
      "POST /support/threads/:id/reclassify",
      "POST /support/threads/:id/reply",
    ]);
  });
});
