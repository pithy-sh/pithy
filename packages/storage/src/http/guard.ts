import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { UnauthorizedError } from "@pithy-sh/core/src/error/pithyError";
import type { MiddlewareHandler } from "hono";

/**
 * The storage routes' identity gate.
 *
 * **Copied, not imported.** This is deliberately a local copy of the same three lines
 * `@pithy-sh/media` and `@pithy-sh/ledger` each carry, rather than an import from `@pithy-sh/auth`.
 * Importing it would make auth a hard dependency of storage, and a hard dependency is the wrong
 * shape twice over: storage works perfectly well for system-owned objects with no auth capability
 * composed, and — far more importantly — a package that *imports* its authorization from another
 * package fails open when that package is absent. Depending on the core `AuthContext` seam instead
 * means `c.var.auth` is simply `null` with no auth capability composed, and every owner-scoped
 * route **denies**. Failing closed is not a side effect here; it is the reason for the copy.
 *
 * So `dependsOn` stays free of auth and the manifest lists it under `optionalCapabilities`.
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
