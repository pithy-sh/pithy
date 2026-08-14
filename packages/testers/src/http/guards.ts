// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { UnauthorizedError } from "@pithy-sh/core/src/error/pithyError";
import type { MiddlewareHandler } from "hono";

/**
 * Route guards.
 *
 * **The scope constants moved to `./scopes`** (#315). A management client reads them to render what a
 * connection may do, and it reads them in a browser — so they cannot live in a module that imports
 * Hono middleware and `PithyHonoEnv`. The gates stayed here; the names they demand are next door, and
 * the routes import both.
 *
 * `requireAuth` is **copied** rather than imported from `@pithy-sh/auth`, matching every other
 * capability in the repo. Importing a gate from another package would make that package a hard
 * dependency, and a package that borrows its authorization fails *open* when the lender is absent. With
 * the guard local, a project that never installed auth leaves `c.var.auth` null and every guarded route
 * denies — which is the only acceptable direction for that failure to go.
 */

/**
 * Require an authenticated caller. Rejects a request whose `AuthContext` was never filled, which means
 * either no credential or an invalid one.
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
