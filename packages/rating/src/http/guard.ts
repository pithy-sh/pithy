// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { UnauthorizedError } from "@pithy-sh/core/src/error/pithyError";
import type { MiddlewareHandler } from "hono";
import { RatingRecordForbiddenError } from "../error/errors";

/**
 * Route guards over the `AuthContext` seam. Copied — not imported from `@pithy-sh/auth` — so the rating
 * capability keeps `dependsOn` empty: without auth installed, `c.var.auth` is null and every guarded
 * route is denied rather than open (the leaderboard pattern).
 */

/** Deny any request without a resolved identity. The first handler on every rating route. */
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
 * Gate outcome recording behind the record scope when the capability is server-authoritative. A client
 * cannot report that it won; only a trusted server holding the scope may write ratings.
 */
export function requireRecordScope(serverAuthoritative: boolean, scope: string): MiddlewareHandler<PithyHonoEnv> {
  return async (c, next) => {
    if (serverAuthoritative && !c.var.auth?.scopes.includes(scope)) {
      throw new RatingRecordForbiddenError({ detail: `Recording an outcome requires the "${scope}" scope.` });
    }
    await next();
  };
}
