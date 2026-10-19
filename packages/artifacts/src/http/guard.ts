// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { UnauthorizedError } from "@pithy-sh/core/src/error/pithyError";
import type { MiddlewareHandler } from "hono";
import { mayManage } from "../access/access";
import { ArtifactsForbiddenError } from "../error/errors";

/**
 * Route guards over core's seams. Copied rather than imported from `@pithy-sh/auth` or `@pithy-sh/organization`, so
 * this capability depends on neither: without auth every route is denied, and without organization the
 * organization routes are not mounted at all.
 */

/** Deny any request without a resolved identity. The first guard on every route. */
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
 * **The organization routes' gate: an organization in force, then the named power — in that order.** Asked of core's
 * acting-organization seam, which `@pithy-sh/organization` fills from a membership row read on this request, never
 * from a session claim. Nothing in force is a fact about the caller's own session, so it may be said plainly.
 */
export function requireManagePower(managePower: string): MiddlewareHandler<PithyHonoEnv> {
  return async (c, next) => {
    const acting = await c.var.actingOrganization();
    if (acting === null) {
      throw new ArtifactsForbiddenError({
        message: "No organization is in force.",
        action: "Choose an organization to continue.",
        detail: `user ${c.var.auth?.userId ?? "unknown"} acts for no organization`,
      });
    }
    if (!mayManage(acting, managePower)) {
      throw new ArtifactsForbiddenError({
        message: `Your role in this organization does not allow \`${managePower}\`.`,
        detail: `the caller's role in organization ${acting.organizationId} does not hold ${managePower}`,
      });
    }
    await next();
  };
}
