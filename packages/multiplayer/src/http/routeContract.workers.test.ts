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
import { MultiplayerConfig, type MultiplayerConfigInput, validateGames } from "../config/config";
import "../game/builtins";
import { multiplayer } from "../capability";
import { registerMultiplayerRoutes } from "./routes";
import {
  MULTIPLAYER_CONTROL_PLANE_SCOPES,
  MULTIPLAYER_SESSIONS_MODERATE_SCOPE,
  MULTIPLAYER_SESSIONS_READ_SCOPE,
  multiplayerAdminRoutes,
} from "./scopes";

/**
 * The route request contract, gated for this package (issue #74). Every multiplayer path carries a
 * `:segment` — a game key or a session id — and a handler can reach one through `c.req.param()`
 * whether or not a schema was ever declared for it. So the check has to be positive: compose the
 * real routes and assert none of them read a param they never validated.
 *
 * A gate that inspects an empty app passes for free, which is the failure this file guards hardest
 * against. Both counts below are asserted, so deleting a route or a whole registration is a failure
 * here, not a silent pass.
 *
 * Workers-project test: `routes.ts` imports the session Durable Object, which imports
 * `cloudflare:workers`. A node-project test cannot load it. No request is made — the app is only
 * inspected, so no binding, database, or auth middleware is needed.
 */

/** One configured game is enough: the route table is identical whatever `games` holds. */
const CONFIG: MultiplayerConfigInput = {
  games: [
    {
      key: "battle",
      kind: "battle",
      rules: {
        offense: {
          pick: 1,
          moves: [
            { name: "fire", power: 10 },
            { name: "ice", power: 8 },
          ],
        },
        defense: {
          pick: 1,
          moves: [
            { name: "guard-fire", blocks: "fire" },
            { name: "guard-ice", blocks: "ice" },
          ],
        },
      },
    },
  ],
};

/** The composed app: the real routes on a bare Hono, exactly as `Capability.routes` applies them. */
function composed() {
  const app = new Hono<PithyHonoEnv>();
  registerMultiplayerRoutes({ games: validateGames(MultiplayerConfig.parse(CONFIG)) })(app);
  return app as unknown as Hono<never>;
}

/** The eleven `:segment`-bearing paths multiplayer registers, deduplicated across methods. */
const PARAM_PATHS = [
  "/multiplayer/admin/results/:id/void",
  "/multiplayer/admin/sessions/:id",
  "/multiplayer/admin/sessions/:id/close",
  "/multiplayer/games/:game",
  "/multiplayer/sessions/:id",
  "/multiplayer/sessions/:id/action",
  "/multiplayer/sessions/:id/close",
  "/multiplayer/sessions/:id/join",
  "/multiplayer/sessions/:id/leave",
  "/multiplayer/sessions/:id/result",
  "/multiplayer/sessions/:id/socket",
];

describe("multiplayer route contract", () => {
  test("the app under test is the real, non-empty route table", () => {
    const app = composed();
    expect(app.routes.length).toBeGreaterThan(0);

    const found = [...new Set(app.routes.filter((r) => pathParams(r.path).length > 0).map((r) => r.path))].sort();
    expect(found).toEqual(PARAM_PATHS);
  });

  test("every param route declares a param validator", async () => {
    const uncovered = await uncoveredParamRoutes(composed());
    const offenders = uncovered.map((r) => `${r.method} ${r.path} (:${r.params.join(", :")})`).join("; ");
    expect(
      uncovered,
      `These multiplayer routes declare a :segment but validate none of it: ${offenders}. ` +
        `Give each a validate("param", <Schema>), with the schema in src/http/schemas.ts.`,
    ).toEqual([]);
  });
});

describe("route contract: every route is described for the OpenAPI contract", () => {
  const groups = () => [{ tag: "multiplayer", routes: composed().routes }];

  test("every route declares describeRoute", () => {
    expect(undescribedRoutes(groups())).toEqual([]);
  });

  test("every field and parameter in the contract carries a description", () => {
    const document = openApiDocument({ title: "multiplayer", version: "0" }, groups());
    expect(Object.keys(document.paths).length).toBeGreaterThan(0);
    expect(undescribedFields(document)).toEqual([]);
  });
});

/**
 * The app as `createBackend` composes it: the error handler installed and the request variables seeded, with
 * `controlPlaneVerifier` null — a Worker that never composed `controlplane()`, which is exactly the state the
 * management surface must deny in.
 */
function bareApp() {
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
  registerMultiplayerRoutes({ games: validateGames(MultiplayerConfig.parse(CONFIG)) })(app);
  return app;
}

/** A declared admin path with a real value in its segment, so it can be requested. */
const concrete = (path: string) => path.replace(":id", "a".repeat(64));

describe("the management surface (#820)", () => {
  const capability = multiplayer(CONFIG) as unknown as Capability;

  test("every advertised admin route is mounted, and every mounted one is advertised", () => {
    const app = new Hono<PithyHonoEnv>();
    capability.routes?.(app);
    expect(missingAdminRoutes(app as unknown as Hono<never>, [capability])).toEqual([]);
    expect(undeclaredAdminRoutes(app as unknown as Hono<never>, [capability])).toEqual([]);
  });

  test("the advertised paths follow a moved basePath", () => {
    const moved = multiplayer({ ...CONFIG, basePath: "/play" });
    const app = new Hono<PithyHonoEnv>();
    moved.routes?.(app);
    expect(missingAdminRoutes(app as unknown as Hono<never>, [moved as unknown as Capability])).toEqual([]);
    for (const route of moved.adminRoutes ?? []) expect(route.path.startsWith("/play/admin/")).toBe(true);
  });

  test("every admin route runs its scope guard: no credential is a 403, never a 401 and never a pass", async () => {
    for (const route of multiplayerAdminRoutes("/multiplayer")) {
      const path = concrete(route.path);
      const response = await bareApp().request(path, { method: route.method });
      expect(response.status, `${route.method} ${path}`).toBe(403);
      const body = (await response.json()) as { error?: { code?: string } };
      expect(body.error?.code, `${route.method} ${path}`).toBe("controlplane/not_connected");
    }
  });

  test("the guard runs before the validator, so a malformed request still gets 403 and not 400", async () => {
    const malformed: [string, string][] = [
      ["GET", "/multiplayer/admin/sessions?limit=nonsense"],
      ["GET", "/multiplayer/admin/results?voided=maybe"],
      ["GET", `/multiplayer/admin/sessions/${"a".repeat(300)}`],
      ["POST", `/multiplayer/admin/sessions/${"a".repeat(64)}/close`],
      ["POST", `/multiplayer/admin/results/${"a".repeat(300)}/void`],
    ];
    for (const [method, path] of malformed) {
      const response = await bareApp().request(path, method === "GET" ? { method } : { method, body: "{}" });
      expect(response.status, path).toBe(403);
    }
  });

  test("reads are GETs behind the read scope, and acts are POSTs behind the moderate scope", () => {
    // `defaultGrant` classifies by method: a scope is a read only when every route requiring it is a GET, so this
    // is what keeps the acts out of a default `pithy dashboard connect`.
    for (const route of multiplayerAdminRoutes("/multiplayer")) {
      expect(MULTIPLAYER_CONTROL_PLANE_SCOPES).toContain(route.scope);
      expect(route.scope).toBe(
        route.method === "GET" ? MULTIPLAYER_SESSIONS_READ_SCOPE : MULTIPLAYER_SESSIONS_MODERATE_SCOPE,
      );
    }
    expect(new Set(MULTIPLAYER_CONTROL_PLANE_SCOPES).size).toBe(2);
  });

  test("every management path sits under admin/, so none can collide with a player route", () => {
    for (const route of multiplayerAdminRoutes("/multiplayer")) {
      expect(route.path.startsWith("/multiplayer/admin/"), route.path).toBe(true);
    }
  });
});
