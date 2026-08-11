// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { missingAdminRoutes } from "@pithy-sh/core/src/controlPlane/discovery/drift";
import { pathParams, uncoveredParamRoutes } from "@pithy-sh/core/src/http/routeContract";
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

/** The composed support sub-router. Deps are never resolved — nothing here is ever invoked. */
function makeApp() {
  const app = new Hono<PithyHonoEnv>();
  registerSupportRoutes({ resolveDeps: async () => ({}) as never })(app);
  return app;
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
});
