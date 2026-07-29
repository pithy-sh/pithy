import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { pathParams, uncoveredParamRoutes } from "@pithy-sh/core/src/http/routeContract";
import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { WalletConfig } from "../config/config";
import { registerWalletRoutes } from "./routes";

/**
 * The wallet's half of gate 2 of the route request contract (issue #74). Every wallet route is keyed on
 * a `:currency`, and every one of them reads it. A handler can reach a path param through a validator it
 * never declared, so the ban that covers query and body cannot cover params — this asserts the positive
 * instead: no wallet route declares a `:segment` it does not validate.
 *
 * No request is made. The app is composed and inspected, so no auth middleware, no `DB` binding, and no
 * migrations are needed. That is also why this is a node test: nothing in `routes.ts` reaches
 * `cloudflare:workers`.
 *
 * The counts below are the anti-vacuous check. A gate that silently starts inspecting an empty route
 * table passes forever; if a route is added or removed, these fail first and say so.
 */

/** The routes composed the way `routes.workers.test.ts` composes them, minus everything a request needs. */
function makeApp() {
  const app = new Hono<PithyHonoEnv>();
  registerWalletRoutes({ config: WalletConfig.parse({ currencies: [{ code: "chips", name: "Chips" }] }) })(app);
  return app;
}

/** The distinct `:segment`-bearing path patterns on an app, deduped across a route's middleware entries. */
function paramPaths(app: Hono<PithyHonoEnv>): string[] {
  return [...new Set(app.routes.filter((r) => pathParams(r.path).length > 0).map((r) => r.path))].sort();
}

describe("wallet route contract", () => {
  test("every route that declares a path param validates it", async () => {
    const uncovered = await uncoveredParamRoutes(makeApp() as unknown as Hono<never>);
    expect(
      uncovered,
      `These wallet routes read a path param they never declared a schema for. Add \`zValidator("param", <Schema>, validationHook)\` to each route line, with the schema in src/http/schemas.ts:\n${uncovered
        .map((r) => `  ${r.method} ${r.path} (:${r.params.join(", :")})`)
        .join("\n")}`,
    ).toEqual([]);
  });

  test("the gate is inspecting the real wallet routes, not an empty app", () => {
    const app = makeApp();
    expect(app.routes.length).toBeGreaterThan(0);
    // All four wallet routes are `:currency`-keyed. Adding a fifth means adding it here too.
    expect(paramPaths(app)).toEqual([
      "/wallet/:currency",
      "/wallet/:currency/credit",
      "/wallet/:currency/debit",
      "/wallet/:currency/transactions",
    ]);
  });
});
