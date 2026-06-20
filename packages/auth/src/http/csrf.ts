import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { ForbiddenError } from "@pithy-sh/core/src/error/pithyError";
import type { MiddlewareHandler } from "hono";

/**
 * CSRF origin guard for Pithy's own state-changing auth routes (token rotation, device revoke).
 *
 * Better Auth applies this check to its own endpoints, but our custom routes sit in front of the
 * catch-all and must enforce it themselves to honor principle 2 ("cookie/session mode ⇒ CSRF on").
 * Bearer requests carry no ambient credential, so they are CSRF-exempt and pass through. A
 * cookie-authenticated request must present an `Origin` (or `Referer`) that matches an allowed origin.
 */
function originOf(value: string | null): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export function requireSameOrigin(allowedOrigins: readonly string[]): MiddlewareHandler<PithyHonoEnv> {
  const allowed = new Set(allowedOrigins);
  return async (c, next) => {
    // A bearer request has no ambient credential to forge — CSRF-exempt.
    if (c.req.raw.headers.has("authorization")) {
      await next();
      return;
    }
    const origin = c.req.raw.headers.get("origin") ?? originOf(c.req.raw.headers.get("referer"));
    if (!origin || !allowed.has(origin)) {
      throw new ForbiddenError({
        message: "Cross-origin request rejected.",
        action: "Send the request from an allowed origin, or use a bearer token.",
        detail: `origin ${origin ?? "(none)"} is not in trustedOrigins`,
      });
    }
    await next();
  };
}

/** The origins a cookie-authenticated mutating request may come from: the base URL plus trustedOrigins. */
export function allowedOrigins(baseURL: string, trustedOrigins: readonly string[]): string[] {
  const origins = new Set<string>(trustedOrigins);
  const base = originOf(baseURL);
  if (base) origins.add(base);
  return [...origins];
}
