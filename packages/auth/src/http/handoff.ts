// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import {
  ForbiddenError,
  InternalError,
  NotFoundError,
  PithyError,
  ValidationError,
} from "@pithy-sh/core/src/error/pithyError";
import type { Context } from "hono";
import { correlation, emitHandoffExchanged, emitHandoffIssued } from "../audit/emit";
import type { AuthWiring } from "../capability";
import { Session } from "../data/betterAuth";
import { authDatabase } from "../data/tables";
import { parseDeviceMeta, registerDevice } from "../device/registry";
import type { AuthInstance } from "../instance/auth";
import { isHandoffChallenge, issueHandoff, redeemHandoff } from "../token/handoff";
import { guardErrorCallbackURL } from "./errorCallbackUrl";
import { apiErrorToPithy } from "./errors";
import { getAuthInstance, resolveDb } from "./resolve";
import type { HandoffExchangeResponse } from "./responses";
import type { HandoffExchangeBody, SocialSignInStartQuery } from "./schemas";

/**
 * The redirect half of a native sign-in, and the trade that ends it.
 *
 * A native app starts a social sign-in with its own deep link as `callbackURL` (a scheme in `trustedOrigins`,
 * such as `myapp://auth/callback`). Better Auth checks that URL when the sign-in starts and, at the provider's
 * callback, answers with a redirect to it carrying the session as a cookie. A cookie set on a redirect to an app
 * scheme lands in the system browser, which the app never reads. {@link handOffToApp} replaces that answer: the
 * session cookies are dropped and the deep link carries a one-time code instead (`../token/handoff.ts`). The app
 * posts the code to `POST {base}/handoff`, {@link exchangeHandoff}, and gets the raw session token back.
 *
 * The code is bound to the app that asked for it. The app puts the S256 challenge of a verifier only it holds on
 * its `callbackURL` as `handoff_challenge`, Better Auth keeps that URL with the sign-in's state, and the challenge
 * comes back here on the redirect. It is moved off the link and stored with the code, and the trade must present
 * the verifier. A deep link with no challenge gets no code at all.
 *
 * Which redirects are handed off: any whose link carries `handoff_challenge`, whatever its scheme, and any to a
 * non-http(s) scheme. So an app's https universal link (iOS) or app link (Android), which the operating system
 * routes only to the app that proves it owns the domain, gets a code when the app asks for one with a challenge.
 * An http(s) callback with no challenge is a web page, and a web page gets its cookie.
 *
 * A magic link is handed off only to an https link. Whoever asks for the link chooses the challenge, and the
 * person who opens it is somebody else, so the code must reach only the app that owns the link's domain. Any app
 * can claim a custom scheme; a magic link to one is refused, and a native app without a universal link signs in
 * by email with a one-time code instead.
 *
 * A native app starts a redirect sign-in with {@link startNativeSignIn}, a GET the system browser's sign-in sheet
 * opens, rather than by posting `/sign-in/social` itself. Better Auth binds the sign-in to a signed `state`
 * cookie and checks it at the provider's callback; set on the app's own request, that cookie would never reach
 * the sheet that completes the callback.
 */

/** The deep-link query parameter the one-time code travels in. */
export const HANDOFF_CODE_PARAM = "code";

/** The `callbackURL` query parameter the app's S256 challenge travels in. */
export const HANDOFF_CHALLENGE_PARAM = "handoff_challenge";

/** The `error` a deep link gets back when it carried no challenge to bind a code to. */
export const HANDOFF_UNBOUND_ERROR = "handoff_challenge_required";

/** The `error` a magic link to a custom scheme gets back: only an https universal link or app link is handed one. */
export const HANDOFF_SCHEME_REFUSED_ERROR = "handoff_scheme_refused";

/** Better Auth's magic-link verification, under `basePath`: the one redirect that ends an emailed sign-in. */
const MAGIC_LINK_VERIFY_PATH = "/magic-link/verify";

type Ctx = Context<PithyHonoEnv>;

/** The cookie lines a response sets, as name and value. */
function setCookies(response: Response): { line: string; name: string; value: string }[] {
  return response.headers.getSetCookie().map((line) => {
    const pair = line.slice(0, line.indexOf(";") === -1 ? line.length : line.indexOf(";"));
    const equals = pair.indexOf("=");
    return { line, name: pair.slice(0, equals).trim(), value: pair.slice(equals + 1).trim() };
  });
}

/** The raw session token inside a signed session cookie: everything before the signature. */
function rawToken(cookieValue: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(cookieValue);
  } catch {
    return null;
  }
  const token = decoded.split(".")[0];
  return token ? token : null;
}

/**
 * The app link a redirect points at, or null when it points anywhere a browser should go: a custom-scheme deep link,
 * or an http(s) link that asked for a handoff by carrying a challenge.
 */
function appLink(response: Response): URL | null {
  if (response.status < 300 || response.status >= 400) return null;
  const location = response.headers.get("location");
  if (!location) return null;
  let target: URL;
  try {
    target = new URL(location);
  } catch {
    return null;
  }
  const web = target.protocol === "http:" || target.protocol === "https:";
  return web && !target.searchParams.has(HANDOFF_CHALLENGE_PARAM) ? null : target;
}

/** The `trustedOrigins` entry that would admit a link: its origin for http(s), its scheme otherwise. */
function trustedEntry(target: URL): string {
  return target.protocol === "http:" || target.protocol === "https:" ? target.origin : `${target.protocol}//`;
}

/**
 * Rewrite a sign-in that ends on an app link into a handoff, or answer null and leave the response as Better Auth
 * wrote it: any answer that is not a redirect to an app link, and a redirect that sets no session (a refused
 * sign-in returning its error to the app).
 *
 * An app link outside `trustedOrigins` is refused rather than followed. Better Auth checked the callback when the
 * sign-in started, so reaching that branch means something else wrote the redirect, and a session must never be
 * handed to a scheme this Worker does not trust.
 */
export async function handOffToApp(
  c: Ctx,
  wiring: AuthWiring,
  instance: AuthInstance,
  response: Response,
): Promise<Response | null> {
  const target = appLink(response);
  if (!target) return null;
  const context = await instance.$context;
  // Every cookie that carries the session or what was read alongside it. Better Auth splits a cookie cache too
  // large for one cookie into `<name>.0`, `<name>.1`, …, so each chunk goes with its name.
  const sessionCookieNames = [
    context.authCookies.sessionToken.name,
    context.authCookies.sessionData.name,
    context.authCookies.dontRememberToken.name,
    context.authCookies.accountData.name,
  ];
  const isSessionCookie = (name: string) =>
    sessionCookieNames.some((cookie) => name === cookie || name.startsWith(`${cookie}.`));
  const cookies = setCookies(response);
  const session = cookies.find((cookie) => cookie.name === context.authCookies.sessionToken.name && cookie.value);
  if (!session) return null;
  if (!context.isTrustedOrigin(target.href, { allowRelativePaths: false })) {
    // The session the redirect made is reachable by nothing once its cookie is dropped, so it goes too.
    const token = rawToken(session.value);
    if (token) {
      await authDatabase(resolveDb(c.env, wiring.config.database))
        .deleteFrom("pithyAuthSessions")
        .where("token", "=", token)
        .execute();
    }
    throw new ForbiddenError({
      message: "That app link is not one this service trusts.",
      action: `Add the app's link to auth's \`trustedOrigins\`, for example "${trustedEntry(target)}".`,
      detail: `sign-in redirect to untrusted app link ${trustedEntry(target)}`,
    });
  }
  const token = rawToken(session.value);
  if (!token) return null;
  const db = authDatabase(resolveDb(c.env, wiring.config.database));
  const row = await db
    .selectFrom("pithyAuthSessions")
    .select(["id", "userId"])
    .where("token", "=", token)
    .executeTakeFirst();
  if (!row) return null;

  const challenge = target.searchParams.get(HANDOFF_CHALLENGE_PARAM);
  target.searchParams.delete(HANDOFF_CHALLENGE_PARAM);
  const emailed = new URL(c.req.raw.url).pathname === `${wiring.config.basePath}${MAGIC_LINK_VERIFY_PATH}`;
  const refusal =
    emailed && target.protocol !== "https:"
      ? HANDOFF_SCHEME_REFUSED_ERROR
      : challenge !== null && isHandoffChallenge(challenge)
        ? null
        : HANDOFF_UNBOUND_ERROR;
  if (refusal === null && challenge !== null) {
    const { code } = await issueHandoff(db, { sessionId: row.id, challenge, now: new Date() });
    target.searchParams.set(HANDOFF_CODE_PARAM, code);
  } else {
    // No code. The session the callback made is reachable by nothing once its cookie is dropped, so it goes too,
    // and the app hears why on its own link.
    await db.deleteFrom("pithyAuthSessions").where("id", "=", row.id).execute();
    target.searchParams.set("error", refusal ?? HANDOFF_UNBOUND_ERROR);
  }

  const headers = new Headers(response.headers);
  headers.delete("set-cookie");
  headers.delete("set-auth-token");
  headers.set("location", target.href);
  headers.set("cache-control", "no-store");
  headers.set("referrer-policy", "no-referrer");
  for (const cookie of cookies) {
    if (!isSessionCookie(cookie.name)) headers.append("set-cookie", cookie.line);
  }
  await emitHandoffIssued(c.var.emit, {
    ...(refusal === null
      ? { outcome: "success" as const }
      : { outcome: "denied" as const, reason: refusal === HANDOFF_SCHEME_REFUSED_ERROR ? "scheme" : "unbound" }),
    userId: row.userId,
    sessionId: row.id,
    ...correlation(c.req.raw.headers),
  });
  return new Response(null, { status: response.status, headers });
}

/**
 * Start a native redirect sign-in inside the system browser's sign-in sheet: run the social sign-in here and
 * answer a redirect to the provider that carries Better Auth's `Set-Cookie`, so the signed `state` cookie lands in
 * the jar of the browser that will come back through the provider's callback.
 *
 * Only for the handoff: the callback must be a link `trustedOrigins` admits, carrying a well-formed
 * `handoff_challenge`, and a navigation another page started (`Sec-Fetch-Site` other than `none`) is refused. A web page starts its sign-in with the JSON `POST /sign-in/social`, as it always has.
 * The sign-in runs on a request of its own with the sheet's cookies, origin and fetch metadata left behind:
 * nothing the sheet already holds takes part in it.
 */
export async function startNativeSignIn(c: Ctx, wiring: AuthWiring, query: SocialSignInStartQuery): Promise<Response> {
  // The sheet opens this address itself, so its navigation is `none`. A page that sent the browser here chose the
  // challenge, and the code would go to whichever app claims the link.
  const site = c.req.raw.headers.get("sec-fetch-site");
  if (site !== null && site !== "none") {
    throw new ForbiddenError({
      message: "Start a sign-in from the app.",
      action: "Open the start address in the system browser's sign-in sheet, not from a link on a page.",
      detail: `native sign-in start reached from ${site}`,
    });
  }
  if (!wiring.config[query.provider].enabled) {
    throw new NotFoundError({
      message: "That sign-in provider is not available here.",
      action: `Enable \`${query.provider}\` in auth's config, or stop offering it.`,
      detail: `native sign-in start for disabled provider ${query.provider}`,
    });
  }
  const instance = await getAuthInstance(c, wiring);
  const context = await instance.$context;
  for (const [field, value] of [
    ["callbackURL", query.callbackURL],
    ["errorCallbackURL", query.errorCallbackURL],
  ] as const) {
    if (value !== undefined && !context.isTrustedOrigin(value, { allowRelativePaths: false })) {
      throw new ForbiddenError({
        message: "That app link is not one this service trusts.",
        action: "Add the app's link to auth's `trustedOrigins`.",
        detail: `native sign-in start with untrusted ${field}`,
      });
    }
  }
  let challenge: string | null;
  try {
    challenge = new URL(query.callbackURL).searchParams.get(HANDOFF_CHALLENGE_PARAM);
  } catch {
    challenge = null;
  }
  if (challenge === null || !isHandoffChallenge(challenge)) {
    throw new ValidationError({
      message: "That sign-in link has no handoff challenge.",
      action: "Start a native sign-in with `handoffCallbackURL` from `@pithy-sh/auth/src/client/handoff`.",
      detail: "native sign-in start without a well-formed handoff challenge",
      issues: [{ path: ["callbackURL"], message: `carries no well-formed ${HANDOFF_CHALLENGE_PARAM}`, code: "custom" }],
    });
  }

  const headers = new Headers(c.req.raw.headers);
  for (const name of [...headers.keys()]) {
    if (name === "cookie" || name === "origin" || name === "referer" || name.startsWith("sec-fetch-")) {
      headers.delete(name);
    }
  }
  headers.delete("content-length");
  headers.set("content-type", "application/json");
  const signIn = new Request(new URL(`${wiring.config.basePath}/sign-in/social`, c.req.raw.url), {
    method: "POST",
    headers,
    body: JSON.stringify({
      provider: query.provider,
      callbackURL: query.callbackURL,
      ...(query.errorCallbackURL === undefined ? {} : { errorCallbackURL: query.errorCallbackURL }),
    }),
  });
  let answer: Response;
  try {
    answer = await instance.handler(await guardErrorCallbackURL(signIn, signIn.url));
  } catch (error) {
    throw apiErrorToPithy(error);
  }
  // Better Auth's own refusal is its own answer, as it is on the catch-all.
  if (!answer.ok) return answer;
  const body: unknown = await answer.json();
  const url = typeof body === "object" && body !== null ? (body as { url?: unknown }).url : undefined;
  if (typeof url !== "string") {
    throw new InternalError({ detail: "the social sign-in answered without an authorization URL" });
  }
  const redirect = new Headers({ location: url, "cache-control": "no-store", "referrer-policy": "no-referrer" });
  for (const line of answer.headers.getSetCookie()) redirect.append("set-cookie", line);
  return new Response(null, { status: 302, headers: redirect });
}

/** The refusal every failed trade gets. One answer for spent, expired, unknown and a wrong verifier. */
function handoffInvalid(reason: string): PithyError {
  return new PithyError({
    code: "auth/handoff_invalid",
    status: 400,
    message: "That sign-in link has expired or was already used. Sign in again.",
    detail: `handoff refused: ${reason}`,
  });
}

/**
 * Trade a one-time code and its verifier for the session the code stands for. The code is spent by the attempt
 * whatever the answer, so a wrong verifier gets one guess.
 * Device headers sent with the trade register the device and bind it to the session, as they would on any other
 * native sign-in; the browser that completed the redirect had none to send.
 */
export async function exchangeHandoff(c: Ctx, wiring: AuthWiring, body: HandoffExchangeBody): Promise<Response> {
  const db = authDatabase(resolveDb(c.env, wiring.config.database));
  const corr = correlation(c.req.raw.headers);
  const now = new Date();
  const redemption = await redeemHandoff(db, { code: body.code, verifier: body.verifier }, now);
  if (!redemption.ok) {
    await emitHandoffExchanged(c.var.emit, { outcome: "denied", reason: redemption.reason, ...corr });
    throw handoffInvalid(redemption.reason);
  }
  const row = await db
    .selectFrom("pithyAuthSessions")
    .select(["id", "token", "userId", "expiresAt", "deviceId"])
    .where("id", "=", redemption.sessionId)
    .executeTakeFirst();
  const expiresAt = row ? Session.shape.expiresAt.parse(row.expiresAt) : null;
  if (!row || !expiresAt || expiresAt.getTime() <= now.getTime()) {
    await emitHandoffExchanged(c.var.emit, { outcome: "denied", reason: "unknown", ...corr });
    throw handoffInvalid("the session the code stood for has ended");
  }

  const device = parseDeviceMeta(c.req.raw.headers);
  if (device && !row.deviceId) {
    await registerDevice(db, device, { userId: row.userId, lastIp: corr.ip ?? null, now });
    await db.updateTable("pithyAuthSessions").set({ deviceId: device.id }).where("id", "=", row.id).execute();
  }

  await emitHandoffExchanged(c.var.emit, { outcome: "success", userId: row.userId, sessionId: row.id, ...corr });
  c.header("cache-control", "no-store");
  return c.json({ token: row.token, expiresAt: expiresAt.toISOString() } satisfies HandoffExchangeResponse);
}
