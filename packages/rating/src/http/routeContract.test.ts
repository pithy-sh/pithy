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
import "../algorithm/builtins";
import { rating } from "../capability";
import { RatingConfig, type RatingConfigInput, validateRatingGames } from "../config/config";
import { registerRatingRoutes } from "./routes";
import {
  RATING_CONTROL_PLANE_SCOPES,
  RATING_PLAYERS_ADJUST_SCOPE,
  RATING_PLAYERS_READ_SCOPE,
  ratingAdminRoutes,
} from "./scopes";

/**
 * Gate 2 of the route request contract (issue #74), applied to this package. Every rating route that
 * declares a `:segment` must declare a `validate("param", …)` for it. Query and body are covered by
 * the `no-raw-request-input` Biome plugin; path params have no such chokepoint, so they need this.
 *
 * A composed app is the only place the answer lives — `registerRatingRoutes` builds the route table, so
 * nothing static can see it. No request is made and nothing is bound: the app is only inspected.
 *
 * A node test, not a workers one: neither `routes.ts` nor anything it imports pulls in
 * `cloudflare:workers`, so the module loads outside the Workers runtime.
 *
 * If this fails, the named route reads a path param it never validated. Add the missing
 * `validate("param", …)` and its schema in `src/http/schemas.ts` — do not relax the gate.
 */

const CONFIG: RatingConfigInput = {
  games: [
    {
      key: "duel",
      algorithm: "elo",
      xp: { win: 20, draw: 10, loss: 5 },
      levels: [
        { key: "rookie", from: 0 },
        { key: "pro", from: 15 },
      ],
    },
  ],
};

/** The rating routes on a bare app. No auth middleware, no `DB` — nothing is ever called. */
function composed(): Hono<PithyHonoEnv> {
  const app = new Hono<PithyHonoEnv>();
  const config = RatingConfig.parse(CONFIG);
  registerRatingRoutes({ games: validateRatingGames(config), config })(app);
  return app;
}

describe("rating route contract", () => {
  test("every param-bearing route validates its params", async () => {
    const app = composed();
    const uncovered = await uncoveredParamRoutes(app as unknown as Hono<never>);
    const named = uncovered.map((r) => `${r.method} ${r.path} (:${r.params.join(", :")})`).join(", ");
    expect(
      uncovered,
      `These rating routes read path params they never validated: ${named}. Add ` +
        `validate("param", Schema) on the route line, and declare Schema in src/http/schemas.ts.`,
    ).toEqual([]);
  });

  test("the gate is not vacuous — it sees every param route rating ships", () => {
    const app = composed();
    expect(app.routes.length).toBeGreaterThan(0);

    const paramPaths = [...new Set(app.routes.filter((r) => pathParams(r.path).length > 0).map((r) => r.path))].sort();
    expect(paramPaths).toEqual([
      "/rating/admin/pools/:pool/players",
      "/rating/admin/pools/:pool/players/:userId",
      "/rating/admin/pools/:pool/players/:userId/recalculate",
      "/rating/admin/pools/:pool/players/:userId/reset",
      "/rating/games/:game/me",
      "/rating/games/:game/outcomes",
      "/rating/games/:game/players/:userId",
    ]);
  });
});

describe("route contract: every route is described for the OpenAPI contract", () => {
  const groups = () => [{ tag: "rating", routes: composed().routes }];

  test("every route declares describeRoute", () => {
    expect(undescribedRoutes(groups())).toEqual([]);
  });

  test("every field and parameter in the contract carries a description", () => {
    const document = openApiDocument({ title: "rating", version: "0" }, groups());
    expect(Object.keys(document.paths).length).toBeGreaterThan(0);
    expect(undescribedFields(document)).toEqual([]);
  });
});

/**
 * The app composed the way `createBackend` composes it — the error handler installed and the request
 * variables seeded, with `controlPlaneVerifier` **null**: a Worker that never composed `controlplane()`,
 * which is exactly the state the management routes must deny in.
 */
function served(): Hono<PithyHonoEnv> {
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
  const config = RatingConfig.parse(CONFIG);
  registerRatingRoutes({ games: validateRatingGames(config), config })(app);
  return app;
}

/** A declared admin path with real values in its segments. */
function concrete(path: string): string {
  return path.replace(":pool", "duel").replace(":userId", "ada");
}

describe("the management surface", () => {
  const capability = rating(CONFIG) as unknown as Capability;

  test("every management route refuses a caller with no control-plane connection", async () => {
    // `requireControlPlane` answers 403 `controlplane/not_connected` only if it actually ran. A route that
    // lost its guard would reach the handler and fail some other way — or answer.
    for (const route of ratingAdminRoutes("/rating")) {
      const response = await served().request(concrete(route.path), {
        method: route.method,
        headers: { "content-type": "application/json" },
        body: route.method === "POST" ? JSON.stringify({ idempotencyKey: "k", reason: "why" }) : undefined,
      });
      expect(response.status, `${route.method} ${route.path}`).toBe(403);
      const body = (await response.json()) as { error?: { code?: string } };
      expect(body.error?.code, `${route.method} ${route.path}`).toBe("controlplane/not_connected");
    }
  });

  test("the guard runs before the validator, so a malformed request is still a 403", async () => {
    const malformed: [string, string][] = [
      ["GET", "/rating/admin/pools/NOT_A_POOL/players"],
      ["GET", "/rating/admin/pools/duel/players?limit=nonsense"],
      ["GET", `/rating/admin/pools/duel/players/${"a".repeat(300)}`],
      ["POST", "/rating/admin/pools/duel/players/ada/reset"],
    ];
    for (const [method, path] of malformed) {
      const response = await served().request(path, { method });
      expect(response.status, `${method} ${path}`).toBe(403);
    }
  });

  test("every advertised admin route is mounted, and every mounted one is advertised", () => {
    const app = new Hono<PithyHonoEnv>();
    capability.routes?.(app);
    expect(missingAdminRoutes(app as unknown as Hono<never>, [capability])).toEqual([]);
    expect(undeclaredAdminRoutes(app as unknown as Hono<never>, [capability])).toEqual([]);
  });

  test("the advertised paths follow a moved basePath", () => {
    const moved = rating({ ...CONFIG, basePath: "/skill" });
    const app = new Hono<PithyHonoEnv>();
    moved.routes?.(app);
    expect(missingAdminRoutes(app as unknown as Hono<never>, [moved as unknown as Capability])).toEqual([]);
    for (const route of moved.adminRoutes ?? []) expect(route.path.startsWith("/skill/admin/")).toBe(true);
  });

  test("reads ask for the read scope, acts for the adjust scope, and the two are different strings", () => {
    for (const route of ratingAdminRoutes("/rating")) {
      expect(RATING_CONTROL_PLANE_SCOPES).toContain(route.scope);
      expect(route.scope).toBe(route.method === "GET" ? RATING_PLAYERS_READ_SCOPE : RATING_PLAYERS_ADJUST_SCOPE);
    }
    expect(RATING_PLAYERS_READ_SCOPE).not.toBe(RATING_PLAYERS_ADJUST_SCOPE);
  });

  test("the scopes are declared on the routes the OpenAPI contract describes", () => {
    const document = openApiDocument({ title: "rating", version: "0" }, [{ tag: "rating", routes: served().routes }]);
    const reset = document.paths["/rating/admin/pools/{pool}/players/{userId}/reset"];
    expect(JSON.stringify(reset)).toContain(RATING_PLAYERS_ADJUST_SCOPE);
  });
});
