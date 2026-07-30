// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { pathParams, uncoveredParamRoutes } from "@pithy-sh/core/src/http/routeContract";
import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { MultiplayerConfig, type MultiplayerConfigInput, validateGames } from "../config/config";
import "../game/builtins";
import { registerMultiplayerRoutes } from "./routes";

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

/** The eight `:segment`-bearing paths multiplayer registers, deduplicated across methods. */
const PARAM_PATHS = [
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
        `Give each a zValidator("param", <Schema>, validationHook), with the schema in src/http/schemas.ts.`,
    ).toEqual([]);
  });
});
