// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { pathParams, uncoveredParamRoutes } from "@pithy-sh/core/src/http/routeContract";
import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { StorageConfig } from "../config/config";
import { registerStorageRoutes } from "./routes";

/**
 * The path-param half of the route request contract (issue #74).
 *
 * The `no-raw-request-input` Biome plugin covers query and body: with `c.req.query()` and
 * `c.req.json()` banned, a handler can only reach either through `c.req.valid()`, which exists only
 * where a validator declared it. Path params have no such chokepoint — `c.req.param()` answers
 * whether or not anyone declared a schema — so they need a positive check, and this is it.
 *
 * A composed app is the only place the answer lives, so the gate builds one from the real route
 * factory and inspects the finished route table. No request is ever made: no database, no bucket,
 * no auth middleware, no bindings.
 *
 * Node project, not Workers: `routes.ts` and everything it imports stay off `cloudflare:workers`
 * (only `workflows/worker.ts` imports it, and nothing here reaches that).
 */

/** Compose the storage routes onto a bare app. Minimal valid config; the defaults are all this needs. */
function composeApp(): Hono<PithyHonoEnv> {
  const app = new Hono<PithyHonoEnv>();
  registerStorageRoutes({ config: StorageConfig.parse({}) })(app);
  return app;
}

/**
 * Every `:segment`-bearing path the storage capability registers, at its default mount points
 * (`/storage` and `/s`). Spelled out rather than counted so a route that loses its param — or a new
 * one that arrives unnoticed — fails here rather than quietly shrinking what the gate inspects.
 */
const PARAM_PATHS = [
  "/storage/shares/:token",
  "/storage/:id/complete",
  "/storage/:id/abort",
  "/storage/:id/parts",
  "/storage/:id/copy",
  "/storage/:id/shares",
  "/storage/:id/url",
  "/storage/:id",
  "/s/:token",
];

describe("storage route contract", () => {
  test("every route that declares a path param validates it", async () => {
    const app = composeApp();
    const uncovered = await uncoveredParamRoutes(app as unknown as Hono<never>);
    const offenders = uncovered.map((route) => `${route.method} ${route.path} (:${route.params.join(", :")})`);
    const message =
      `These storage routes read a path param no validator declared: ${offenders.join("; ")}. ` +
      `Add zValidator("param", <Schema>, validationHook) to each, with the schema in src/http/schemas.ts.`;
    expect(uncovered, message).toEqual([]);
  });

  test("the app under inspection is the real route table, not an empty one", () => {
    const app = composeApp();
    // A gate over zero routes passes for the wrong reason. Both halves guard against that: the app
    // must have routes at all, and it must have exactly the param routes storage is known to ship.
    expect(app.routes.length).toBeGreaterThan(0);
    const declared = app.routes.map((route) => route.path).filter((path) => pathParams(path).length > 0);
    expect([...new Set(declared)].sort()).toEqual([...PARAM_PATHS].sort());
  });
});
