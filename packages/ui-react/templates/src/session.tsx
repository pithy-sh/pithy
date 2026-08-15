import type { AuthSession, AuthUser } from "@pithy-sh/auth/src/client/api";
import { signOut as endSession, getSession as readSession } from "@pithy-sh/auth/src/client/api";
import { useCallback, useEffect, useRef, useState } from "react";
import { authConfig } from "./pithy-config";
import { navigate } from "./router";

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

/** End the session server-side and return to the sign-in screen. */
export async function signOut(): Promise<void> {
  await endSession(client);
  navigate("/sign-in");
}

/** The session as component state, plus a `refresh` for after a sign-in completes. */
export function useSession(): { session: Session; loading: boolean; refresh: () => void } {
  const [current, setCurrent] = useState<Session>(null);
  const [loading, setLoading] = useState(true);
  // Guards against setting state after unmount. A ref rather than a local, because `refresh` is
  // callable from an event handler long after the effect that created it has been cleaned up.
  const live = useRef(true);

  const refresh = useCallback(() => {
    setLoading(true);
    void getSession().then((value) => {
      if (!live.current) return;
      setCurrent(value);
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    live.current = true;
    refresh();
    return () => {
      live.current = false;
    };
  }, [refresh]);

  return { session: current, loading, refresh };
}
