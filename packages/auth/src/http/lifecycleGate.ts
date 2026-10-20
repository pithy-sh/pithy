// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PithyError } from "@pithy-sh/core/src/error/pithyError";

/**
 * Where a suspended or deleted account meets Better Auth's own endpoints (#620).
 *
 * The session middleware refuses such an account an `AuthContext`, which closes every kit route. Better Auth's
 * catch-all is the one place that does not ask: it resolves the session itself, so `/token` would mint a fresh
 * access token for an account the rest of the Worker refuses. `handleBetterAuth` therefore refuses the
 * middleware's verdict here too — everywhere except the endpoints below.
 */

/**
 * The endpoints that never act as the account the presented credential names, relative to `basePath`.
 *
 * Signing out must always work. And each of the rest *starts* a session rather than using one, so a stale
 * cookie a suspended person left on a shared machine must not stop somebody else signing in — the session
 * that results is checked where it is created, in `session.create.before`. Everything else is refused by
 * default: an endpoint nobody listed may be one a plugin added, and an account that may not act may not act
 * there either.
 */
const ADMITTED_PREFIXES = [
  "/sign-out",
  "/sign-in/",
  "/magic-link/verify",
  "/email-otp/",
  "/callback/",
  "/oauth2/callback/",
] as const;
const ADMITTED_EXACT = new Set(["/jwks", "/ok", "/error"]);

/** Whether a refused account's credential may still reach this Better Auth endpoint (path relative to `basePath`). */
export function admitsRefusedAccount(path: string): boolean {
  if (ADMITTED_EXACT.has(path)) return true;
  return ADMITTED_PREFIXES.some((prefix) => path === prefix || path.startsWith(prefix));
}

/**
 * The redirect a refused magic link answers with: back to the screen the link named, carrying the code as
 * `?error=`, exactly as Better Auth's own `redirectWithError` does for the refusals it raises itself
 * (`plugins/magic-link/index.mjs`). `null` when the target is not one this Worker trusts, and the caller
 * answers the refusal as JSON instead.
 *
 * A browser following a magic link is mid-navigation, so a 403 body would strand it on the API's origin
 * with nothing to read; the adopter's screen is where the copy for this state lives. Better Auth has already
 * checked the URLs by the time a session is refused, so the trust check is defense in depth — a refusal must
 * not become an open redirect.
 */
export function lifecycleRedirect(
  requestUrl: URL,
  baseURL: string,
  trustedOrigins: readonly string[],
  refusal: PithyError,
): Response | null {
  const named = requestUrl.searchParams.get("errorCallbackURL") || requestUrl.searchParams.get("callbackURL") || "/";
  let target: URL;
  try {
    target = new URL(named, baseURL);
  } catch {
    return null;
  }
  const trusted = new Set([new URL(baseURL).origin, ...trustedOrigins.flatMap((origin) => originOf(origin))]);
  if (!trusted.has(target.origin)) return null;
  target.searchParams.set("error", refusal.payload.code);
  return new Response(null, { status: 302, headers: { location: target.toString() } });
}

/** An origin's canonical form, or nothing for an entry that is not a URL (a bare deep-link scheme). */
function originOf(value: string): string[] {
  try {
    const origin = new URL(value).origin;
    return origin === "null" ? [] : [origin];
  } catch {
    return [];
  }
}
