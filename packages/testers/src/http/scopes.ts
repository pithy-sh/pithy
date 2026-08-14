// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { AdminRoute } from "@pithy-sh/core/src/controlPlane/discovery/adminRoute";
import type { ControlPlaneScope } from "@pithy-sh/core/src/controlPlane/scope/scope";

/**
 * Testers' control-plane scopes, and the admin surface a manifest advertises.
 *
 * **Separate from `guards.ts` because a scope name is a client's business** (#315). A management
 * client reads these to render what a connection may do, and `pithy-sh/dashboard`'s scope builder
 * writes the `pithy dashboard connect --scope …` command from exactly these constants — in a browser
 * program, with the DOM lib and no Workers types. While they sat beside the Hono middleware, naming
 * one compiled `PithyHonoEnv`, which reached core's `capability.ts`, which named Worker globals that
 * program has none of. **This module imports types and nothing else, and a gate holds it there**:
 * `tooling/browser-scopes` compiles a DOM-only program against every scope the kit declares.
 */

/**
 * The scopes this capability's admin routes require.
 *
 * One scope per operation, matched by exact string equality — there is no prefix rule and no wildcard.
 * A single `testers:admin` flag would mean a dashboard credential issued to read a roster could also
 * mail every person on it, and mailing is the operation with a blast radius outside the adopter's own
 * systems.
 */
export const TESTERS_ROSTER_READ_SCOPE: ControlPlaneScope = "testers:roster:read";
export const TESTERS_ROSTER_WRITE_SCOPE: ControlPlaneScope = "testers:roster:write";
export const TESTERS_NUDGE_SEND_SCOPE: ControlPlaneScope = "testers:nudge:send";

/** Every control-plane scope this capability defines. */
export const TESTERS_CONTROL_PLANE_SCOPES: readonly ControlPlaneScope[] = [
  TESTERS_ROSTER_READ_SCOPE,
  TESTERS_ROSTER_WRITE_SCOPE,
  TESTERS_NUDGE_SEND_SCOPE,
];

/**
 * The admin routes this capability advertises on `GET /control-plane/manifest`.
 *
 * Built from the **resolved** `basePath`, never the default. An adopter who mounts this at `/beta` gets
 * a manifest naming `/beta/testers/...`, where a client assuming the default would 404 — and the whole
 * point of the manifest is that a management client composes its calls from the Worker rather than from
 * a route table it shipped with.
 */
export function testersAdminRoutes(basePath: string): AdminRoute[] {
  return [
    {
      method: "GET",
      path: `${basePath}/cohorts`,
      scope: TESTERS_ROSTER_READ_SCOPE,
      summary: "Cohort state, roster, per-tester activity, the forecast, and the trend series.",
    },
    {
      method: "POST",
      path: `${basePath}/invite`,
      scope: TESTERS_ROSTER_WRITE_SCOPE,
      summary: "Invite an address onto a cohort and send its confirmation link.",
    },
    {
      method: "POST",
      path: `${basePath}/resend`,
      scope: TESTERS_ROSTER_WRITE_SCOPE,
      summary: "Send another invitation, preserving the tester's existing history.",
    },
    {
      method: "POST",
      path: `${basePath}/remove`,
      scope: TESTERS_ROSTER_WRITE_SCOPE,
      summary: "Take a tester off a cohort's roster.",
    },
    {
      method: "POST",
      path: `${basePath}/nudge`,
      scope: TESTERS_NUDGE_SEND_SCOPE,
      summary: "Nudge selected testers. Copy may be overridden as text; the cooldown is enforced here.",
    },
  ];
}
