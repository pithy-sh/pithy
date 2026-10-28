import type { AuthSession, AuthUser } from "@pithy-sh/auth/src/client/api";
import { signOut as endSession, getSession as readSession } from "@pithy-sh/auth/src/client/api";
import { accountRefusal } from "@pithy-sh/auth/src/client/lifecycle";
import { useRead } from "@pithy-sh/ui-react/src/read";
import { authConfig } from "./pithy-config";
import { navigate, routeTable, type ScreenRole, screenPath } from "./router";

/**
 * Session state, read from the server.
 *
 * COOKIE/SESSION, NOT BEARER. The SPA is same-origin with its worker, so the session rides an
 * httpOnly cookie: no access token, no refresh token, nothing in localStorage or sessionStorage, and
 * no rotation logic here. JavaScript cannot read the cookie, so XSS has nothing to steal.
 *
 * **The requests themselves are not in this file, and that is deliberate.** Pithy wrote this file once
 * and may never rewrite it — it is yours now — so a `fetch` written here would freeze the base-path
 * join, the cookie mode and the failure handling into your repository on the day you scaffolded. They
 * live in `@pithy-sh/auth/src/client/api`, which is the one place that knows how a browser program
 * asks this worker an auth question, and which upgrades with a minor release. Same-origin and CSRF are
 * its problem, not this screen's.
 */

/** The signed-in user, as the session route returns them. */
export type SessionUser = AuthUser;

/** A live session, or `null` when nobody is signed in. */
export type Session = AuthSession;

/** Where the auth routes are, for every call this file makes. */
const client = { basePath: authConfig.basePath };

/**
 * The current session, or `null`.
 *
 * Never throws. A worker that could not be reached, or answered with something unreadable, reads as
 * signed out here — which is a decision this file makes rather than one the package makes for it. If
 * you would rather show "we couldn't check" than a sign-in form, read `result.failure` instead.
 */
export async function getSession(): Promise<Session> {
  if (!authConfig.enabled) return null;
  const result = await readSession(client);
  return result.ok ? result.value : null;
}

/**
 * The screen for an account that may not act, from the code its refusal carried — or `null` for any other
 * code, which a screen leaves alone.
 *
 * A magic link and a social sign-in come back with the code as `?error=`, and a JSON call carries it as the
 * refusal's `code`. Either way the question is the same, so it is asked here once: the callback and the
 * sign-in screen both route through it, by role, so renaming either destination moves every way there.
 */
export function refusedAccountScreen(code: string | null | undefined): ScreenRole | null {
  const refused = accountRefusal(code);
  if (refused === "suspended") return "account-suspended";
  if (refused === "deleted") return "account-deleted";
  return null;
}

/** End the session server-side and return to the sign-in screen. */
export async function signOut(): Promise<void> {
  await endSession(client);
  // Where "the sign-in screen" is comes from the screen itself, never a literal here.
  navigate(screenPath(await routeTable(), "sign-in"));
}

/** The session as component state, plus a `refresh` for after a sign-in completes. */
export function useSession(): { session: Session; loading: boolean; refresh: () => void } {
  const read = useRead("session", getSession);
  return { session: read.value ?? null, loading: read.loading, refresh: read.refresh };
}

/** The query parameter a sign-in carries the request it should resume in. */
export const RESUME_PARAM = "resume";

/**
 * The path the browser would load for `path`, when that load stays on `origin` — or `null`. It is resolved with the
 * URL parser the browser itself uses rather than inspected by hand: that parser drops tab, CR and LF before it reads,
 * so `"/\t/evil.test"` is a protocol-relative URL to it, and a check on the raw characters would wave it through.
 */
function ownPath(path: string, origin: string): string | null {
  if (!path.startsWith("/")) return null;
  let url: URL;
  try {
    url = new URL(path, origin);
  } catch {
    return null;
  }
  return url.origin === origin ? `${url.pathname}${url.search}${url.hash}` : null;
}

/**
 * Where this screen's sign-in should resume, read off its own URL — or `null`. The consent screen sends somebody to
 * sign in with the authorization request it stopped at, so the sign-in picks up where it left off rather than landing
 * on home. A path on this origin and nothing else, carried in the URL rather than stored anywhere: it is the
 * authorization request the application already made, and the server signs and checks it again on arrival.
 */
export function resumeTarget(
  search: string = window.location.search,
  origin: string = window.location.origin,
): string | null {
  const path = new URLSearchParams(search).get(RESUME_PARAM);
  return path === null ? null : ownPath(path, origin);
}

/** `?resume=…` to carry a sign-in's resume target onward — onto a callback URL — or the empty string. */
export function resumeQuery(search: string = window.location.search): string {
  const target = resumeTarget(search);
  return target === null ? "" : `?${new URLSearchParams({ [RESUME_PARAM]: target })}`;
}

/** After a sign-in: go where the URL says to resume. `true` when the browser is leaving for it. */
export function resumeAfterSignIn(): boolean {
  const target = resumeTarget();
  if (target === null) return false;
  // A document load, because the authorization endpoint is the Worker's, not a screen in this app.
  window.location.assign(target);
  return true;
}
