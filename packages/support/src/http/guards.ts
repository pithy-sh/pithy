// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import type { AdminRoute } from "@pithy-sh/core/src/controlPlane/discovery/adminRoute";
import type { ControlPlaneScope } from "@pithy-sh/core/src/controlPlane/scope/scope";
import { UnauthorizedError } from "@pithy-sh/core/src/error/pithyError";
import type { MiddlewareHandler } from "hono";

/**
 * Support's two identity gates: the control-plane scopes its management routes demand of core's seam,
 * and the copied `requireAuth()` its in-app submission routes wear.
 *
 * ## Two surfaces, and the split is the whole shape of this file
 *
 * **The management surface is `control-plane` and default-denied.** It reads and acts on every
 * customer's private correspondence, so it answers to a credential the adopter issued and to nothing
 * else. The seam's gate is imported from core rather than copied — core is a hard dependency of every
 * capability, so importing its gate cannot leave a deployment without one, and with the seam
 * uncomposed `requireControlPlane` raises `controlplane/not_connected` rather than passing.
 *
 * **The submission surface is `bearer`/`session` and is the adopter's own signed-in user.** It exists
 * because a product with a logged-in user, a session, and a support console should not have to ask
 * that user to open their mail client — and because the hardest problem on the mail path, proving a
 * `From:` header, does not exist on a request whose session was already proved.
 *
 * **`requireAuth()` never appears on a management route, and `requireControlPlane` never appears on a
 * submission route.** They are not two strengths of the same gate. A management client holds no
 * session and owns no account row — core leaves `c.var.auth` null for one deliberately — so stacking
 * them would deny every legitimate call on both surfaces, permanently, with no credential able to fix
 * it. What each route may *see* follows from which gate it wears: an operator reads a thread with its
 * classification and its sender's purchases, and a submitter reads their own words back and nothing
 * else.
 *
 * ## Five scopes, because these are five different blast radii
 *
 * The temptation is one `support:admin` flag. It is wrong on the merits, the same way payments'
 * single flag was: **reading** an inbox exposes every customer's private correspondence, while
 * **replying** sends mail to a real person under the adopter's domain and DKIM. Those are not the
 * same permission, and a tool that needed one should never silently hold the other. `scopeCovers`
 * matches exactly, with no prefix or wildcard rule, so holding one confers nothing about the rest.
 *
 * The split that matters most is `reply`. A compromised read credential is a privacy incident; a
 * compromised reply credential is somebody sending mail *as the adopter* to their own customers,
 * which is a phishing platform with a verified sending domain attached.
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

/** Read the inbox: list threads, read one, and see the sender's linked account and purchases. */
export const SUPPORT_THREADS_READ_SCOPE: ControlPlaneScope = "support:threads:read";

/** Mark a thread done or reopen it — the one shared piece of state in the model. */
export const SUPPORT_THREADS_ARCHIVE_SCOPE: ControlPlaneScope = "support:threads:archive";

/**
 * Send mail to a customer under the adopter's domain. The most dangerous of the five and the reason
 * a single admin flag was never an option.
 */
export const SUPPORT_THREADS_REPLY_SCOPE: ControlPlaneScope = "support:threads:reply";

/** Re-run the model over a thread, overwriting its current classification. */
export const SUPPORT_THREADS_RECLASSIFY_SCOPE: ControlPlaneScope = "support:threads:reclassify";

/** Set a viewer's own read/snooze flags. Private, uncoordinated, and the least dangerous thing here. */
export const SUPPORT_THREADS_FLAG_SCOPE: ControlPlaneScope = "support:threads:flag";

/**
 * Every control-plane scope support defines — what `pithy dashboard connect` offers for this
 * capability, and the list a manifest or a doc quotes rather than re-typing.
 */
export const SUPPORT_CONTROL_PLANE_SCOPES: readonly ControlPlaneScope[] = [
  SUPPORT_THREADS_READ_SCOPE,
  SUPPORT_THREADS_ARCHIVE_SCOPE,
  SUPPORT_THREADS_REPLY_SCOPE,
  SUPPORT_THREADS_RECLASSIFY_SCOPE,
  SUPPORT_THREADS_FLAG_SCOPE,
];

/**
 * Support's management surface, as `GET /control-plane/manifest` reports it.
 *
 * Declared beside the scopes so the scope a route demands and the scope a manifest advertises are
 * the same constant. `basePath` is a parameter and never a default: an adopter who mounted support
 * at `/inbox` must get a manifest naming `/inbox/threads`, or a client composing its calls from the
 * manifest would 404 against exactly the adopters who customised anything.
 *
 * The summaries say what the operation is *for*. A client renders these next to a button somebody is
 * about to press on a real customer's conversation.
 */
export function supportAdminRoutes(basePath: string): AdminRoute[] {
  return [
    {
      method: "GET",
      path: `${basePath}/threads`,
      scope: SUPPORT_THREADS_READ_SCOPE,
      summary: "List the inbox, newest first, filtered by category, priority, and archived, searched by text.",
    },
    {
      method: "GET",
      path: `${basePath}/threads/:id`,
      scope: SUPPORT_THREADS_READ_SCOPE,
      summary: "Read one conversation, with the sender's linked account and what they bought.",
    },
    {
      method: "POST",
      path: `${basePath}/threads/:id/archive`,
      scope: SUPPORT_THREADS_ARCHIVE_SCOPE,
      summary: "Mark a conversation done, or reopen one.",
    },
    {
      method: "POST",
      path: `${basePath}/threads/:id/reply`,
      scope: SUPPORT_THREADS_REPLY_SCOPE,
      summary: "Answer the customer, threaded so their mail client keeps one conversation.",
    },
    {
      method: "POST",
      path: `${basePath}/threads/:id/reclassify`,
      scope: SUPPORT_THREADS_RECLASSIFY_SCOPE,
      summary: "Re-run the classifier over this conversation's latest inbound message.",
    },
    {
      method: "POST",
      path: `${basePath}/threads/:id/flags`,
      scope: SUPPORT_THREADS_FLAG_SCOPE,
      summary: "Set your own read and snooze state for a conversation. Private to you.",
    },
    {
      method: "GET",
      path: `${basePath}/replies`,
      scope: SUPPORT_THREADS_READ_SCOPE,
      summary: "The canned reply catalog — starting points to pick from, ordered for a thread's category.",
    },
  ];
}
