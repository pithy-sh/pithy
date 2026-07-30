// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { pathParams, uncoveredParamRoutes } from "@pithy-sh/core/src/http/routeContract";
import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { CALLBACK_BASE } from "../templates/engine";
import { registerCallbacks } from "./callbacks";

/**
 * Gate 2 of the route request contract (issue #74), applied to `@pithy-sh/email`.
 *
 * A path param is the one request input with no chokepoint: a handler can read `c.req.param()`
 * through a validator it never declared, so banning raw reads cannot cover it. This gate checks the
 * other way round — every `:segment` route on the composed app must register a
 * `zValidator("param", …)`. It stays green today; it exists so a route added tomorrow cannot drop
 * the validator quietly.
 *
 * No request is made. The app is composed and inspected, so no database, binding, or secret is
 * needed — `registerCallbacks` only writes to the router.
 *
 * This is a node test: `http/callbacks.ts` and its imports never reach `cloudflare:workers` (only
 * `workflows/worker.ts` does, and nothing here pulls it in).
 */

/** The composed email route tree — the same wiring `callbacks.workers.test.ts` uses, minus the env. */
function emailApp(): Hono<PithyHonoEnv> {
  const app = new Hono<PithyHonoEnv>();
  registerCallbacks(app);
  return app;
}

describe("email route param contract", () => {
  test("every :segment route declares a param validator", async () => {
    const app = emailApp();
    const uncovered = await uncoveredParamRoutes(app as unknown as Hono<never>);

    expect(
      uncovered,
      `These email routes read path params without a zValidator("param", …): ${uncovered
        .map((route) => `${route.method} ${route.path} (:${route.params.join(", :")})`)
        .join("; ")}. Add a schema to src/http/schemas.ts and declare it on the route line.`,
    ).toEqual([]);
  });

  test("the gate is inspecting the real route tree, not an empty one", () => {
    const app = emailApp();
    expect(app.routes.length).toBeGreaterThan(0);

    // Email mounts exactly three param-bearing paths — click, open, unsubscribe — each on `:token`.
    // Pinning them means a future route that loses its validator cannot pass by vanishing instead.
    const paramPaths = [...new Set(app.routes.filter((r) => pathParams(r.path).length > 0).map((r) => r.path))].sort();
    expect(paramPaths).toEqual([`${CALLBACK_BASE}/c/:token`, `${CALLBACK_BASE}/o/:token`, `${CALLBACK_BASE}/u/:token`]);
  });
});
