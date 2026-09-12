// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * **Changing which providers can sign you in requires a recent authentication.** Both directions.
 *
 * Attaching one grants permanent access — after it a sign-in resolves by account id and the email stops
 * mattering — and it is what `allowDifferentEmails: true` widened: before that, a provider could only be
 * linked to an account holding the same address, so a link was self-limiting. Detaching one is the
 * smaller decision, but `allowUnlinkingAll: true` means an attacker inside the window can strip *every*
 * provider from an account. Neither belongs behind a credential whose age nobody checked.
 *
 * **Better Auth guards the two unevenly, and neither guard is one the kit can use.** In
 * `better-auth/dist/api/routes/account.mjs`, `/link-social` takes `use: [sessionMiddleware]` — any
 * session, any age — while `/unlink-account` takes `use: [freshSessionMiddleware]`, which reads
 * `session.createdAt` against a `freshAge` defaulting to 24 hours. So the more powerful operation was
 * the cheaper-guarded one, and the guarded one was checked against a value `/token/rotate` resets:
 * `internal-adapter.mjs:275` stamps `createdAt` after the caller's override, so a row's `created_at` is
 * the moment of its most recent rotation. Ordinary refreshing resets it; so does anyone holding a stolen
 * refresh token.
 *
 * **It reads `authenticatedAt`, not the session's `createdAt`, and that distinction is the whole of #558.**
 * The first version of this gate read session age. `/token/rotate` stamps a successor's `createdAt` with
 * the moment of the call, so session age is reset by every rotation — ordinary on the bearer path, and
 * available on demand to anyone holding a stolen refresh token. Two requests and the gate was open. The
 * question it means to ask is how recently the *person* authenticated, which is a different fact, stamped
 * once at sign-in and carried across rotations verbatim.
 *
 * **Not a Better Auth hook, and that is a framework constraint rather than a preference.** A `before` hook
 * runs ahead of the endpoint's own `sessionMiddleware`, so `ctx.context.session` is null at hook time; and
 * `runBeforeHooks` accumulates each hook's context changes and applies them only after *every* hook, so
 * `bearer()`'s rewrite of `Authorization` into the session cookie never reaches a sibling hook either. A
 * hook therefore cannot resolve a mobile caller's session at all, and a gate that cannot read a session
 * refuses everyone — indistinguishable from the feature being broken, which invites deleting the gate.
 *
 * Provider-agnostic on purpose. Google and Apple are trusted providers, which makes them *more* exposed
 * to this, not less: the question is how recently the caller proved they hold the account.
 */

import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { PithyError, UnauthorizedError } from "@pithy-sh/core/src/error/pithyError";
import type { MiddlewareHandler } from "hono";
import type { ProviderChange } from "../audit/emit";
import { emitProviderChangeNotFresh } from "../audit/emit";

/**
 * How recently the caller must have authenticated to change which providers sign them in: **fifteen minutes.**
 *
 * Stated rather than inherited. Better Auth's `freshAge` default is 24 hours, which is the wrong order of
 * magnitude here — a day-old authentication is not evidence that the person at the keyboard holds the
 * account, and the whole exposure is a credential valid for days. Fifteen minutes covers an OAuth round
 * trip that involves signing in to the provider first, and is short enough that a stolen credential is
 * unlikely to still be inside the window.
 *
 * **One number for both operations.** Asymmetry is arguable — linking grants access and unlinking
 * removes it — but the argument cuts both ways once `allowUnlinkingAll` is on, and a second constant
 * would be a second thing to keep true. The cost of being wrong in either direction is one
 * re-authentication.
 */
export const PROVIDER_CHANGE_FRESH_AGE_SECONDS = 15 * 60;

/**
 * Whether an authentication is recent enough to authorize attaching a provider.
 *
 * **Fails closed on anything it cannot read.** An absent, unparseable or future timestamp is not evidence
 * of a recent authentication — it is the absence of evidence — and a gate that reads "I cannot tell" as
 * "fresh" is one a row written before the column walks straight through. The future case matters as much
 * as the past: a window checked on one side only would pass any future value forever.
 */
export function authenticationIsFresh(authenticatedAt: Date | string | null | undefined, now: Date): boolean {
  if (authenticatedAt === null || authenticatedAt === undefined) return false;
  const at = authenticatedAt instanceof Date ? authenticatedAt : new Date(authenticatedAt);
  const millis = at.getTime();
  if (Number.isNaN(millis)) return false;
  const age = (now.getTime() - millis) / 1000;
  if (age < 0) return false;
  return age <= PROVIDER_CHANGE_FRESH_AGE_SECONDS;
}

/**
 * The gate, as Hono middleware on the kit's own route tree.
 *
 * **A pure read of `c.var.auth`.** `createSessionMiddleware` has already resolved this request's
 * credential — core registers every capability's middleware before any capability's routes — so resolving
 * it again would be a second D1 round trip for a fact the seam is holding. That is the argument
 * `AuthContext` already makes for `locale`.
 *
 * **No credential at all is 401, not this 403.** `auth/session_not_fresh` means "signed in, but not
 * recently enough"; a caller holding nothing cannot tell that from "not signed in" and will not know
 * whether to re-authenticate or to retry. The refusal is `requireAuth()`'s, word for word, so the two
 * surfaces answer an absent credential identically.
 *
 * **Recorded before the throw**, like `emitProviderUnavailable`: one refusal is somebody who left a tab
 * open, and a run of them against one user id is the incident. The trail has to hold it whether or not
 * anything logs the refusal.
 */
/**
 * The refusal for attaching a provider without having authenticated recently.
 *
 * **Not `auth/forbidden`.** A client has to render this differently from every other 403, because the
 * remedy is specific and cheap — sign in again, then retry — and a generic "you are not allowed" sends
 * somebody to ask for a permission they already hold. `http/linkFreshness.ts` carries the argument for
 * the gate itself.
 *
 * `message` says nothing was changed, because the caller is mid-flow and cannot otherwise tell whether
 * the link half-happened.
 */
export function sessionNotFresh(): PithyError {
  return new PithyError({
    code: "auth/session_not_fresh",
    status: 403,
    message: "Sign in again to change your connected accounts. Nothing was changed.",
    action:
      "A deliberate gate: changing which providers can sign somebody in requires a recent authentication, in both directions. See `http/providerFreshness.ts`.",
    detail: "session authenticatedAt is older than PROVIDER_CHANGE_FRESH_AGE_SECONDS, absent, or unreadable",
  });
}

/**
 * Which direction is being refused. Carried into the audit row, because "somebody tried to attach an
 * identity on a stale credential" and "somebody tried to strip one" are different things to read later.
 */
export function requireFreshAuthentication(
  change: ProviderChange,
  now: () => Date = () => new Date(),
): MiddlewareHandler<PithyHonoEnv> {
  return async (c, next) => {
    const auth = c.var.auth;
    if (!auth) {
      throw new UnauthorizedError({
        message: "Authentication required.",
        action: "Sign in and retry with a valid session or bearer token.",
      });
    }
    if (!authenticationIsFresh(auth.authenticatedAt, now())) {
      await emitProviderChangeNotFresh(c.var.emit, {
        change,
        userId: auth.userId,
        sessionId: auth.sessionId,
        headers: c.req.raw.headers,
      });
      throw sessionNotFresh();
    }
    await next();
  };
}
