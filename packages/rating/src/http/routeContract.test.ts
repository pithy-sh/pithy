// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { pathParams, uncoveredParamRoutes } from "@pithy-sh/core/src/http/routeContract";
import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import "../algorithm/builtins";
import { RatingConfig, type RatingConfigInput, validateRatingGames } from "../config/config";
import { registerRatingRoutes } from "./routes";

/**
 * Gate 2 of the route request contract (issue #74), applied to this package. Every rating route that
 * declares a `:segment` must declare a `zValidator("param", …)` for it. Query and body are covered by
 * the `no-raw-request-input` Biome plugin; path params have no such chokepoint, so they need this.
 *
 * A composed app is the only place the answer lives — `registerRatingRoutes` builds the route table, so
 * nothing static can see it. No request is made and nothing is bound: the app is only inspected.
 *
 * A node test, not a workers one: neither `routes.ts` nor anything it imports pulls in
 * `cloudflare:workers`, so the module loads outside the Workers runtime.
 *
 * If this fails, the named route reads a path param it never validated. Add the missing
 * `zValidator("param", …, validationHook)` and its schema in `src/http/schemas.ts` — do not relax the gate.
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
        `zValidator("param", Schema, validationHook) on the route line, and declare Schema in src/http/schemas.ts.`,
    ).toEqual([]);
  });

  test("the gate is not vacuous — it sees the three param routes rating ships", () => {
    const app = composed();
    expect(app.routes.length).toBeGreaterThan(0);

    const paramPaths = [...new Set(app.routes.filter((r) => pathParams(r.path).length > 0).map((r) => r.path))].sort();
    expect(paramPaths).toEqual([
      "/rating/games/:game/me",
      "/rating/games/:game/outcomes",
      "/rating/games/:game/players/:userId",
    ]);
  });
});
