// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { AdminRoute } from "@pithy-sh/core/src/controlPlane/discovery/adminRoute";
import type { ControlPlaneScope } from "@pithy-sh/core/src/controlPlane/scope/scope";

/**
 * Auth's control-plane scopes, and the admin surface a manifest advertises.
 *
 * ## The gate is core's; auth contributes only the scope names
 *
 * `requireControlPlane` lives in `@pithy-sh/core/src/controlPlane/http/guard` and every admin route
 * wears it directly. Auth verifies nothing itself: a management call arrives as an EdDSA-signed compact
 * JWS on the `pithy-control-plane` header, and the seam checks the signature against a public key the
 * **adopter** registered, the connection it addresses, that connection's environment, the token's
 * lifetime, a digest of the body, and the token's single use.
 *
 * Importing that gate is not the opposite of `requireAuth` being copied into every other capability; it
 * is the same rule. The rule is never to import authorization from a package that might be absent.
 * `@pithy-sh/core` is a hard dependency of every capability there is, and with the seam *uncomposed*
 * the imported gate raises `controlplane/not_connected` rather than passing. Both halves fail closed.
 *
 * ## `requireAuth()` must never appear on one of these routes
 *
 * This is the sharpest edge in this package, because auth is the capability that *implements*
 * `requireAuth`. A management client is not a user of the adopter's app: it holds no session, owns no
 * user row, and the seam deliberately leaves `c.var.auth` null so a control-plane credential cannot
 * satisfy an ordinary `requireAuth()` anywhere in the tree. An auth gate on an admin route would deny
 * every legitimate management call, permanently, and **no credential could fix it** — there is no user
 * to sign in as. `controlPlaneIsolation.workers.test.ts` pins both directions of that separation.
 *
 * ## Five scopes, because these are five different blast radii
 *
 * The temptation is one `auth:admin` flag, and on this capability it is the most dangerous version of
 * that mistake. **Reading a user is a privacy operation; revoking their sessions is an availability
 * one.** A support tool that looks people up should never be able to sign the whole customer base out,
 * and an incident-response tool that kills a stolen session has no business reading every address in
 * the user table. `scopeCovers` matches exactly, with no prefix or wildcard rule, so holding one of
 * these confers nothing whatever about the others — `auth:users` grants none of them.
 *
 * The split within *reads* is between one user and the fleet: `auth:users:read` answers "who is this
 * person", while `auth:devices:read` walks every device of every user, which is a different question
 * with a much larger answer. The split within *writes* is by blast radius: one session, one device, or
 * every session a person has.
 *
 * The names are constants rather than config. A configurable scope name is a way to misconfigure a
 * default-denied gate into a differently-named one, and tooling that read the docs would then hold a
 * scope nothing checks. They are also the join key with what `pithy dashboard connect` offers an
 * adopter to grant, so they must be the same strings in both places.
 *
 * ## There is no impersonation scope, and its absence is deliberate
 *
 * "Sign in as this user" is the most dangerous administrative capability there is: it produces a
 * credential indistinguishable from the user's own, so every action taken with it reads in the trail as
 * theirs. It is excluded from this surface on purpose and is not reachable by composing what is here —
 * nothing below mints a session, and the read routes never project a session token. If it is ever
 * built it gets its own design and its own security review, not a scope added to this list.
 */

/**
 * Look a user up and read their account: the listing, the search, and one user with their sessions and
 * devices. The privacy-bearing read — it returns email addresses, IPs, and user agents — and by far the
 * most commonly granted, because nearly every dashboard pane resolves to a user.
 */
export const AUTH_USERS_READ_SCOPE: ControlPlaneScope = "auth:users:read";

/**
 * Walk the device registry across every user. Separate from reading one user because the question is
 * different in kind: this is fleet-wide, and answers "what is signing in to this product" rather than
 * "what does this person use".
 */
export const AUTH_DEVICES_READ_SCOPE: ControlPlaneScope = "auth:devices:read";

/**
 * Revoke one named session. The targeted write — what an incident-response tool needs to kill a stolen
 * token, and nothing more. Granting it confers no ability to read who the session belongs to.
 */
export const AUTH_SESSIONS_REVOKE_SCOPE: ControlPlaneScope = "auth:sessions:revoke";

/**
 * Sign one user out everywhere: every session on every device, at once. The most disruptive thing on
 * this surface — the person is signed out of the product mid-use with no warning — which is exactly why
 * it is granted separately from revoking a single session.
 */
export const AUTH_USERS_LOGOUT_SCOPE: ControlPlaneScope = "auth:users:logout";

/**
 * Sign one of a user's devices out and drop its registration, so it must register again at next
 * sign-in. The admin counterpart of the user's own `POST /devices/revoke`, for a phone somebody
 * reported lost — and destructive in a way the session revokes are not, because the device row and its
 * push token go with it.
 */
export const AUTH_DEVICES_REVOKE_SCOPE: ControlPlaneScope = "auth:devices:revoke";

/**
 * Every control-plane scope auth defines — what `pithy dashboard connect` offers for this capability,
 * and the list a manifest or a doc quotes rather than re-typing.
 */
export const AUTH_CONTROL_PLANE_SCOPES: readonly ControlPlaneScope[] = [
  AUTH_USERS_READ_SCOPE,
  AUTH_DEVICES_READ_SCOPE,
  AUTH_SESSIONS_REVOKE_SCOPE,
  AUTH_USERS_LOGOUT_SCOPE,
  AUTH_DEVICES_REVOKE_SCOPE,
];

/**
 * Auth's management surface, as `GET /control-plane/manifest` reports it.
 *
 * Declared beside the scopes rather than in `adminRoutes.ts`, so the scope a route demands and the
 * scope a manifest advertises are the same constant read from one place. `basePath` is a parameter and
 * never a default: an adopter who mounted auth at `/identity` must get a manifest naming
 * `/identity/admin/users`, or a management client composing its calls from the manifest would 404
 * against exactly the adopters who customized anything.
 *
 * The summaries say what the operation is *for*. A client renders these next to a button somebody is
 * about to press on a real person's account.
 */
export function authAdminRoutes(basePath: string): AdminRoute[] {
  return [
    {
      method: "GET",
      path: `${basePath}/admin/users`,
      scope: AUTH_USERS_READ_SCOPE,
      summary: "Find a user. Lists everyone newest first, or searches email and display name.",
    },
    {
      method: "GET",
      path: `${basePath}/admin/users/:userId`,
      scope: AUTH_USERS_READ_SCOPE,
      summary: "One user, with where they are signed in and what they sign in with.",
    },
    {
      method: "GET",
      path: `${basePath}/admin/devices`,
      scope: AUTH_DEVICES_READ_SCOPE,
      summary: "The device registry across users, most-recently-seen first.",
    },
    {
      method: "POST",
      path: `${basePath}/admin/sessions/revoke`,
      scope: AUTH_SESSIONS_REVOKE_SCOPE,
      summary: "Kill one session. The rest of that person's sign-ins keep working.",
    },
    {
      method: "POST",
      path: `${basePath}/admin/users/:userId/sessions/revoke`,
      scope: AUTH_USERS_LOGOUT_SCOPE,
      summary: "Sign a user out everywhere, on every device, immediately.",
    },
    {
      method: "POST",
      path: `${basePath}/admin/users/:userId/devices/revoke`,
      scope: AUTH_DEVICES_REVOKE_SCOPE,
      summary: "Sign one device out and forget it — for a phone reported lost.",
    },
  ];
}
