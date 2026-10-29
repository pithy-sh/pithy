import type { AuthSession, AuthUser } from "@pithy-sh/auth/src/client/api";
import {
  AUTH_UNREACHABLE,
  AUTH_UNREADABLE,
  callAuth,
  signOut as endSession,
  getSession as readSession,
} from "@pithy-sh/auth/src/client/api";
import { createHandoffVerifier, exchangeHandoff, handoffCallbackURL } from "@pithy-sh/auth/src/client/handoff";
import { accountRefusal } from "@pithy-sh/auth/src/client/lifecycle";
import { useRead } from "@pithy-sh/ui-core/src/read";
import { matchPath, type ScreenRole, screenPath } from "@pithy-sh/ui-core/src/routes";
import { CryptoDigestAlgorithm, digest, getRandomBytes } from "expo-crypto";
import { useCallback } from "react";
import { Linking } from "react-native";
import { authConfig, origin, universalLinkOrigin } from "./pithy-config";
import { appLink, onDevice, openExternal, parseQuery, queryString } from "./platform";
import { routeTable, useGo } from "./router";
import { secureStore, transport } from "./transport";

/**
 * Session state, read from the Worker.
 *
 * The transport is `./transport`'s: a bearer credential in the secure store on a phone, the page's httpOnly cookie
 * on the web. The requests themselves live in `@pithy-sh/auth/src/client/api` and `.../bearer`, which upgrade with
 * a minor release; this file decides what the app does with their answers.
 */

/** The signed-in user, as the session route returns them. */
export type SessionUser = AuthUser;

/** A live session, or `null` when nobody is signed in. */
export type Session = AuthSession;

/**
 * The current session, or `null`. On a phone the stored credential is restored first, and reading the session is
 * what tells the bearer session when its credential expires, so it rotates in time.
 *
 * Never throws. A Worker that could not be reached reads as signed out here.
 */
export async function getSession(): Promise<Session> {
  if (!authConfig.enabled) return null;
  await transport.session();
  const result = await readSession(transport.auth);
  return result.ok ? result.value : null;
}

/**
 * Hold the session a sign-in just answered with. On a phone that is the raw `token` in the answer's body, kept in
 * the secure store before this resolves; on the web the Worker already set the cookie. `false` when a phone got an
 * answer with no token in it, which is a sign-in that did not take.
 */
export async function adoptSignIn(answer: unknown): Promise<boolean> {
  if (!transport.bearer) return true;
  const token = typeof answer === "object" && answer !== null ? (answer as { token?: unknown }).token : undefined;
  if (typeof token !== "string" || token === "") return false;
  await transport.adopt(token);
  await readSession(transport.auth);
  return true;
}

/** How a sign-in on a phone ended: the session is held, or the code the Worker refused it with. */
export type SignInOutcome = { ok: true } | { ok: false; code: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Who the provider says signed in, beside the token. Apple puts no name in its identity token and hands the name
 * and address to the app on the first sign-in only, so the Worker learns them from this or never.
 */
export interface IdTokenUser {
  readonly name?: { readonly firstName?: string; readonly lastName?: string };
  readonly email?: string;
}

/**
 * Sign in with an id token a provider's own SDK handed the app: Apple's identity token, or Google's id token
 * for the web client id. The Worker checks the token's audience and answers with the raw session token, which
 * is adopted before this resolves. A phone only: the web signs in through the redirect.
 */
export async function signInWithIdToken(
  provider: "apple" | "google",
  idToken: { token: string; nonce?: string; user?: IdTokenUser },
): Promise<SignInOutcome> {
  const result = await callAuth(
    "/sign-in/social",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider, idToken }) },
    transport.auth,
    isRecord,
  );
  if (!result.ok) return { ok: false, code: result.failure.code };
  return (await adoptSignIn(result.value)) ? { ok: true } : { ok: false, code: AUTH_UNREADABLE.code };
}

/**
 * Where the verifier of a redirect sign-in waits while the system browser has it. The secure store rather than
 * memory, because a magic link is opened from the mail app, and the app may be gone by the time it returns.
 */
export const HANDOFF_VERIFIER_KEY = "pithy.auth.handoff";

/** The code {@link completeHandoff} answers when no sign-in from this device is waiting for a code. */
export const NO_HANDOFF = "client/no_handoff";

/**
 * The link a sign-in in the system browser returns to `path` on: the universal link when `universalLinkOrigin` is
 * set, which only this app can claim, and the app's own scheme otherwise. The Worker's `trustedOrigins` names it.
 */
export function returnLink(path: string): string {
  return universalLinkOrigin === null ? appLink(path) : `${universalLinkOrigin}${path}`;
}

/**
 * Start a redirect sign-in on a phone: make a verifier, keep it, and answer the `callbackURL` that returns to
 * `path` in this app carrying the verifier's challenge. The Worker sends the browser back there with a one-time
 * code instead of a cookie the app could never read. One sign-in waits at a time; starting another replaces it.
 */
export async function beginHandoff(path: string): Promise<string> {
  const { verifier, challenge } = await createHandoffVerifier({
    randomBytes: getRandomBytes,
    // A copy over a fresh `ArrayBuffer`: `BufferSource` takes no view over a `SharedArrayBuffer`.
    sha256: (data) => digest(CryptoDigestAlgorithm.SHA256, new Uint8Array(data)),
  });
  await secureStore.setItem(HANDOFF_VERIFIER_KEY, verifier);
  return handoffCallbackURL(returnLink(path), challenge);
}

/** Forget the waiting verifier: the sign-in it belonged to was abandoned. */
export async function abandonHandoff(): Promise<void> {
  try {
    await secureStore.deleteItem(HANDOFF_VERIFIER_KEY);
  } catch {
    // The next sign-in replaces it, and the Worker spends the code it stood for within a minute anyway.
  }
}

async function trade(code: string): Promise<SignInOutcome> {
  let verifier: string | null;
  try {
    verifier = await secureStore.getItem(HANDOFF_VERIFIER_KEY);
  } catch {
    verifier = null;
  }
  if (verifier === null || verifier === "") return { ok: false, code: NO_HANDOFF };
  const traded = await exchangeHandoff({ code, verifier }, transport.auth);
  // A refused code may be a stray link's, so the verifier waits on for the code its own sign-in returns with.
  if (!traded.ok) return { ok: false, code: traded.failure.code };
  await abandonHandoff();
  return (await adoptSignIn(traded.value)) ? { ok: true } : { ok: false, code: AUTH_UNREADABLE.code };
}

const trades = new Map<string, Promise<SignInOutcome>>();

/**
 * Trade the one-time code a redirect sign-in returned with for the session, and adopt it. The sign-in screen
 * reads the code off the browser's answer and the callback screen reads it off the deep link, and on Android
 * both see the same return: they share one trade per code, because the Worker honors a code once. A trade that
 * never reached the Worker left the code unspent, so it is forgotten and the next call tries again.
 */
export function completeHandoff(code: string): Promise<SignInOutcome> {
  const running = trades.get(code);
  if (running) return running;
  const started = trade(code).then(
    (outcome) => {
      if (!outcome.ok && outcome.code === AUTH_UNREACHABLE.code) trades.delete(code);
      return outcome;
    },
    (error: unknown) => {
      trades.delete(code);
      throw error;
    },
  );
  trades.set(code, started);
  return started;
}

/**
 * The screen for an account that may not act, from the code its refusal carried, or `null` for any other code.
 * The callback and the sign-in screen both route through it, by role.
 */
export function refusedAccountScreen(code: string | null | undefined): ScreenRole | null {
  const refused = accountRefusal(code);
  if (refused === "suspended") return "account-suspended";
  if (refused === "deleted") return "account-deleted";
  return null;
}

/** End the session: the Worker's first, then the credential this device holds. */
export async function signOut(): Promise<void> {
  await endSession(transport.auth);
  await transport.forget();
}

/** {@link signOut}, then the sign-in screen. */
export function useSignOut(): () => Promise<void> {
  const go = useGo();
  return useCallback(async () => {
    await signOut();
    go(screenPath(await routeTable(), "sign-in"));
  }, [go]);
}

/** The session as component state, plus a `refresh` for after a sign-in completes. */
export function useSession(): { session: Session; loading: boolean; refresh: () => void } {
  const read = useRead("session", getSession);
  return { session: read.value ?? null, loading: read.loading, refresh: read.refresh };
}

/** The query parameter a sign-in carries the request it should resume in. */
export const RESUME_PARAM = "resume";

/**
 * `path` when it is a path on the Worker's own origin, or `null`. A rooted path with no second slash or backslash
 * after the first, and no control character: a URL parser drops tab, CR and LF before it reads, so `"/\t/evil.test"`
 * is a protocol-relative URL to it.
 */
function ownPath(path: string): string | null {
  if (!path.startsWith("/")) return null;
  if (path[1] === "/" || path[1] === "\\") return null;
  for (const char of path) {
    const code = char.charCodeAt(0);
    if (code < 0x20 || code === 0x7f || char === "\\") return null;
  }
  return path;
}

/** Where this screen's sign-in should resume, read off its query, or `null`. */
export function resumeTarget(search: string): string | null {
  const path = parseQuery(search)[RESUME_PARAM];
  return path === undefined ? null : ownPath(path);
}

/** `?resume=…` to carry a sign-in's resume target onward, or the empty string. */
export function resumeQuery(search: string): string {
  const target = resumeTarget(search);
  return target === null ? "" : queryString({ [RESUME_PARAM]: target });
}

/**
 * Leave for a page in this tab, on the web. React Native Web's own `Linking.openURL` takes the target as a second
 * argument that React Native's types leave out; `expo-linking` drops it, and a link opened without it is a new
 * tab, which a popup blocker stops once an await has passed.
 */
const pageLinking: { openURL(url: string, target?: string): Promise<unknown> } = Linking;

/** Leave the app for `url` in this tab, on the web: a provider's authorization page, which returns with a cookie. */
export async function leaveInPlace(url: string): Promise<void> {
  await pageLinking.openURL(url, "_self");
}

/** Whether `target` is one of this app's own screens, such as an invitation, rather than a page the Worker serves. */
async function isScreen(target: string): Promise<boolean> {
  const at = target.indexOf("?");
  return matchPath((await routeTable()).patterns, at === -1 ? target : target.slice(0, at)) !== null;
}

/**
 * After a sign-in: go where the query says to resume. `true` when the app is going there.
 *
 * One of this app's own screens, such as the invitation that sent somebody to sign in, is gone to in the app
 * through `go`: pass the screen's `useGo()`. Anything else is the Worker's own page, such as an authorization
 * request: on the web it loads in place, and on a phone it opens in the system browser.
 */
export async function resumeAfterSignIn(search: string, go?: (to: string) => void): Promise<boolean> {
  const target = resumeTarget(search);
  if (target === null) return false;
  if (go && (await isScreen(target))) {
    go(target);
    return true;
  }
  // The system browser holds no session of the app's: the Worker's page signs the person in there itself.
  if (onDevice()) return openExternal(`${origin}${target}`);
  await pageLinking.openURL(target, "_self");
  return true;
}

/**
 * Where a sign-in that took goes next, or `null` when the page is leaving for the Worker's own page in place.
 *
 * One of this app's own screens, such as the invitation that sent somebody to sign in, is that screen, on every
 * platform. The Worker's own page, such as an authorization request, loads in place on the web and opens in the
 * system browser on a phone, where the app goes home beneath it. With nothing to resume, home.
 */
export async function afterSignIn(search: string): Promise<string | null> {
  const target = resumeTarget(search);
  if (target !== null && (await isScreen(target))) return target;
  if ((await resumeAfterSignIn(search)) && !onDevice()) return null;
  return "/";
}
