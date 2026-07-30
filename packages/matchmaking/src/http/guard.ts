// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { UnauthorizedError } from "@pithy-sh/core/src/error/pithyError";
import type { MiddlewareHandler } from "hono";

/**
 * Route guard over the `AuthContext` seam. Copied — not imported from `@pithy-sh/auth` — so matchmaking
 * keeps `dependsOn` empty: without auth installed, `c.var.auth` is null and every guarded route is denied
 * rather than open (the leaderboard/multiplayer pattern). Membership everywhere binds to
 * `c.var.auth.userId`, never a client-supplied id.
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
