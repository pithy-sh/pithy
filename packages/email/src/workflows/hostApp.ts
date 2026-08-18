// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import type { AmbientEnv } from "@pithy-sh/core/src/env/ambient";
import { pithyErrorHandler } from "@pithy-sh/core/src/error/http";
import { registerWorkflowDispatchRoute } from "@pithy-sh/core/src/workflow/dispatchRoute";
import { Hono } from "hono";
import { EMAIL_CAPABILITY } from "../provision/provisionEmail";
import { emailWorkflowRegistry } from "../provision/resolveEmailConfig";

/**
 * The email host worker's HTTP surface: one route, and only in `dev`.
 *
 * The host had no `fetch` at all — it was reached by Workflow dispatch and its cron, and nothing
 * else. That is still true of a deployed environment: an app worker holds a cross-script
 * `EMAIL_SENDER` binding and never speaks HTTP to this Worker. Locally there is no such binding,
 * because `pithy dev` runs each worker as its own `wrangler dev` and CLAUDE.md rules out wrangler's
 * cross-process service registry. So `pithy dev` composes a loopback dispatcher instead, pointed at
 * `EMAIL_ORIGIN`, and this is the door it knocks on (pithy-sh/pithy#410).
 *
 * Everything about the route — the environment gate, the `public` verification strategy, the request
 * contract, the 202 — belongs to `@pithy-sh/core/src/workflow/dispatchRoute`, so the other eight
 * capability hosts mount the identical thing. What is email's is the registry: `:binding` resolves
 * against email's own two jobs, and the payload validates against the declaring spec's schema.
 *
 * Built here rather than inside `worker.ts` because that module imports `cloudflare:workers` and so
 * cannot be loaded under node. This one can, which is what lets the wiring be tested without a
 * Workers runtime — and the wiring is the part that was missing.
 */

/** What the app needs to know beyond its registry: where it is running. */
export interface EmailHostAppOptions {
  /**
   * The ambient environment the dispatch gate reads. Defaults to the process env, which in a Worker
   * is the script's own vars — where provisioning stamps `ENVIRONMENT`. Injectable for tests.
   */
  env?: AmbientEnv;
}

/** Build the email host worker's app: the Pithy error handler, and the workflow dispatch route. */
export function createEmailHostApp(options: EmailHostAppOptions = {}): Hono<PithyHonoEnv> {
  const app = new Hono<PithyHonoEnv>();
  // The same handler every composed Pithy app mounts, so a refusal on this door renders as a
  // `PithyError` on the wire rather than as a stack trace the loopback dispatcher would report as an
  // unreadable body.
  app.onError(pithyErrorHandler);
  registerWorkflowDispatchRoute(app, {
    capability: EMAIL_CAPABILITY,
    registry: emailWorkflowRegistry,
    env: options.env,
  });
  return app;
}
