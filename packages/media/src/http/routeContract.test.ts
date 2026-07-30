// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { pathParams, uncoveredParamRoutes } from "@pithy-sh/core/src/http/routeContract";
import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { MediaConfig } from "../config/config";
import { extendMediaAsset } from "../data/extend";
import type { HandlerDeps } from "./handlers";
import { registerMediaRoutes } from "./routes";

/**
 * The route request contract, gated for this package (issue #74). Every media route that declares a
 * `:segment` must register a `zValidator("param", …)` for it — a handler can always reach a path param
 * through a validator it never declared, so the check has to be positive.
 *
 * No request is made. The app is composed and inspected, so no auth, no D1, no bindings are needed —
 * only the real `registerMediaRoutes` wiring, matching `routes.workers.test.ts`.
 */

const schema = extendMediaAsset();

/** The composed media sub-router. Deps are never resolved — nothing here is ever invoked. */
function makeApp() {
  const app = new Hono<PithyHonoEnv>();
  const config = MediaConfig.parse({});
  registerMediaRoutes({ config, schema, resolveDeps: async () => ({}) as unknown as HandlerDeps })(app);
  return app;
}

describe("media route contract", () => {
  test("every param route validates its params", async () => {
    const uncovered = await uncoveredParamRoutes(makeApp() as unknown as Hono<never>);
    expect(
      uncovered,
      `These media routes read path params with no schema. Add zValidator("param", …, validationHook) ` +
        `on the route line, with the schema in src/http/schemas.ts: ${JSON.stringify(uncovered)}`,
    ).toEqual([]);
  });

  test("the gate is not vacuous — the app carries the param routes it should", () => {
    const app = makeApp();
    expect(app.routes.length).toBeGreaterThan(0);
    const paramPaths = [...new Set(app.routes.filter((r) => pathParams(r.path).length > 0).map((r) => r.path))].sort();
    // Media has exactly two `:segment`-bearing paths: fetch/delete one record, and finalize its upload.
    expect(paramPaths).toEqual(["/media/:id", "/media/:id/finalize"]);
  });
});
