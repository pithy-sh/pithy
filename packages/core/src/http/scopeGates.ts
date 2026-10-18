// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { Hono } from "hono";
import type { PithyHonoEnv, ScopeGate } from "../capability/capability";
import { routeSpecOf } from "./routeSpec";

/**
 * **A capability's scope gates, read off its own routes rather than listed beside them (#560).**
 *
 * `Capability.scopeGates` is what `pithy doctor` names when nothing composed fills `AuthContext.scopes`.
 * A list written out by hand next to the routes is a second copy of something the routes already say: every
 * gated route carries `describeRoute({ scopes })`, because that is how the OpenAPI contract learns it. So the
 * registrar is run against a throwaway app and the specs are read back — the same walk `openApiDocument`
 * makes over a composed app, and a route whose scope changes changes what this returns with it.
 *
 * **Only `bearer` and `session` routes.** Those are the strategies `requireAuth()` takes, so a scope on one
 * is an `AuthContext` scope. A `control-plane` route also names scopes, and they are a different credential
 * entirely — a signed management token with its own type, never `c.var.auth` — so naming one here would tell
 * an adopter to configure a resolver that could never open it.
 */
export function scopeGatesOf(register: (app: Hono<PithyHonoEnv>) => void): ScopeGate[] {
  const app = new Hono<PithyHonoEnv>();
  register(app);
  const gates: ScopeGate[] = [];
  for (const route of app.routes) {
    const spec = routeSpecOf(route.handler);
    if (!spec?.scopes || spec.scopes.length === 0) continue;
    const verification = [spec.verification].flat();
    if (!verification.some((strategy) => strategy === "bearer" || strategy === "session")) continue;
    for (const scope of spec.scopes) gates.push({ scope, route: `${route.method} ${route.path}` });
  }
  return gates;
}
