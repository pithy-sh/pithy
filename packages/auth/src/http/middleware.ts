import type { PithyHonoEnv, PithyMiddleware } from "@pithy-sh/core/src/capability/capability";
import { UnauthorizedError } from "@pithy-sh/core/src/error/pithyError";
import { AuthContext } from "@pithy-sh/core/src/http/authContext";
import type { MiddlewareHandler } from "hono";
import type { AuthWiring } from "../capability";
import { getAuthInstance } from "./resolve";

/**
 * The session-resolution middleware: it fills core's `AuthContext` seam (`c.var.auth`) for every
 * request that carries a credential — a bearer token or a session cookie. Better Auth resolves both
 * transparently (the bearer plugin rewrites the header into the session cookie), so one `getSession`
 * call covers mobile and web. A credential-less request stays anonymous (no instance build, no D1 hit).
 * Resolution never throws — an invalid credential simply leaves `auth` null for `requireAuth` to reject.
 */
export function createSessionMiddleware(wiring: AuthWiring): PithyMiddleware {
  return (app) => {
    app.use("*", async (c, next) => {
      const headers = c.req.raw.headers;
      if (headers.has("authorization") || headers.has("cookie")) {
        try {
          const instance = await getAuthInstance(c, wiring);
          const session = await instance.api.getSession({ headers });
          if (session) {
            c.set("auth", AuthContext.parse({ userId: session.user.id, sessionId: session.session.id, scopes: [] }));
          }
        } catch {
          // Leave `auth` null; the credential was missing/invalid.
        }
      }
      await next();
    });
  };
}

/**
 * The gate other capabilities stack on a protected route. Rejects a request whose `AuthContext` was
 * not filled (no valid credential) with a `PithyError` `auth/invalid_token` (401).
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
