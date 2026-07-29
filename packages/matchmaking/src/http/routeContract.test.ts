import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { pathParams, uncoveredParamRoutes } from "@pithy-sh/core/src/http/routeContract";
import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { MatchmakingConfig, type MatchmakingConfigInput } from "../config/config";
import { registerMatchmakingRoutes } from "./routes";

/**
 * The path-param half of the route request contract (issue #74). Query and body are covered by the
 * `no-raw-request-input` Biome plugin — `c.req.query()` and `c.req.json()` are banned, so a handler can
 * only read them through a validator it declared. A path param has no such chokepoint: `c.req.param()`
 * hands one over whether or not a schema exists. This gate is the positive check that replaces the ban.
 *
 * Every matchmaking route that declares a `:segment` must register a `zValidator("param", …)` for it.
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
      `These routes declare path params but register no zValidator("param", …):\n${uncovered
        .map((r) => `  ${r.method} ${r.path} — :${r.params.join(", :")}`)
        .join("\n")}\nAdd a param schema in src/http/schemas.ts and declare it on the route line.`,
    ).toEqual([]);
  });
});
