// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { MiddlewareHandler } from "hono";
import type { PithyHonoEnv } from "../../capability/capability";
import { UnauthorizedError } from "../../error/pithyError";

/**
 * Require a signed-in user of the app, over the `AuthContext` seam. Kept here rather than imported from
 * `@pithy-sh/auth`, which core may not depend on — and without auth composed `c.var.auth` is null, so the
 * session ticket route denies rather than stands open.
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
