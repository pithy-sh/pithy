import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { pathParams, uncoveredParamRoutes } from "@pithy-sh/core/src/http/routeContract";
import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { VectorConfig } from "../config/config";
import { filterable } from "../index/filter";
import { registerVectorRoutes } from "./routes";

/**
 * The path-param half of the route request contract (issue #74). Query and body are covered by the
 * `no-raw-request-input` Biome plugin — `c.req.query()` and `c.req.json()` are banned, so a handler can
 * only read them through a validator it declared. A path param has no such chokepoint: `c.req.param()`
 * hands one over whether or not a schema exists. This gate is the positive check that replaces the ban.
 *
 * Every vector route that declares a `:segment` must register a `zValidator("param", …)` for it. That is
 * load-bearing here: `:index` reaches the dep resolver, and `:id` reaches the corpus. Add a param route
 * without a schema and this fails, naming the route.
 *
 * No request is made — the app is only inspected — so no auth middleware, D1, Vectorize, or AI binding is
 * wired, and the real dep resolver is left in place because nothing ever calls it.
 */

const metadata = z.object({
  ownerId: filterable(z.string().describe("Owner.")),
  title: z.string().describe("Title."),
});

const config = VectorConfig.parse({
  indexes: { docs: { model: "current-model", dimensions: 3, metadata } },
  defaultTopK: 5,
});

/** The composed route table. `Capability.routes` registers onto the app it is handed, so this is the only place it exists. */
function makeApp() {
  const app = new Hono<PithyHonoEnv>();
  registerVectorRoutes({ config })(app);
  return app;
}

/** The `:segment`-bearing paths the vector capability registers. Every route it has is one of them. */
const EXPECTED_PARAM_PATHS = ["/vector/:index/documents", "/vector/:index/documents/:id", "/vector/:index/query"];

describe("route contract: every path param is validated", () => {
  test("the app under test actually has param routes — a pass here is never vacuous", () => {
    const app = makeApp();
    expect(app.routes.length).toBeGreaterThan(0);

    const paramPaths = [...new Set(app.routes.filter((r) => pathParams(r.path).length > 0).map((r) => r.path))].sort();
    expect(paramPaths).toEqual(EXPECTED_PARAM_PATHS);
  });

  test("no vector route reads a path param it never declared a schema for", async () => {
    const uncovered = await uncoveredParamRoutes(makeApp() as unknown as Hono<never>);
    expect(
      uncovered,
      `These routes declare path params but register no zValidator("param", …):\n${uncovered
        .map((r) => `  ${r.method} ${r.path} — :${r.params.join(", :")}`)
        .join("\n")}\nAdd a param schema in src/http/schemas.ts and declare it on the route line.`,
    ).toEqual([]);
  });
});
