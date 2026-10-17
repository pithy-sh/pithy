// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Hono } from "hono";
import type { PithyHonoEnv, PithyReadinessGuard } from "../../capability/capability";

/**
 * Mount every capability's readiness guard, exempting the admin surface.
 *
 * **The control plane answers whatever else is wrong with the Worker.** It is the diagnostic surface: a
 * management client reads the manifest, migration state and drift through it. A guard that refuses every
 * request because an index drifted would take that surface down on exactly the fault it exists to report,
 * and the client could not tell drift from a Worker that is simply down.
 *
 * **The exemption is the guard, not the middleware.** The seam itself runs on capability middleware —
 * `controlplane()` publishes the verifier and `audit()` publishes `emit` — so skipping middleware on a
 * seam request would trade a 500 for a seam that denies everything, or one that stops auditing without a
 * word. Readiness guards are the only middleware that refuses because the Worker is broken, so they are
 * the only thing skipped.
 *
 * **Hono decides what is on the surface, not a matcher written here.** One `app.use` per admin path marks
 * the request, so a `:segment` matches exactly as it does for the route and the CORS layer, and a literal
 * path never matches what is beneath it. The surface is the one `corsSurface(all)` computes, which
 * `routeContract.test.ts` already holds to the registered routes, so there is no second list to drift.
 *
 * The mark is a `WeakSet` over the raw `Request`, closed over here. A context variable would put an
 * internal flag on `PithyVars`, where every capability could read it and one could set it.
 *
 * Call after every capability's `middleware` and before any capability's `routes`. Before the routes,
 * because a terminal handler never calls `next()` and a guard mounted after it never runs.
 */
export function registerReadinessGuards(
  app: Hono<PithyHonoEnv>,
  surface: readonly { path: string }[],
  guards: readonly PithyReadinessGuard[],
): void {
  if (guards.length === 0) return;

  const onSurface = new WeakSet<Request>();
  for (const path of new Set(surface.map((entry) => entry.path))) {
    app.use(path, async (c, next) => {
      onSurface.add(c.req.raw);
      await next();
    });
  }

  for (const guard of guards) {
    app.use("*", (c, next) => (onSurface.has(c.req.raw) ? next() : guard(c, next)));
  }
}
