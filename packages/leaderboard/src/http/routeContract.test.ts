// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { noopEmit } from "@pithy-sh/core/src/audit/recorder";
import type { Capability, PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { missingAdminRoutes, undeclaredAdminRoutes } from "@pithy-sh/core/src/controlPlane/discovery/drift";
import { pithyErrorHandler } from "@pithy-sh/core/src/error/http";
import { pathParams, uncoveredParamRoutes } from "@pithy-sh/core/src/http/routeContract";
import { noopLogger } from "@pithy-sh/core/src/logger/logger";
import { openApiDocument, undescribedFields, undescribedRoutes } from "@pithy-sh/core/src/openapi/document";
import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { leaderboard } from "../capability";
import { LeaderboardConfig, type LeaderboardConfigInput } from "../config/config";
import { registerLeaderboardRoutes } from "./routes";
import {
  LEADERBOARD_CONTROL_PLANE_SCOPES,
  LEADERBOARD_ENTRIES_MODERATE_SCOPE,
  LEADERBOARD_ENTRIES_READ_SCOPE,
  leaderboardAdminRoutes,
} from "./scopes";

/**
 * The path-param half of the route request contract (issue #74). Query and body are covered by the
 * `no-raw-request-input` Biome plugin — `c.req.query()` and `c.req.json()` are banned, so a handler can
 * only read them through a validator it declared. A path param has no such chokepoint: `c.req.param()`
 * hands one over whether or not a schema exists. This gate is the positive check that replaces the ban.
 *
 * Every leaderboard route that declares a `:segment` must register a `validate("param", …)` for it.
 * Add a param route without one and this fails, naming the route.
 *
 * No request is made — the app is only inspected — so no auth middleware, database, or binding is wired.
 */

const CONFIG: LeaderboardConfigInput = { boards: [{ key: "b1", direction: "desc" }] };

/** The composed route table. `Capability.routes` registers onto the app it is handed, so this is the only place it exists. */
function makeApp() {
  const app = new Hono<PithyHonoEnv>();
  registerLeaderboardRoutes({ config: LeaderboardConfig.parse(CONFIG) })(app);
  return app;
}

/** The `:segment`-bearing paths the leaderboard registers. Every route below `/leaderboard/:board`. */
const EXPECTED_PARAM_PATHS = [
  "/leaderboard/:board",
  "/leaderboard/:board/around",
  "/leaderboard/:board/entries/:userId",
  "/leaderboard/:board/entries/:userId/hidden",
  "/leaderboard/:board/me",
  "/leaderboard/:board/me/visibility",
  "/leaderboard/:board/segment",
  "/leaderboard/:board/top",
  "/leaderboard/admin/boards/:board/entries",
  "/leaderboard/admin/boards/:board/entries/:userId/correct",
  "/leaderboard/admin/boards/:board/entries/:userId/hide",
  "/leaderboard/admin/boards/:board/entries/:userId/unhide",
  "/leaderboard/admin/locks/:name/clear",
];

describe("route contract: every path param is validated", () => {
  test("the app under test actually has param routes — a pass here is never vacuous", () => {
    const app = makeApp();
    expect(app.routes.length).toBeGreaterThan(0);

    const paramPaths = [...new Set(app.routes.filter((r) => pathParams(r.path).length > 0).map((r) => r.path))].sort();
    expect(paramPaths).toEqual(EXPECTED_PARAM_PATHS);
  });

  test("no leaderboard route reads a path param it never declared a schema for", async () => {
    const uncovered = await uncoveredParamRoutes(makeApp() as unknown as Hono<never>);
    expect(
      uncovered,
      `These routes declare path params but register no validate("param", …):\n${uncovered
        .map((r) => `  ${r.method} ${r.path} — :${r.params.join(", :")}`)
        .join("\n")}\nAdd a param schema in src/http/schemas.ts and declare it on the route line.`,
    ).toEqual([]);
  });
});

describe("route contract: every route is described for the OpenAPI contract", () => {
  const groups = () => [{ tag: "leaderboard", routes: makeApp().routes }];

  test("every route declares describeRoute", () => {
    expect(undescribedRoutes(groups())).toEqual([]);
  });

  test("every field and parameter in the contract carries a description", () => {
    const document = openApiDocument({ title: "leaderboard", version: "0" }, groups());
    expect(Object.keys(document.paths).length).toBeGreaterThan(0);
    expect(undescribedFields(document)).toEqual([]);
  });
});

/**
 * The management surface's own gates (#817). The app is composed the way `createBackend` composes it —
 * the error handler installed and the request variables seeded — with `controlPlaneVerifier` null, the
 * state of a Worker that never composed `controlplane()`, which is exactly the state the seam must deny in.
 */
function composedApp(basePath?: string) {
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
  registerLeaderboardRoutes({ config: LeaderboardConfig.parse(CONFIG), basePath })(app);
  return app;
}

/** An advertised path with real values in its segments, so it can actually be requested. */
function concrete(path: string): string {
  return path.replace(":board", "b1").replace(":userId", "u1").replace(":name", "rank-refresh");
}

describe("the management surface", () => {
  const advertised = leaderboardAdminRoutes("/leaderboard");

  test("every management route runs its scope guard, and answers an uncredentialled call 403", async () => {
    // A route that lost its guard would fall through to the handler and fail differently, or succeed.
    for (const route of advertised) {
      const path = concrete(route.path);
      const response = await composedApp().request(path, { method: route.method });
      expect(response.status, `${route.method} ${path}`).toBe(403);
      const body = (await response.json()) as { error?: { code?: string } };
      expect(body.error?.code, `${route.method} ${path}`).toBe("controlplane/not_connected");
    }
  });

  test("the guard runs before the validators, so a malformed request is still a 403 and not a 400", async () => {
    const malformed: [string, string][] = [
      ["GET", "/leaderboard/admin/boards/NOT_A_KEY/entries"],
      ["GET", "/leaderboard/admin/boards/b1/entries?limit=nonsense"],
      ["POST", "/leaderboard/admin/boards/b1/entries/u1/hide"],
      ["POST", "/leaderboard/admin/boards/b1/entries/u1/correct"],
      ["POST", "/leaderboard/admin/locks/NOT A NAME/clear"],
    ];
    for (const [method, path] of malformed) {
      const response = await composedApp().request(path, method === "GET" ? { method } : { method, body: "{not json" });
      expect(response.status, `${method} ${path}`).toBe(403);
    }
  });

  test("the reads ask for the read scope and the acts for the moderate scope, and nothing else", () => {
    for (const route of advertised) {
      expect(route.scope, route.path).toBe(
        route.method === "GET" ? LEADERBOARD_ENTRIES_READ_SCOPE : LEADERBOARD_ENTRIES_MODERATE_SCOPE,
      );
    }
    expect([...LEADERBOARD_CONTROL_PLANE_SCOPES]).toEqual([
      LEADERBOARD_ENTRIES_READ_SCOPE,
      LEADERBOARD_ENTRIES_MODERATE_SCOPE,
    ]);
  });

  test("a board keyed `admin` keeps its player routes", async () => {
    // The player surface owns `${base}/:board/<verb>`. Every management path's second segment is static
    // and is none of those verbs, so neither surface can shadow the other.
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
    registerLeaderboardRoutes({ config: LeaderboardConfig.parse({ boards: [{ key: "admin", direction: "desc" }] }) })(
      app,
    );
    // 401 is the player gate answering: the request reached the player route, not a management one.
    expect((await app.request("/leaderboard/admin/top")).status).toBe(401);
    expect((await app.request("/leaderboard/admin", { method: "POST" })).status).toBe(401);
    for (const route of advertised) expect(route.path.startsWith("/leaderboard/admin/"), route.path).toBe(true);
  });
});

describe("the advertised admin surface", () => {
  const capability = leaderboard(CONFIG) as unknown as Capability;

  test("every advertised admin route is actually mounted", () => {
    const app = new Hono<PithyHonoEnv>();
    capability.routes?.(app);
    expect(missingAdminRoutes(app as unknown as Hono<never>, [capability])).toEqual([]);
  });

  test("every mounted management route is actually advertised", () => {
    // Not cosmetic: the CORS surface is derived from `adminRoutes`, so a guarded route nobody declared
    // gets no preflight and no browser reaches it.
    const app = new Hono<PithyHonoEnv>();
    capability.routes?.(app);
    expect(undeclaredAdminRoutes(app as unknown as Hono<never>, [capability])).toEqual([]);
  });

  test("the advertised paths follow a moved basePath", () => {
    const moved = leaderboard({ ...CONFIG, basePath: "/ranks" });
    const app = new Hono<PithyHonoEnv>();
    moved.routes?.(app);
    expect(missingAdminRoutes(app as unknown as Hono<never>, [moved as unknown as Capability])).toEqual([]);
    expect(moved.adminRoutes?.length).toBe(7);
    for (const route of moved.adminRoutes ?? []) expect(route.path.startsWith("/ranks/admin/")).toBe(true);
  });
});
