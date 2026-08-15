// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * The browser half of `@pithy-sh/auth`: the one place that knows how a browser program makes a
 * same-origin, cookie-bearing request to this Worker, and the six calls a scaffolded screen makes.
 *
 * **This module lives in the package for the reason `@pithy-sh/payments`'s counterpart does, only more
 * so.** `pithy ui add` writes the auth screens once and may never rewrite them: they are copied into
 * the adopter's repository and become the adopter's files. Every request written into one of those
 * files is frozen there at the moment `pithy init` ran, and a later fix to the base path, the cookie
 * mode or the failure directions reaches none of them. Six such requests existed — `/get-session`,
 * `/sign-out`, the two OTP routes, the magic link, and the social handoff — each spelling out the same
 * transport by hand. They call this now, and this upgrades with a minor release (#370).
 *
 * **Cookie/session, same origin, and that is enforced rather than assumed.** Every request carries
 * `credentials: "include"` and nothing else: no token in `localStorage` or `sessionStorage`, no
 * `Authorization` header, no refresh rotation. The SPA and its Worker share an origin, so the session
 * rides an httpOnly cookie JavaScript cannot read. Bearer is the mobile path — the same routes serve
 * it, documented rather than scaffolded.
 *
 * **CSRF travels with the cookie mode, and half of it is on this side of the wire.** The server's
 * `requireSameOrigin()` refuses a cookie-authenticated mutating request whose `Origin` does not match;
 * the browser only attaches that header to a request it considers this page's own. So the client half
 * of the rule is that the request never leaves the origin — {@link callAuth} builds its URL from a base
 * path and a relative path and **refuses anything that is not a rooted same-origin path**, rather than
 * handing an ambient session to whatever a mis-set `basePath` names. A caller cannot forget the check,
 * because a caller no longer writes the request.
 *
 * **Nothing here throws.** Not a stylistic choice: this module imports nothing, so `PithyError` is not
 * in reach, and a bare `throw new Error` is exactly what this kit forbids. An unreachable Worker, a
 * proxy's HTML error page, a 500 — each becomes a renderable {@link AuthFailure} on an
 * {@link AuthResult}, and every caller answers one. The Worker is still the security boundary; nothing
 * on this side of the wire protects anything, it only decides what a screen shows.
 *
 * **No absolute URL literals, and no schema library.** Paths are relative, so the calls follow whatever
 * origin the bundle is served from. Answers are narrowed by hand-written `is…(value: unknown): value is
 * T` guards rather than Zod: this file compiles into an adopter's browser bundle, and it must not drag
 * the Worker's schema graph in behind it. `sameOrigin.test.ts` holds the import list to empty, so the
 * property is structural rather than a habit.
 */

/** Where the auth handler mounts by default — the same default `AuthConfig.basePath` carries. */
export const AUTH_BASE_PATH = "/auth";

/**
 * The slice of `fetch` this module uses, declared structurally.
 *
 * Not `typeof fetch`: the package compiles against `@cloudflare/workers-types`, whose `RequestInit` has
 * no `credentials` — and `credentials: "include"` is the entire cookie story. Declaring the shape keeps
 * one signature true in a Worker-typed program, in a browser, and in a test that injects a stub.
 */
export interface AuthRequestInit {
  /** The HTTP method. Absent means GET. */
  method?: string;
  /** Request headers. */
  headers?: Record<string, string>;
  /** The JSON body, already serialized. */
  body?: string;
  /** Cookie policy. Always `include` here — same-origin, httpOnly session cookie. */
  credentials?: "include" | "same-origin" | "omit";
}

/** The slice of `Response` this module reads. */
export interface AuthResponse {
  /** Whether the status was 2xx. */
  ok: boolean;
  /** The HTTP status. */
  status: number;
  /** The parsed body, or a rejection when it was not JSON. */
  json(): Promise<unknown>;
}

/** A fetch this module can call. */
export type AuthFetch = (input: string, init?: AuthRequestInit) => Promise<AuthResponse>;

/**
 * The browser globals this module reaches for, as an injectable seam.
 *
 * Reached through an object rather than `window` because the package compiles in a program with no DOM
 * lib, alongside the Worker code. Injecting it is also what lets a test prove the no-browser path
 * without a DOM.
 */
export interface AuthGlobal {
  /** The browser's fetch. */
  fetch?: AuthFetch;
}

/**
 * What a humanity check contributes to a gated request: the body it wants sent, and any headers.
 *
 * Exactly the shape `@pithy-sh/turnstile`'s scaffolded helper already returns, so a screen hands its
 * check straight in. Absent means no check is composed, which is the common case.
 */
export type AuthGate = (body: Record<string, unknown>) => {
  /** The body to send, with whatever field the check wanted added. */
  body: Record<string, unknown>;
  /** The headers to send, with whatever header the check wanted added. */
  headers: Record<string, string>;
};

/** What every call takes: where the routes are, and the seams a test replaces. */
export interface AuthClientOptions {
  /** Where the auth routes mount. Defaults to {@link AUTH_BASE_PATH}. */
  basePath?: string;
  /** The fetch to use. Defaults to the one on {@link AuthClientOptions.global}. */
  fetch?: AuthFetch;
  /** The global object the default fetch comes off. Defaults to `globalThis`. */
  global?: AuthGlobal;
  /** The humanity check to satisfy, on the two routes that are gated by one. */
  gate?: AuthGate;
}

/** A refusal a screen can render: the namespaced code, the public message, and what to do next. */
export interface AuthFailure {
  /** The namespaced code — `auth/invalid_token`, or a `client/*` sentinel this module minted. */
  code: string;
  /** The public message. The server's `detail` never crosses the HTTP codec, so this is all there is. */
  message: string;
  /** What to do next, when the server offered one. */
  action: string | null;
}

/** Either the value, or a failure to render. Never a throw. */
export type AuthResult<T> = { ok: true; value: T } | { ok: false; failure: AuthFailure };

/** The worker could not be reached at all. Offline, or a DNS failure, or no fetch in this program. */
export const AUTH_UNREACHABLE: AuthFailure = {
  code: "client/unreachable",
  message: "We couldn't reach the server.",
  action: "Check your connection, then try again.",
};

/** The worker answered with something this client cannot read. A proxy's HTML page, or a shape change. */
export const AUTH_UNREADABLE: AuthFailure = {
  code: "client/unreadable",
  message: "The server answered with something we couldn't read.",
  action: "Try again. If it keeps happening, the app and the backend are out of step.",
};

/**
 * The request would have left this origin, so it was never sent.
 *
 * The only way to reach it is a `basePath` or a path that is not a rooted same-origin path — an
 * absolute URL, a protocol-relative `//host`, a backslash form a URL parser reads as one. Sending it
 * would attach an ambient session to a request this page is not entitled to make, which is the thing
 * the cookie mode exists to keep from happening.
 */
export const AUTH_CROSS_ORIGIN: AuthFailure = {
  code: "client/cross_origin",
  message: "That request would have left this site, so it wasn't sent.",
  action: "Check the auth `basePath` in pithy.config.ts — it is a path on this worker, not a URL.",
};

/** Whether a value is a plain record — the first step of every guard below. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether a composed path stays on this origin.
 *
 * A rooted path and nothing that resolves elsewhere. `//host` and `/\host` are the two forms a URL
 * parser reads as an authority rather than as a path, and a browser follows both — which is why the
 * check is on the second character rather than on a scheme it would never find after a leading `/`.
 */
function isSameOriginPath(path: string): boolean {
  if (!path.startsWith("/")) return false;
  const second = path.charAt(1);
  return second !== "/" && second !== "\\";
}

/** A failure read off `{ error: { code, message, action } }`, or the generic one when the body is not that. */
function readFailure(body: unknown): AuthFailure {
  if (!isRecord(body) || !isRecord(body.error)) return AUTH_UNREADABLE;
  const { code, message, action } = body.error;
  if (typeof code !== "string" || typeof message !== "string") return AUTH_UNREADABLE;
  return { code, message, action: typeof action === "string" ? action : null };
}

/**
 * One call: same-origin, cookie-carrying, never throwing. **The only producer of that request.**
 *
 * The body is read before the status is judged, because a refusal's body is the failure a screen
 * renders. A body that will not parse is the generic failure rather than a crash — a corporate proxy's
 * HTML page reaches a browser far more often than anyone expects.
 *
 * **Exported, and that is the point of it.** `@pithy-sh/auth` shipped no browser primitive at all, so
 * six scaffolded screens each wrote the transport out by hand — and those screens are copied into an
 * adopter's repository, where Pithy can never fix them. Every browser program that asks this Worker an
 * auth question calls this, and `sameOrigin.test.ts` fails the build on any module that grows its own
 * (#370).
 *
 * **Zod-free, like everything on this side of the wire.** The answer is narrowed by the hand-written
 * `guard` a caller passes, never by a schema: this compiles into an adopter's browser bundle, and
 * dragging the Worker's schema graph in behind it would break their build rather than ours.
 */
export async function callAuth<T>(
  path: string,
  init: AuthRequestInit,
  options: AuthClientOptions | undefined,
  guard: (value: unknown) => value is T,
): Promise<AuthResult<T>> {
  const base = options?.basePath ?? AUTH_BASE_PATH;
  const url = `${base}${path}`;
  // Before anything else, and before any fetch: the cookie mode below is only safe because this is a
  // request to this Worker. `base` is adopter config; `path` is ours.
  if (!isSameOriginPath(url)) return { ok: false, failure: AUTH_CROSS_ORIGIN };

  const fetcher = options?.fetch ?? (options?.global ?? (globalThis as AuthGlobal)).fetch;
  if (!fetcher) return { ok: false, failure: AUTH_UNREACHABLE };

  let response: AuthResponse;
  try {
    response = await fetcher(url, { ...init, credentials: "include" });
  } catch {
    return { ok: false, failure: AUTH_UNREACHABLE };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    // Success or refusal, an unparseable body says the same thing: whatever answered was not this Worker.
    return { ok: false, failure: AUTH_UNREADABLE };
  }

  if (!response.ok) return { ok: false, failure: readFailure(body) };
  return guard(body) ? { ok: true, value: body } : { ok: false, failure: AUTH_UNREADABLE };
}

/**
 * A JSON POST, with the humanity check's contribution already folded in.
 *
 * The gate is applied here rather than at each call site for the reason the cookie mode is: a screen
 * that forgets it sends an ungated request to a gated route and gets a 403 it cannot explain.
 */
function jsonPost(body: Record<string, unknown>, options: AuthClientOptions | undefined): AuthRequestInit {
  const gated = options?.gate ? options.gate(body) : { body, headers: {} };
  return {
    method: "POST",
    headers: { "content-type": "application/json", ...gated.headers },
    body: JSON.stringify(gated.body),
  };
}

/** The signed-in user, as far as a browser is concerned. */
export interface AuthUser {
  /** The user's id. */
  id: string;
  /** Their email address. */
  email: string;
  /** Their display name, when they have one. */
  name?: string;
}

/** A live session, or `null` when nobody is signed in. */
export type AuthSession = { user: AuthUser } | null;

/**
 * Whether a value is a session envelope, or the explicit "nobody" the route answers with.
 *
 * `null` is a valid answer and a distinct one from a failure — signed out is not the same as unread —
 * so it is narrowed here rather than collapsed into one by a caller.
 */
function isSession(value: unknown): value is AuthSession {
  if (value === null) return true;
  if (!isRecord(value)) return false;
  const user = value.user;
  return isRecord(user) && typeof user.id === "string" && typeof user.email === "string";
}

/** Whether a value is any JSON object. The floor for a route whose success body a screen does not read. */
function isObject(value: unknown): value is Record<string, unknown> {
  return isRecord(value);
}

/**
 * Who is signed in, or `null`.
 *
 * **A failure is not a signed-out session**, and the return type is what keeps the two apart. A screen
 * that renders "signed out" from an unreachable Worker offers a sign-in form to somebody who is
 * already signed in, and the sign-in it starts replaces a live session with a new one. A caller that
 * wants to treat them alike writes `result.ok ? result.value : null` — one line, reading as the
 * decision it is.
 */
export function getSession(options?: AuthClientOptions): Promise<AuthResult<AuthSession>> {
  return callAuth("/get-session", {}, options, isSession);
}

/**
 * End the session server-side.
 *
 * **The content type is not decoration, and the scaffolded screen was missing it.** The route refuses a
 * POST without `application/json` with a 415 — so every app scaffolded so far has been signing nobody
 * out. It went unnoticed because the screen ignored the answer and navigated to `/sign-in` regardless,
 * which looks exactly like a successful sign-out until the back button restores a live session.
 * `clientRoundTrip.test.ts` is what found it, and is what would find it again: a request written into a
 * file Pithy may never rewrite is a request nobody ever tested against the route it names (#370).
 *
 * The body is an empty object rather than nothing, because a declared JSON content type with no body is
 * the other half of the same 415.
 */
export function signOut(options?: AuthClientOptions): Promise<AuthResult<Record<string, unknown>>> {
  // Not `jsonPost`: that folds in the humanity check, and sign-out is not a gated route.
  return callAuth(
    "/sign-out",
    { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    options,
    isObject,
  );
}

/** Sign in with a one-time code the user typed. The answer is the session it created. */
export function signInWithOtp(
  input: { email: string; otp: string },
  options?: AuthClientOptions,
): Promise<AuthResult<Record<string, unknown>>> {
  return callAuth("/sign-in/email-otp", jsonPost({ ...input }, options), options, isObject);
}

/**
 * Mail a one-time code.
 *
 * Gated by the humanity check when one is composed — `options.gate` puts the token where the middleware
 * reads it, and a screen cannot forget to.
 */
export function sendOtp(
  input: { email: string; type: "sign-in" },
  options?: AuthClientOptions,
): Promise<AuthResult<Record<string, unknown>>> {
  return callAuth("/email-otp/send-verification-otp", jsonPost({ ...input }, options), options, isObject);
}

/**
 * Mail a magic link.
 *
 * `callbackURL` is the adopter's own screen, so it is theirs to name. Gated the same way as
 * {@link sendOtp}.
 */
export function sendMagicLink(
  input: { email: string; callbackURL: string },
  options?: AuthClientOptions,
): Promise<AuthResult<Record<string, unknown>>> {
  return callAuth("/sign-in/magic-link", jsonPost({ ...input }, options), options, isObject);
}

/**
 * What asking for a social authorization URL produced. Three outcomes, and a screen must tell them apart.
 *
 * `authorize` is a URL to leave for. `unconfigured` is the provider being switched on in config with a
 * blank credential behind it — the server answers, and the URL it mints names no client. `refused` is
 * our own Worker not answering. Different faults, different copy, and collapsing them would tell a user
 * to try again when the fix is a secret nobody set.
 */
export type SocialSignIn =
  | { kind: "authorize"; url: string }
  | { kind: "unconfigured" }
  | { kind: "refused"; failure: AuthFailure };

/**
 * Whether an answer is an authorization URL a browser may be sent to, and the two reasons it might not be.
 *
 * **The scheme check.** `window.location.href = url` with a `javascript:` URL executes that script in
 * this page, so a response body is not something to hand straight to a navigator however trusted its
 * origin.
 *
 * **The `client_id` check.** An OAuth 2.0 authorization request must carry one, so an authorization URL
 * naming no client is a provider with a blank credential behind it. The client projection carries
 * booleans and never credentials, so a browser cannot know that in advance — refusing the *response* is
 * what turns a blank credential into a sentence on the screen rather than a bounce to Google's own
 * error page.
 */
function isAuthorization(value: unknown): value is { url: string } {
  if (!isRecord(value) || typeof value.url !== "string") return false;
  try {
    const parsed = new URL(value.url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
    return (parsed.searchParams.get("client_id") ?? "") !== "";
  } catch {
    return false;
  }
}

/**
 * Ask for a provider's authorization URL.
 *
 * **No humanity check, deliberately**: the redirect carries no token to check and the provider runs its
 * own bot defense, which is what `@pithy-sh/auth` already assumes when it stacks the check on the
 * magic-link route alone. Gating it would only stop people signing in.
 */
export async function startSocialSignIn(
  input: { provider: string; callbackURL: string },
  options?: AuthClientOptions,
): Promise<SocialSignIn> {
  // The gate is dropped rather than passed through, so a screen holding one client options object for
  // the whole page cannot accidentally gate this route.
  const ungated: AuthClientOptions | undefined = options && { ...options, gate: undefined };
  const result = await callAuth("/sign-in/social", jsonPost({ ...input }, undefined), ungated, isObject);
  if (!result.ok) return { kind: "refused", failure: result.failure };
  return isAuthorization(result.value) ? { kind: "authorize", url: result.value.url } : { kind: "unconfigured" };
}
