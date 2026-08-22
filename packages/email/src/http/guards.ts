// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { AdminRoute } from "@pithy-sh/core/src/controlPlane/discovery/adminRoute";
import type { ControlPlaneScope } from "@pithy-sh/core/src/controlPlane/scope/scope";

/**
 * Email's control-plane scopes, and the admin surface a manifest advertises.
 *
 * ## There is no `requireAuth` in this file, and that is deliberate
 *
 * Every other capability copies a local `requireAuth()` because it has an end-user surface to gate.
 * Email has none: the three callback routes are public-plus-signed-token (a recipient tapping a
 * tracking link has no session and must not need one), and everything below is `control-plane`. There
 * is nothing here for an authenticated user to call, so there is no gate to copy.
 *
 * The seam's gate is **imported** from `@pithy-sh/core/src/controlPlane/http/guard` rather than copied.
 * That is not the opposite of the copy rule; it is the same rule. The rule is never to import
 * authorization from a package that might be absent — `@pithy-sh/auth` is optional, so its gate is
 * copied. Core is a hard dependency of every capability there is, so importing its gate cannot leave a
 * deployment without one, and with the seam uncomposed `requireControlPlane` raises
 * `controlplane/not_connected` rather than passing. Both halves fail closed.
 *
 * **`requireAuth()` must never sit on one of these routes.** The seam deliberately leaves `c.var.auth`
 * null so that a management credential cannot satisfy an ordinary `requireAuth()` anywhere in the tree.
 * An auth gate on an admin route would therefore deny every legitimate management call, permanently,
 * and no credential could fix it.
 *
 * ## Five scopes, because these are five different blast radii
 *
 * The temptation is one `email:admin` flag. It is wrong on the merits, and email is the capability
 * where it is most obviously wrong, because the five operations here fail in five unrelated directions:
 *
 * - **Reading jobs** discloses who the adopter mailed and when. A privacy incident.
 * - **Retrying a job** sends real mail to a real person under the adopter's domain and DKIM. Reach
 *   outside the adopter's own systems, from a credential that was only ever meant to look.
 * - **Reading suppressions** discloses, in one list, every address in the whole project that ever
 *   bounced, complained, or unsubscribed — across every environment, since that database is global.
 * - **Adding a suppression** is a silent, targeted denial of service: block one address and that
 *   person never receives another magic link, and nothing anywhere reports an error.
 * - **Removing a suppression** re-opens sending to somebody who reported spam or asked to be left
 *   alone. That is a deliverability incident, a reputation hit on the sending domain, and depending on
 *   the jurisdiction a compliance one.
 *
 * A tool that retries stuck receipts needs `email:jobs:read` and `email:jobs:retry` and must never
 * hold either suppression write. A deliverability dashboard needs `email:suppressions:read` and
 * nothing else. One flag makes each of those the other. `scopeCovers` matches exactly, with no prefix
 * and no wildcard rule, so holding one of these confers nothing about the rest — `email:jobs:read`
 * does not imply `email:jobs:retry`, and `email:suppressions:write` does not imply the delete.
 *
 * The names are constants rather than config: a configurable scope name is a way to misconfigure a
 * default-denied gate into a differently-named one, and they are the join key with what
 * `pithy dashboard connect` offers an adopter to grant.
 */

/**
 * Read the job log — the list and one job in full.
 *
 * The list projects a masked recipient and the detail projects the whole address, which is a bulk-harvest
 * control rather than two permissions: see `view.ts`. Both are the same scope because both are reads of
 * the same table, and splitting them would only produce a credential that could page the log but never
 * diagnose a single row in it.
 */
export const EMAIL_JOBS_READ_SCOPE: ControlPlaneScope = "email:jobs:read";

/**
 * Put a failed job back in the queue. The only operation in this capability that causes mail to be
 * sent, which is why it is granted separately from reading the log it is chosen from.
 */
export const EMAIL_JOBS_RETRY_SCOPE: ControlPlaneScope = "email:jobs:retry";

/**
 * Read the global suppression list. Its own scope, and not folded into `email:jobs:read`, because that
 * database is shared by every environment: a staging connection reading it sees production's bounces.
 */
export const EMAIL_SUPPRESSIONS_READ_SCOPE: ControlPlaneScope = "email:suppressions:read";

/** Block an address by hand. Silent to the recipient and effective on the project's next send. */
export const EMAIL_SUPPRESSIONS_WRITE_SCOPE: ControlPlaneScope = "email:suppressions:write";

/**
 * Unblock an address. The most dangerous of the five: it undoes a hard bounce, a spam complaint, or a
 * recipient's own opt-out, and the consequences land on the adopter's sending reputation rather than
 * in a response body.
 */
export const EMAIL_SUPPRESSIONS_DELETE_SCOPE: ControlPlaneScope = "email:suppressions:delete";

/**
 * Every control-plane scope email defines — what `pithy dashboard connect` offers for this capability,
 * and the list a manifest or a doc quotes rather than re-typing.
 */
export const EMAIL_CONTROL_PLANE_SCOPES: readonly ControlPlaneScope[] = [
  EMAIL_JOBS_READ_SCOPE,
  EMAIL_JOBS_RETRY_SCOPE,
  EMAIL_SUPPRESSIONS_READ_SCOPE,
  EMAIL_SUPPRESSIONS_WRITE_SCOPE,
  EMAIL_SUPPRESSIONS_DELETE_SCOPE,
];

/**
 * Email's management surface, as `GET /control-plane/manifest` reports it.
 *
 * Declared beside the scopes so the scope a route demands and the scope a manifest advertises are the
 * same constant, read from one place. `basePath` is a parameter and never a default: an adopter who
 * mounted email at `/mail` must get a manifest naming `/mail/jobs`, or a management client composing
 * its calls from it would 404 against exactly the adopters who customized anything.
 *
 * The callback routes are **not** here. They are a recipient's tracking and unsubscribe links, mounted
 * at a fixed prefix and gated by a signature; they are not management surface and a dashboard has no
 * business calling them.
 *
 * The summaries say what the operation is *for*. A client renders these next to a button somebody is
 * about to press on a real person's mail.
 */
export function emailAdminRoutes(basePath: string): AdminRoute[] {
  return [
    {
      method: "GET",
      path: `${basePath}/jobs`,
      scope: EMAIL_JOBS_READ_SCOPE,
      summary: "The send log, newest first, filtered by status. Recipients are masked in the list.",
    },
    {
      method: "GET",
      path: `${basePath}/jobs/:id`,
      scope: EMAIL_JOBS_READ_SCOPE,
      summary: "One job in full — the recipient, the subject, and why it failed. Never the template variables.",
    },
    {
      method: "POST",
      path: `${basePath}/jobs/:id/retry`,
      scope: EMAIL_JOBS_RETRY_SCOPE,
      summary: "Queue a failed job again with a fresh attempt budget. Sends real mail.",
    },
    {
      method: "GET",
      path: `${basePath}/suppressions`,
      scope: EMAIL_SUPPRESSIONS_READ_SCOPE,
      summary: "Addresses this project will not send to, and why. Global — every environment shares it.",
    },
    {
      method: "POST",
      path: `${basePath}/suppressions`,
      scope: EMAIL_SUPPRESSIONS_WRITE_SCOPE,
      summary: "Block an address by hand, permanently or until a date. Recorded as a manual block.",
    },
    {
      method: "POST",
      path: `${basePath}/suppressions/remove`,
      scope: EMAIL_SUPPRESSIONS_DELETE_SCOPE,
      summary: "Unblock an address. Re-opens sending to somebody who bounced, complained, or opted out.",
    },
  ];
}
