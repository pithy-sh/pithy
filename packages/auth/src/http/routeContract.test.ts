// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { pathParams, uncoveredParamRoutes } from "@pithy-sh/core/src/http/routeContract";
import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { AuthConfig, type AuthWiring } from "../capability";
import { createAuthRoutes } from "./routes";

/**
 * The path-param half of the route request contract (issue #74). Query and body are covered by the
 * `no-raw-request-input` Biome plugin — `c.req.query()` and `c.req.json()` are banned, so a handler can
 * only read them through a validator it declared. A path param has no such chokepoint: `c.req.param()`
 * hands one over whether or not a schema exists. This gate is the positive check that replaces the ban.
 *
 * Auth registers NO `:segment` route today — every path is fixed (`/auth/token/rotate`,
 * `/auth/devices`, `/auth/devices/revoke`) and Better Auth's own endpoints arrive under one wildcard
 * catch-all, which carries no params. So the assertion below is that the param set is empty, and the
 * gate's job is to catch the day that changes: add `/auth/devices/:deviceId` without a
 * `zValidator("param", …)` and this file fails, naming the route.
 *
 * No request is made — the app is only inspected — so no auth middleware, database, or binding is wired.
 */

/** The wiring `createAuthRoutes` needs to register: config only. The email and turnstile seams are optional. */
function buildWiring(turnstile?: { mode: "visible" }): AuthWiring {
  return {
    config: AuthConfig.parse({ baseURL: "http://localhost", basePath: "/auth", trustedOrigins: ["http://localhost"] }),
    enqueueEmail: undefined,
    turnstile,
  };
}

/**
 * The composed route table. `Capability.routes` registers onto the app it is handed, so this is the only
 * place it exists. Turnstile is composed so the gate sees the maximal route surface — the humanity check
 * mounts two extra middleware paths that a turnstile-less project never registers.
 */
function makeApp() {
  const app = new Hono<PithyHonoEnv>();
  createAuthRoutes(buildWiring({ mode: "visible" }))(app);
  return app;
}

describe("route contract: every path param is validated", () => {
  test("the app under test has routes, and none of them declare a path param", () => {
    const app = makeApp();
    expect(app.routes.length).toBeGreaterThan(0);

    // Auth is a genuine zero-param capability. This asserts that on purpose so the gate below is not
    // silently checking nothing: the day a `:segment` route lands, this list stops being empty and the
    // author is pointed at the contract.
    const paramPaths = [...new Set(app.routes.filter((r) => pathParams(r.path).length > 0).map((r) => r.path))].sort();
    expect(
      paramPaths,
      `Auth grew a path-param route. Give it a zValidator("param", …) schema in src/http/schemas.ts, then add its path here.`,
    ).toEqual([]);
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
