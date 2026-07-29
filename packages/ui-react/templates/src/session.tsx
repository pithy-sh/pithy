import { useCallback, useEffect, useRef, useState } from "react";
import { authConfig } from "./pithy-config";
import { navigate } from "./router";

/**
 * Session state, read from the server.
 *
 * COOKIE/SESSION, NOT BEARER. The SPA is same-origin with its worker, so the session rides an
 * httpOnly cookie: no access token, no refresh token, nothing in localStorage or sessionStorage, and
 * no rotation logic here. JavaScript cannot read the cookie, so XSS has nothing to steal. Every
 * request below carries `credentials: "include"`, and the server's same-origin check covers CSRF.
 */

/** The signed-in user, as `GET ${authConfig.basePath}/get-session` returns it. */
export interface SessionUser {
  id: string;
  email: string;
  name?: string;
}

/** A live session, or `null` when nobody is signed in. */
export type Session = { user: SessionUser } | null;

function isSession(value: unknown): value is { user: SessionUser } {
  const user = (value as { user?: { id?: unknown; email?: unknown } } | null)?.user;
  return typeof user?.id === "string" && typeof user.email === "string";
}

/** The current session, or `null`. Never throws — an unreachable worker reads as signed out. */
export async function getSession(): Promise<Session> {
  if (!authConfig.enabled) return null;
  try {
    const response = await fetch(`${authConfig.basePath}/get-session`, { credentials: "include" });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    return isSession(body) ? body : null;
  } catch {
    return null;
  }
}

/** End the session server-side and return to the sign-in screen. */
export async function signOut(): Promise<void> {
  await fetch(`${authConfig.basePath}/sign-out`, { method: "POST", credentials: "include" });
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
