// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PithyHonoEnv, PithyMiddleware } from "@pithy-sh/core/src/capability/capability";
import { UnauthorizedError } from "@pithy-sh/core/src/error/pithyError";
import { AuthContext } from "@pithy-sh/core/src/http/authContext";
import { isLocale } from "@pithy-sh/core/src/i18n/locale";
import type { Context, MiddlewareHandler } from "hono";
import type { AuthWiring, ScopeResolver, ScopeResolverSession } from "../capability";
import type { AuthInstance } from "../instance/auth";
import { withResignedCredentials } from "./credentialResign";
import { getAuthInstance } from "./resolve";

/**
 * The session-resolution middleware: it fills core's `AuthContext` seam (`c.var.auth`) for every
 * request that carries a credential — a bearer token or a session cookie. Better Auth resolves both
 * transparently (the bearer plugin rewrites the header into the session cookie), so one `getSession`
 * call covers mobile and web. A credential-less request stays anonymous (no instance build, no D1 hit).
 * Resolution never throws — an invalid credential simply leaves `auth` null for `requireAuth` to reject.
 */
/** The session's authentication instant when it is a real `Date`, else `null`. Never anything else. */
function authenticatedDate(session: unknown): Date | null {
  const value = (session as { authenticatedAt?: unknown }).authenticatedAt;
  return value instanceof Date ? value : null;
}

/**
 * The scopes this request's caller resolves to — what the adopter's resolver answered, or `[]`.
 *
 * **Closed on every failure, and never fatal** (#560). A resolver that throws or rejects, and one that answers
 * something other than a list of strings, both leave the request with no scopes and a warning: a gate then
 * refuses it as it would any untrusted caller, rather than the request becoming a 500 or — worse — a
 * malformed answer reaching a guard that would read `includes` off a string. Validated through
 * `AuthContext`'s own field, so this and the context the middleware publishes cannot disagree on the shape.
 *
 * The warning names the session and never the answer: whatever the resolver handed back is the adopter's,
 * and a log is not where to learn what a caller was trusted with.
 */
async function resolvedScopes(
  c: Context<PithyHonoEnv>,
  resolve: ScopeResolver | undefined,
  session: ScopeResolverSession,
): Promise<string[]> {
  if (resolve === undefined) return [];
  let answer: unknown;
  try {
    answer = await resolve(c, session);
  } catch (error) {
    c.var.log.child("auth").warn("resolveScopes failed; this request carries no scopes", {
      sessionId: session.sessionId,
      reason: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
  const parsed = AuthContext.shape.scopes.safeParse(answer);
  if (!parsed.success || answer === undefined) {
    c.var.log
      .child("auth")
      .warn("resolveScopes answered something that is not a list of strings; this request carries no scopes", {
        sessionId: session.sessionId,
      });
    return [];
  }
  return parsed.data;
}

export function createSessionMiddleware(wiring: AuthWiring): PithyMiddleware {
  return (app) => {
    app.use("*", async (c, next) => {
      if (!c.req.raw.headers.has("authorization") && !c.req.raw.headers.has("cookie")) return await next();
      // A credential signed under a session secret this deployment has since rotated is re-signed under the
      // current one before anything reads it (#602), and the re-signed one rides back on the response. A
      // failure building the instance is not this middleware's to raise, so it is left to the routes.
      let instance: AuthInstance | undefined;
      try {
        instance = await getAuthInstance(c, wiring);
      } catch {
        instance = undefined;
      }
      if (instance === undefined) return await next();
      const built = instance;
      await withResignedCredentials(c, built, async () => {
        await resolveSession(c, wiring, built);
        await next();
      });
    });
  };
}

/** Fill `c.var.auth` from the request's credential, or leave it null. Never throws. */
async function resolveSession(c: Context<PithyHonoEnv>, wiring: AuthWiring, instance: AuthInstance): Promise<void> {
  const headers = c.req.raw.headers;
  try {
    const session = await instance.api.getSession({ headers });
    if (session) {
      // Before the context is built, so a resolver sees the request exactly as it arrived and the
      // context is published once, whole. Per request and never cached: the answer is about this
      // request's caller, and a cached one is a revocation that has not taken effect (#560).
      const scopes = await resolvedScopes(c, wiring.resolveScopes, {
        userId: session.user.id,
        sessionId: session.session.id,
      });
      // `locale` comes off the user row the session lookup already loaded, so publishing it
      // costs nothing — and it is the `user` link of `@pithy-sh/i18n`'s server chain, the one
      // that makes a reader's stored choice outrank their device's `Accept-Language`. Read
      // through `AuthContext.parse`, so a column holding something that is not a tag lands as
      // `undefined` rather than reaching `Intl`.
      const stored = (session.user as { locale?: unknown }).locale;
      c.set(
        "auth",
        AuthContext.parse({
          userId: session.user.id,
          sessionId: session.session.id,
          scopes,
          locale: typeof stored === "string" && isLocale(stored) ? stored : null,
          // Published for the same reason `locale` is: the session lookup has already loaded the
          // row, so a gate that needs it should not pay for a second read. The adapter hands back
          // a `Date`; a session predating the column hands back null, which reads as "cannot say".
          // Guarded like `locale` beside it, and for a worse failure: `z.date()` throws on a
          // string, the catch below swallows it, and every authenticated request in the Worker
          // becomes anonymous — a total outage presenting as "everyone is logged out".
          authenticatedAt: authenticatedDate(session.session),
        }),
      );
    }
  } catch {
    // Leave `auth` null; the credential was missing/invalid.
  }
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
