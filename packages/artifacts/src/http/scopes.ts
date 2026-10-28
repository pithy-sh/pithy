// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { AdminRouteDeclaration } from "@pithy-sh/core/src/controlPlane/discovery/adminRoute";
import type { ControlPlaneScope } from "@pithy-sh/core/src/controlPlane/scope/scope";

/**
 * The artifacts capability's control-plane scopes, and the admin surface a manifest advertises.
 *
 * **Separate from the routes because a scope name is a client's business**. A management client reads these
 * to render what a connection may do, in a browser program with no Workers types, so this module imports types and
 * nothing else. `tooling/browser-scopes` compiles it in that program and fails the day it stops being true.
 *
 * ## Two scopes: one reads, one takes a key back
 *
 * `scopeCovers` matches exactly, so neither confers the other. Reading who holds a key to a repository is a pane;
 * revoking one ends somebody's push mid-afternoon, and an adopter who hands out the first must be able to withhold the
 * second. `pithy dashboard connect` grants the read by default, because its whole surface is a read, and offers the
 * revoke.
 *
 * `artifacts:tokens:revoke` is kind `credentials`, because what it acts on is a credential.
 *
 * There is no scope to create, fork or delete a repository. Those stay the owner's, through the routes a signed-in
 * person calls.
 */

/** Read repositories — metadata, grants and history — and every token on one, with its holder. */
export const ARTIFACTS_REPOS_READ_SCOPE: ControlPlaneScope = "artifacts:repos:read";

/** Revoke one token on a repository, or every live one, with an idempotency key and a reason. */
export const ARTIFACTS_TOKENS_REVOKE_SCOPE: ControlPlaneScope = "artifacts:tokens:revoke";

/**
 * Every control-plane scope this capability defines — what `pithy dashboard connect` offers for it, and the list a
 * doc quotes rather than re-typing.
 */
export const ARTIFACTS_CONTROL_PLANE_SCOPES: readonly ControlPlaneScope[] = [
  ARTIFACTS_REPOS_READ_SCOPE,
  ARTIFACTS_TOKENS_REVOKE_SCOPE,
];

/**
 * The management surface, as `GET /control-plane/manifest` reports it. Built from the resolved `basePath`, never a
 * default, so an adopter who mounted the capability elsewhere gets a manifest naming where it actually is.
 *
 * **Everything sits under `admin/`**, so the management routes and the owner's `/repos/:name` can never collide.
 */
export function artifactsAdminRoutes(basePath: string): AdminRouteDeclaration[] {
  return [
    {
      method: "GET",
      operation: "repos.list",
      path: `${basePath}/admin/repos`,
      scope: ARTIFACTS_REPOS_READ_SCOPE,
      kind: "reads",
      summary: "Page every repository, newest first, with its owner, remote access and last push.",
    },
    {
      method: "GET",
      operation: "repos.read",
      path: `${basePath}/admin/repos/:name`,
      scope: ARTIFACTS_REPOS_READ_SCOPE,
      kind: "reads",
      summary: "One repository's metadata, its grants, and its commit log, paged.",
    },
    {
      method: "GET",
      operation: "tokens.list",
      path: `${basePath}/admin/repos/:name/tokens`,
      scope: ARTIFACTS_REPOS_READ_SCOPE,
      kind: "reads",
      summary: "Every token on one repository, with its scope, state, expiry and holder.",
    },
    {
      method: "POST",
      operation: "tokens.revoke",
      path: `${basePath}/admin/repos/:name/tokens/:tokenId/revoke`,
      scope: ARTIFACTS_TOKENS_REVOKE_SCOPE,
      kind: "credentials",
      summary: "Revoke one token, with an idempotency key and a reason.",
    },
    {
      method: "POST",
      operation: "tokens.revoke_all",
      path: `${basePath}/admin/repos/:name/tokens/revoke`,
      scope: ARTIFACTS_TOKENS_REVOKE_SCOPE,
      kind: "credentials",
      summary: "Revoke every live token on one repository, with an idempotency key and a reason.",
    },
  ];
}
