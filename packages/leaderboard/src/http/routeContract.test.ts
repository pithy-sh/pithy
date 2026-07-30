// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { pathParams, uncoveredParamRoutes } from "@pithy-sh/core/src/http/routeContract";
import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { LeaderboardConfig, type LeaderboardConfigInput } from "../config/config";
import { registerLeaderboardRoutes } from "./routes";

/**
 * The path-param half of the route request contract (issue #74). Query and body are covered by the
 * `no-raw-request-input` Biome plugin — `c.req.query()` and `c.req.json()` are banned, so a handler can
 * only read them through a validator it declared. A path param has no such chokepoint: `c.req.param()`
 * hands one over whether or not a schema exists. This gate is the positive check that replaces the ban.
 *
 * Every leaderboard route that declares a `:segment` must register a `zValidator("param", …)` for it.
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
      `These routes declare path params but register no zValidator("param", …):\n${uncovered
        .map((r) => `  ${r.method} ${r.path} — :${r.params.join(", :")}`)
        .join("\n")}\nAdd a param schema in src/http/schemas.ts and declare it on the route line.`,
    ).toEqual([]);
  });
});
