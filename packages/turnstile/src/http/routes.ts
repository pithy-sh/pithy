// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { requireControlPlane } from "@pithy-sh/core/src/controlPlane/http/guard";
import { describeRoute } from "@pithy-sh/core/src/http/routeSpec";
import { validate } from "@pithy-sh/core/src/http/validation";
import { workerIdentity } from "@pithy-sh/core/src/worker/identity";
import type { SecretsStoreEnv } from "@pithy-sh/secrets/src/env/bindings";
import type { Context, Hono } from "hono";
import { turnstileAnalyticsConfig } from "../analytics/source";
import { readWidgets, type WidgetDeps } from "../analytics/widgets";
import type { TurnstileConfig } from "../config/config";
import { TurnstileWidgetsResponse } from "./responses";
import { WidgetsQuery } from "./schemas";
import { TURNSTILE_WIDGETS_PATH, TURNSTILE_WIDGETS_READ_SCOPE } from "./scopes";

/**
 * Turnstile's one route: the control-plane read of which widget guards this environment (#731).
 *
 *   GET /turnstile/admin/widgets → widgets and outcomes (control-plane: turnstile:widgets:read) query: WidgetsQuery
 *
 * The humanity check itself is not a route. It stacks per route through the `turnstile()` middleware.
 */
export interface TurnstileRoutesOptions {
  /** The resolved turnstile config. */
  config: TurnstileConfig;
  /** Test seam: resolve the read's deps from the request context. Defaults to the env-based resolver. */
  resolveWidgets?: (c: Context<PithyHonoEnv>) => Promise<WidgetDeps>;
}

/**
 * The read's deps from the request env: the environment the Worker's stamped `ENVIRONMENT` var names, and an
 * analytics reader built only when a real widget is in force, on the application's one `runtime` token.
 */
function defaultResolveWidgets(config: TurnstileConfig): (c: Context<PithyHonoEnv>) => Promise<WidgetDeps> {
  return async (c) => {
    const cloudflare = turnstileAnalyticsConfig(c.env as unknown as SecretsStoreEnv);
    return {
      config,
      environment: workerIdentity(c.env).environment,
      // Loaded at the point of use: the Cloudflare SDK costs a CLI command that only reads the capability
      // hundreds of milliseconds, and a test-key environment never builds a reader at all.
      source: async () => {
        const { CloudflareAnalyticsManager } = await import("@pithy-sh/cloudflare/src/analytics/analyticsManager");
        return new CloudflareAnalyticsManager(await cloudflare());
      },
      now: () => new Date(),
    };
  };
}

/** Register turnstile's sub-router. Returned as the capability's `routes` hook. */
export function registerTurnstileRoutes(options: TurnstileRoutesOptions): (app: Hono<PithyHonoEnv>) => void {
  const resolveWidgets = options.resolveWidgets ?? defaultResolveWidgets(options.config);
  return (app) => {
    app.get(
      TURNSTILE_WIDGETS_PATH,
      describeRoute({
        summary: "Read which widget guards this environment, and how its challenges went.",
        description:
          "The sitekey in force and whether it is one of Cloudflare's test keys, with challenge outcomes for a real widget from Cloudflare's Turnstile analytics, filtered by its sitekey. A test key makes no query. The window defaults to the last 30 days.",
        verification: "control-plane",
        scopes: [TURNSTILE_WIDGETS_READ_SCOPE],
        responses: { 200: TurnstileWidgetsResponse },
      }),
      requireControlPlane(TURNSTILE_WIDGETS_READ_SCOPE),
      validate("query", WidgetsQuery),
      async (c) => {
        const report = await readWidgets(await resolveWidgets(c), c.req.valid("query"));
        return c.json(report satisfies TurnstileWidgetsResponse, 200);
      },
    );
  };
}
