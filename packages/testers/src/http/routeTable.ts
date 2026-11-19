// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { ControlPlaneScope } from "@pithy-sh/core/src/controlPlane/scope/scope";
import type { DeclaredRoute } from "@pithy-sh/core/src/http/lazyRoutes";
import type { VerificationStrategy } from "@pithy-sh/core/src/http/verification";
import { TESTERS_NUDGE_SEND_SCOPE, TESTERS_ROSTER_READ_SCOPE, TESTERS_ROSTER_WRITE_SCOPE } from "./scopes";

/**
 * What every route this capability mounts declares: its path, its verification strategy, and the
 * control-plane scope it checks when it has one.
 *
 * **Exported so a test can assert against the declaration rather than against a middleware count.** The
 * previous gate counted entries in `app.routes` and called anything above one "guarded" — which a bare
 * `zValidator` satisfies, so a control-plane route that lost its `requireControlPlane` would still have
 * passed. Counting proves that *something* runs before the handler; it cannot prove *what*.
 *
 * This is a declaration rather than an inference, so it can drift from the router. `routeContract.test.ts`
 * is what stops it: it checks this list against the paths Hono actually registered in both directions,
 * so a route added without an entry and an entry without a route both fail.
 */
export interface TestersRouteDeclaration {
  readonly method: "GET" | "POST";
  /** The path relative to the configured `basePath`, e.g. `/cohorts`. */
  readonly path: string;
  readonly strategy: VerificationStrategy;
  /** The control-plane scope this route checks, for a `control-plane` route. */
  readonly scope?: ControlPlaneScope;
}

/**
 * Every route, and how it is gated.
 *
 * The three `public` entries are the tester's own links. They carry no scope and no auth because the
 * token in the path is the entire credential — a tester confirming from an email has no account and
 * must not need one.
 */
export const TESTERS_ROUTES: readonly TestersRouteDeclaration[] = [
  { method: "GET", path: "/confirm/:token", strategy: "public" },
  { method: "GET", path: "/opt-in/:token", strategy: "public" },
  { method: "GET", path: "/opt-out/:token", strategy: "public" },
  { method: "POST", path: "/opt-out/:token", strategy: "public" },
  { method: "GET", path: "/status", strategy: "bearer" },
  { method: "GET", path: "/cohorts", strategy: "control-plane", scope: TESTERS_ROSTER_READ_SCOPE },
  { method: "POST", path: "/invite", strategy: "control-plane", scope: TESTERS_ROSTER_WRITE_SCOPE },
  { method: "POST", path: "/resend", strategy: "control-plane", scope: TESTERS_ROSTER_WRITE_SCOPE },
  { method: "POST", path: "/remove", strategy: "control-plane", scope: TESTERS_ROSTER_WRITE_SCOPE },
  { method: "POST", path: "/nudge", strategy: "control-plane", scope: TESTERS_NUDGE_SEND_SCOPE },
];

/** Every route `registerTestersRoutes` mounts under `base`, read off {@link TESTERS_ROUTES}. */
export function testersRouteTable(base: string): DeclaredRoute[] {
  return TESTERS_ROUTES.map(({ method, path }) => ({ method, path: `${base}${path}` }));
}
