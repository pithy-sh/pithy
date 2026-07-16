import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { UnauthorizedError } from "@pithy-sh/core/src/error/pithyError";
import type { MiddlewareHandler } from "hono";

/**
 * The media routes' identity gate. Every media route declares the `bearer`/`session` verification
 * strategy; this middleware enforces it through the core `AuthContext` seam (`c.var.auth`), which
 * `@pithy-sh/auth` populates. It never validates a credential itself — it only asserts one resolved,
 * so the media package depends on the seam, not on auth internals. With no auth capability composed,
 * `c.var.auth` is always null and every media route is denied — the correct default.
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
