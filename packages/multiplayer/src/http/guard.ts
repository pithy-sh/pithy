// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { UnauthorizedError } from "@pithy-sh/core/src/error/pithyError";
import type { MiddlewareHandler } from "hono";

/**
 * The one route guard: every multiplayer route requires an authenticated player.
 *
 * It depends on the core `AuthContext` seam and nothing else — `@pithy-sh/auth` populates `c.var.auth`,
 * and multiplayer never reaches into its internals (CLAUDE.md §HTTP). Without auth installed `c.var.auth`
 * is null and every route is denied, which is the correct failure: membership binds to an authenticated
 * user id, so a session with no stable player identity cannot exist. There is no public multiplayer
 * surface, because there is no such thing as an anonymous member of an authoritative session.
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
