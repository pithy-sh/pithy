// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PithyHonoEnv, PithyMiddleware } from "@pithy-sh/core/src/capability/capability";
import { InternalError, type PithyError, UnauthorizedError } from "@pithy-sh/core/src/error/pithyError";
import { AuthContext } from "@pithy-sh/core/src/http/authContext";
import { isLocale } from "@pithy-sh/core/src/i18n/locale";
import type { Context, MiddlewareHandler } from "hono";
import type { AuthWiring, ScopeResolver, ScopeResolverSession } from "../capability";
import { authDatabase } from "../data/tables";
import type { AuthInstance } from "../instance/auth";
import { lifecycleRefusalFor, noteRefusal, noticedRefusal } from "../lifecycle/enforce";
import { LifecycleColumns } from "../lifecycle/state";
import { withResignedCredentials } from "./credentialResign";
import { getAuthInstance, resolveDb } from "./resolve";

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
      // **A suspended or deleted account gets no `AuthContext` at all** (#620). Read off the user Better
      // Auth just loaded, which carries the four columns, so an account in good standing costs nothing
      // here. Leaving `auth` null is what makes every `requireAuth()` in the kit refuse it — the copies
      // other capabilities carry included, since each one only asks whether `auth` was filled. This
      // capability's own guard raises the refusal itself, with its code; see `requireAuth` below.
      const refusal = await standingRefusal(c, wiring, session.user);
      if (refusal) {
        noteRefusal(c, refusal);
        return;
      }
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
 * The refusal for the session's account, or `null` when it may act.
 *
 * **A check that cannot be made refuses**, rather than throwing into `resolveSession`'s catch. That catch
 * leaves `auth` null and notes nothing, and `handleBetterAuth` only refuses on a noted verdict — so a failed
 * read of a suspension's reason, or a column that will not decode, would let Better Auth's own `/token` mint a
 * JWT for the suspended account it resolved on its own. So the failure is logged and becomes the verdict: a
 * 500, since the fault is this Worker's, and every door that honors a lifecycle refusal honors this one.
 */
async function standingRefusal(
  c: Context<PithyHonoEnv>,
  wiring: AuthWiring,
  user: { id: string },
): Promise<PithyError | null> {
  try {
    return await lifecycleRefusalFor(
      authDatabase(resolveDb(c.env, wiring.config.database)),
      user.id,
      LifecycleColumns.parse(user),
      new Date(),
    );
  } catch (cause) {
    // Optional, unlike the logger elsewhere here: this branch is the refusal, and a missing logger must not
    // turn it back into the throw it exists to replace.
    c.var.log?.child("auth").warn("the account's standing could not be checked; the request is refused", {
      userId: user.id,
      reason: cause instanceof Error ? cause.message : String(cause),
    });
    return new InternalError(
      {
        message: "This account could not be checked. Try again shortly.",
        action: "Check the auth database binding and that the auth migrations have run.",
        detail: `lifecycle check for user ${user.id} failed`,
      },
      { cause },
    );
  }
}

/**
 * The gate other capabilities stack on a protected route. Rejects a request whose `AuthContext` was
 * not filled (no valid credential) with a `PithyError` `auth/invalid_token` (401).
 *
 * **A genuine credential for an account that may not act is refused with what happened to it** —
 * `auth/account_suspended` or `auth/account_deleted`, 403 — rather than the 401, because signing in again
 * cannot help and a client that read it as an expired token would loop. The verdict is the session
 * middleware's, remembered for this request; this guard only raises it.
 */
export function requireAuth(): MiddlewareHandler<PithyHonoEnv> {
  return async (c, next) => {
    if (!c.var.auth) {
      const refusal = noticedRefusal(c);
      if (refusal) throw refusal;
      throw new UnauthorizedError({
        message: "Authentication required.",
        action: "Sign in and retry with a valid session or bearer token.",
      });
    }
    await next();
  };
}
