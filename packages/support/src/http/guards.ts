// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { ForbiddenError, UnauthorizedError } from "@pithy-sh/core/src/error/pithyError";
import type { MiddlewareHandler } from "hono";
import type { SupportStaffConfig } from "../config/config";
import { staffMay } from "../staff/staff";

/**
 * Support's identity gates: the copied `requireAuth()` its in-app routes wear, the control-plane gate its
 * management routes take from core's seam, and `requireStaff()`, which lets the adopter's own staff onto a
 * slice of the management side through their session (#816).
 *
 * **The scope constants moved to `./scopes`** (#315). A management client reads them to render what a
 * connection may do, and it reads them in a browser — so they cannot live in a module that imports
 * Hono middleware and `PithyHonoEnv`. The gates stayed here; the names they demand are next door, and
 * the routes import both.
 *
 * ## Three doors, and the split is the whole shape of this file
 *
 * **The management surface is `control-plane` and default-denied.** It reads and acts on every
 * customer's private correspondence, so it answers to a credential the adopter issued. The seam's gate is
 * imported from core rather than copied — core is a hard dependency of every capability, so importing its
 * gate cannot leave a deployment without one, and with the seam uncomposed `requireControlPlane` raises
 * `controlplane/not_connected` rather than passing.
 *
 * **The submission surface is `bearer`/`session` and is the adopter's own signed-in user.** It exists
 * because a product with a logged-in user, a session, and a support console should not have to ask
 * that user to open their mail client — and because the hardest problem on the mail path, proving a
 * `From:` header, does not exist on a request whose session was already proved.
 *
 * **The staff door is a session, and it reaches management work.** `requireAuth()` then `requireStaff()`
 * admit a signed-in user whose role, in the organization the request acts for, holds one of the powers
 * `support({ staff })` names — and nobody at all when `staff` is absent. It opens two things and no more:
 * assigning a thread, at its own `/staff/` path, and joining a thread's presence room. Everything else on
 * the management side still answers to the control plane alone.
 *
 * **`requireAuth()` never appears on a control-plane route, and `requireControlPlane` never appears on a
 * session route.** They are not two strengths of the same gate. A management client holds no session and
 * owns no account row — core leaves `c.var.auth` null for one deliberately — so stacking them would deny
 * every legitimate call on both, permanently, with no credential able to fix it. That is why staff
 * assignment is a second route beside the control-plane one rather than a second gate on it. What each
 * route may *see* follows from which gate it wears: an operator reads a thread with its classification and
 * its sender's purchases, and a submitter reads their own words back and nothing else.
 */

/**
 * Require an authenticated caller — core's `AuthContext` seam, and the gate on every in-app route.
 *
 * **Copied from `@pithy-sh/auth`, not imported, and the duplication is deliberate.** Importing it would
 * make auth a hard dependency, and *a package that imports its authorization from another package
 * fails open when that package is absent*. Depending on the core seam instead means `c.var.auth` is
 * simply null with no auth capability composed, and every submission route denies. Failing closed is
 * not a side effect of the copy; it is the reason for it — and on this capability the thing behind the
 * gate is somebody's support history.
 */
export function requireAuth(): MiddlewareHandler<PithyHonoEnv> {
  return async (c, next) => {
    if (!c.var.auth) {
      throw new UnauthorizedError({
        message: "Authentication required.",
        action: "Sign in and retry with a valid session or bearer token.",
      });
    }
    await next();
  };
}

/**
 * Require one of support's staff powers in the organization this request acts for (#816) — the gate on
 * the staff session routes, after `requireAuth()`.
 *
 * With no `staff` configured, or no organization composed, or no organization in force, every caller is
 * refused: the inbox is every customer's correspondence, and the absence of a policy is never an open one.
 * The refusal names no power and no organization, because which power reaches the inbox is the adopter's
 * internal arrangement and a caller who does not hold it has no use for the name.
 */
export function requireStaff(
  staff: SupportStaffConfig | undefined,
  power: keyof SupportStaffConfig,
): MiddlewareHandler<PithyHonoEnv> {
  return async (c, next) => {
    const acting = await c.var.actingOrganization();
    if (!staffMay(acting, staff, power)) {
      throw new ForbiddenError({
        message: "You do not work this support inbox.",
        action: staff
          ? `Give the user an unassignable role holding \`${staff[power]}\`, through the control plane.`
          : "Name staff powers in support({ staff }) to let signed-in users work the inbox.",
        detail: `user ${c.var.auth?.userId ?? "unknown"} holds no ${power} for support in ${acting?.organizationId ?? "no organization"}`,
      });
    }
    await next();
  };
}
