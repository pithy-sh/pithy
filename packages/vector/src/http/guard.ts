import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { UnauthorizedError } from "@pithy-sh/core/src/error/pithyError";
import type { MiddlewareHandler } from "hono";

/**
 * The vector routes' identity gate. Every vector route declares the `bearer`/`session` verification
 * strategy; this middleware enforces it through the core `AuthContext` seam (`c.var.auth`), which
 * `@pithy-sh/auth` populates. It never validates a credential itself — it only asserts one resolved.
 *
 * It is **copied**, not imported from `@pithy-sh/auth`. That is the point: this package's `dependsOn` stays
 * empty, and a project with no auth capability composed leaves `c.var.auth` null, so every vector route is
 * denied. A missing dependency that denies is a safe default; one that opens is not.
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
