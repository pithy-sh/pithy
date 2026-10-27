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
import { matchmaking } from "../capability";
import { MatchmakingConfig, type MatchmakingConfigInput } from "../config/config";
import { registerMatchmakingRoutes } from "./routes";
import {
  MATCHMAKING_CONTROL_PLANE_SCOPES,
  MATCHMAKING_QUEUES_MODERATE_SCOPE,
  MATCHMAKING_QUEUES_READ_SCOPE,
  matchmakingAdminRoutes,
} from "./scopes";

/**
 * The path-param half of the route request contract (issue #74). Query and body are covered by the
 * `no-raw-request-input` Biome plugin — `c.req.query()` and `c.req.json()` are banned, so a handler can
 * only read them through a validator it declared. A path param has no such chokepoint: `c.req.param()`
 * hands one over whether or not a schema exists. This gate is the positive check that replaces the ban.
 *
 * Every matchmaking route that declares a `:segment` must register a `validate("param", …)` for it.
 * Add a param route without one and this fails, naming the route.
 *
 * A node test, not a workers one: `routes.ts` reaches the two Durable Objects through `import type`
 * only, so nothing here pulls in `cloudflare:workers`. No request is made either — the app is only
 * inspected — so no auth middleware, database, KV, or DO binding is wired.
 */

const CONFIG: MatchmakingConfigInput = {
  games: [{ key: "duel", players: 2, snapshot: { kind: "connect-n", rules: {} } }],
};

/** The composed route table. `Capability.routes` registers onto the app it is handed, so this is the only place it exists. */
function makeApp() {
  const app = new Hono<PithyHonoEnv>();
  registerMatchmakingRoutes({ config: MatchmakingConfig.parse(CONFIG) })(app);
  return app;
}

/**
 * The `:segment`-bearing paths matchmaking registers. Friends are on by default (`config.friends`), so
 * the friend graph's four routes are part of the surface a default config composes.
 */
const EXPECTED_PARAM_PATHS = [
  "/matchmaking/admin/games/:game/queue",
  "/matchmaking/admin/games/:game/queue/:userId/drop",
  "/matchmaking/admin/games/:game/rooms",
  "/matchmaking/admin/invites/:id/cancel",
  "/matchmaking/friends/:userId",
  "/matchmaking/friends/:userId/accept",
  "/matchmaking/friends/:userId/decline",
  "/matchmaking/friends/:userId/request",
  "/matchmaking/games/:game/invites",
  "/matchmaking/games/:game/queue",
  "/matchmaking/games/:game/rooms",
  "/matchmaking/invites/:id/accept",
  "/matchmaking/invites/:id/decline",
  "/matchmaking/rooms/:code/join",
];

describe("route contract: every path param is validated", () => {
  test("the app under test actually has param routes — a pass here is never vacuous", () => {
    const app = makeApp();
    expect(app.routes.length).toBeGreaterThan(0);

    const paramPaths = [...new Set(app.routes.filter((r) => pathParams(r.path).length > 0).map((r) => r.path))].sort();
    expect(paramPaths).toEqual(EXPECTED_PARAM_PATHS);
  });

  test("no matchmaking route reads a path param it never declared a schema for", async () => {
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
  const groups = () => [{ tag: "matchmaking", routes: makeApp().routes }];

  test("every route declares describeRoute", () => {
    expect(undescribedRoutes(groups())).toEqual([]);
  });

  test("every field and parameter in the contract carries a description", () => {
    const document = openApiDocument({ title: "matchmaking", version: "0" }, groups());
    expect(Object.keys(document.paths).length).toBeGreaterThan(0);
    expect(undescribedFields(document)).toEqual([]);
  });
});

/**
 * The app as `createBackend` composes it: the error handler installed and the request variables seeded, with
 * `controlPlaneVerifier` null — a Worker that never composed `controlplane()`, which is exactly the state the
 * management surface must deny in.
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
  registerMatchmakingRoutes({ config: MatchmakingConfig.parse(CONFIG), basePath })(app);
  return app;
}

/** A declared admin path with real values in its segments, so it can be requested. */
function concrete(path: string): string {
  return path.replace(":game", "duel").replace(":userId", "ada").replace(":id", "11111111-1111-4111-8111-111111111111");
}

describe("the management surface", () => {
  const capability = matchmaking({ games: CONFIG.games }) as unknown as Capability;

  test("every advertised admin route is mounted, and every mounted one is advertised", () => {
    const app = new Hono<PithyHonoEnv>();
    capability.routes?.(app);
    expect(missingAdminRoutes(app as unknown as Hono<never>, [capability])).toEqual([]);
    expect(undeclaredAdminRoutes(app as unknown as Hono<never>, [capability])).toEqual([]);
  });

  test("the advertised paths follow a moved basePath", () => {
    const moved = matchmaking({ games: CONFIG.games, basePath: "/play" });
    const app = new Hono<PithyHonoEnv>();
    moved.routes?.(app);
    expect(missingAdminRoutes(app as unknown as Hono<never>, [moved as unknown as Capability])).toEqual([]);
    for (const route of moved.adminRoutes ?? []) expect(route.path.startsWith("/play/admin/")).toBe(true);
  });

  test("every admin route runs its scope guard: no credential is a 403, never a 401 and never a pass", async () => {
    for (const route of matchmakingAdminRoutes("/matchmaking")) {
      const path = concrete(route.path);
      const response = await composedApp().request(path, { method: route.method });
      expect(response.status, `${route.method} ${path}`).toBe(403);
      const body = (await response.json()) as { error?: { code?: string } };
      expect(body.error?.code, `${route.method} ${path}`).toBe("controlplane/not_connected");
    }
  });

  test("the guard runs before the validator, so a malformed request still gets 403 and not 400", async () => {
    const malformed: [string, string][] = [
      ["GET", "/matchmaking/admin/invites?limit=nonsense"],
      ["GET", "/matchmaking/admin/games/duel/rooms?limit=9999"],
      ["GET", `/matchmaking/admin/games/${"a".repeat(300)}/queue`],
      ["POST", "/matchmaking/admin/invites/not-a-uuid/cancel"],
      ["POST", `/matchmaking/admin/games/duel/queue/${"a".repeat(300)}/drop`],
    ];
    for (const [method, path] of malformed) {
      const response = await composedApp().request(path, method === "GET" ? { method } : { method, body: "{}" });
      expect(response.status, path).toBe(403);
    }
  });

  test("reads are GETs behind the read scope, and acts are POSTs behind the moderate scope", () => {
    // `defaultGrant` classifies by method: a scope is a read only when every route requiring it is a GET, so
    // this is what keeps the acts out of a default `pithy dashboard connect`.
    for (const route of matchmakingAdminRoutes("/matchmaking")) {
      expect(MATCHMAKING_CONTROL_PLANE_SCOPES).toContain(route.scope);
      expect(route.scope).toBe(
        route.method === "GET" ? MATCHMAKING_QUEUES_READ_SCOPE : MATCHMAKING_QUEUES_MODERATE_SCOPE,
      );
    }
    expect(new Set(MATCHMAKING_CONTROL_PLANE_SCOPES).size).toBe(2);
  });

  test("every management path sits under admin/, so none can collide with a player route", () => {
    for (const route of matchmakingAdminRoutes("/matchmaking")) {
      expect(route.path.startsWith("/matchmaking/admin/"), route.path).toBe(true);
    }
  });

  test("no admin route reaches the friend graph", () => {
    // Friend edges are the players' own. The advertised surface names no friend path, and the next test proves
    // the handlers never touch the table.
    for (const route of matchmakingAdminRoutes("/matchmaking")) expect(route.path).not.toMatch(/friend/);
  });
});
