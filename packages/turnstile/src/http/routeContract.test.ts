// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { uncoveredParamRoutes } from "@pithy-sh/core/src/http/routeContract";
import { openApiDocument, undescribedFields, undescribedRoutes } from "@pithy-sh/core/src/openapi/document";
import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { TurnstileConfig } from "../config/config";
import { registerTurnstileRoutes } from "./routes";

/**
 * The route request contract, gated for this package. No request is made: the app is composed and
 * inspected, so no secrets and no Cloudflare are needed — only the real `registerTurnstileRoutes` wiring.
 */
function makeApp() {
  const app = new Hono<PithyHonoEnv>();
  registerTurnstileRoutes({ config: TurnstileConfig.parse({}) })(app);
  return app;
}

describe("turnstile route contract", () => {
  test("no route reads a path param, so none is left unvalidated", async () => {
    expect(await uncoveredParamRoutes(makeApp() as unknown as Hono<never>)).toEqual([]);
  });

  test("the gate is not vacuous — the app carries the routes it should", () => {
    const routes = makeApp().routes.map((route) => `${route.method} ${route.path}`);
    expect(routes).toContain("GET /turnstile/admin/widgets");
    expect(routes).toContain("GET /turnstile/widget");
  });

  test("every route declares describeRoute", () => {
    expect(undescribedRoutes([{ tag: "turnstile", routes: makeApp().routes }])).toEqual([]);
  });

  test("every field and parameter in the contract carries a description", () => {
    const document = openApiDocument({ title: "turnstile", version: "0" }, [
      { tag: "turnstile", routes: makeApp().routes },
    ]);
    expect(undescribedFields(document)).toEqual([]);
  });
});
