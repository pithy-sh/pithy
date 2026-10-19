// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import type { SecretsStoreEnv } from "@pithy-sh/secrets/src/env/bindings";
import type { Context } from "hono";
import type { AuthInstance } from "../instance/auth";
import { resolveSessionSecrets } from "../instance/secrets";
import { priorSessionSecrets } from "../instance/sessionSecrets";

/**
 * **A session signed before a rotation, carried across it (#602).**
 *
 * Better Auth signs the session cookie — and the signed token a bearer client holds — with one secret,
 * `ctx.secret`, which is the first entry of the version set and nothing else (`cookies/index.mjs:172`,
 * `plugins/bearer/index.mjs`). So the moment `auth-session-secret` rotates, every credential issued under
 * the previous version fails verification, and everyone is signed out at once. The overlap the registry
 * declares would protect nothing.
 *
 * This closes that gap in front of Better Auth: before a request reaches it, a credential that fails under
 * the current version and verifies under a **retained** prior one is re-signed under the current version.
 * Better Auth then sees a credential it accepts, and the response carries the re-signed one back — a
 * `Set-Cookie` for a browser, `set-auth-token` for a bearer client — so the next request needs no help.
 *
 * **It extends no trust.** A credential is re-signed only when it verifies under a version this deployment
 * still holds, which is exactly the set Better Auth would accept if it verified signatures by version. The
 * session it names is still looked up, still expired, still revoked by Better Auth as before. And the
 * window closes on its own: once the rotation retires the previous version, nothing verifies under it.
 *
 * **The session's lifetime is the overlap.** A session in use is re-signed on its next request, inside the
 * overlap; one not used for the whole overlap has expired anyway, because `auth-session-secret`'s overlap
 * is declared at least as long as `sessionExpiresIn`, which slides on use.
 */

/** HMAC-SHA256 under `secret`, in standard base64 — the 44 characters better-call writes and checks. */
async function signature(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Constant-time comparison of two strings of equal length; unequal lengths are unequal. */
function sameSignature(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

/** Sign `value` the way better-call's `signCookieValue` does, before its URL encoding: `value.signature`. */
export async function signCredential(value: string, secret: string): Promise<string> {
  return `${value}.${await signature(value, secret)}`;
}

/**
 * Which of `keys` a signed credential verifies under, by index, and the value it signs — or `null` when it
 * is not a signed credential or verifies under none. Takes the decoded form, `value.signature`.
 */
export async function verifyCredential(
  signed: string,
  keys: readonly string[],
): Promise<{ value: string; key: number } | null> {
  const dot = signed.lastIndexOf(".");
  if (dot < 1) return null;
  const value = signed.slice(0, dot);
  const presented = signed.slice(dot + 1);
  if (presented.length !== 44 || !presented.endsWith("=")) return null;
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index] as string;
    if (sameSignature(await signature(value, key), presented)) return { value, key: index };
  }
  return null;
}

/** `decodeURIComponent`, answering the input itself when it is not valid percent-encoding. */
function decoded(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * Re-sign under `current` whichever of a credential's two forms was signed under a key in `prior`.
 *
 * Takes the decoded credential and answers the re-signed one, or `null` when it verifies under the current
 * key already, under no key at all, or is not a signed credential.
 */
async function carried(signed: string, keys: { current: string; prior: readonly string[] }): Promise<string | null> {
  const verified = await verifyCredential(signed, [keys.current, ...keys.prior]);
  if (verified === null || verified.key === 0) return null;
  return await signCredential(verified.value, keys.current);
}

/** What was re-signed: the request's new headers, each re-signed cookie, and the re-signed bearer credential. */
export interface ResignedCredentials {
  /** The request headers with every re-signed credential in place of the one that arrived. */
  headers: Headers;
  /** Each cookie re-signed, by name, with its new value in decoded form. */
  cookies: { name: string; value: string }[];
  /** The bearer credential re-signed, in decoded form, when one was. */
  bearer?: string;
}

/**
 * Re-sign every credential in `headers` that verifies under a prior key: the cookies named in `names`, and
 * a signed bearer token. Answers `null` when nothing needed it — including always when there is no prior
 * key, so a deployment that has never rotated parses nothing.
 */
export async function resignCredentials(
  headers: Headers,
  keys: { current: string; prior: readonly string[] },
  names: readonly string[],
): Promise<ResignedCredentials | null> {
  if (keys.prior.length === 0) return null;
  const cookies: { name: string; value: string }[] = [];
  let bearer: string | undefined;

  const header = headers.get("cookie");
  let cookieHeader = header;
  if (header !== null) {
    const parts = header.split(";").map((part) => part.trim());
    const rewritten = await Promise.all(
      parts.map(async (part) => {
        const equals = part.indexOf("=");
        if (equals < 1) return part;
        const name = part.slice(0, equals);
        if (!names.includes(name)) return part;
        const fresh = await carried(decoded(part.slice(equals + 1)), keys);
        if (fresh === null) return part;
        cookies.push({ name, value: fresh });
        return `${name}=${encodeURIComponent(fresh)}`;
      }),
    );
    cookieHeader = rewritten.join("; ");
  }

  const authorization = headers.get("authorization");
  let authorizationHeader = authorization;
  if (authorization !== null && authorization.slice(0, 7).toLowerCase() === "bearer ") {
    const token = decoded(authorization.slice(7).trim());
    // A raw token carries no signature to carry: Better Auth signs one itself, under the current version.
    const fresh = token.includes(".") ? await carried(token, keys) : null;
    if (fresh !== null) {
      bearer = fresh;
      authorizationHeader = `Bearer ${fresh}`;
    }
  }

  if (cookies.length === 0 && bearer === undefined) return null;
  const next = new Headers(headers);
  if (cookieHeader !== null) next.set("cookie", cookieHeader);
  if (authorizationHeader !== null) next.set("authorization", authorizationHeader);
  return { headers: next, cookies, ...(bearer === undefined ? {} : { bearer }) };
}

/** A cookie's attributes as Better Auth states them on `authCookies.<name>.attributes`. */
interface CookieAttributes {
  path?: string;
  domain?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: string;
  partitioned?: boolean;
}

/** One `Set-Cookie` value, with the attributes Better Auth itself would have written. */
function setCookie(name: string, value: string, attributes: CookieAttributes, maxAge: number | undefined): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (maxAge !== undefined) parts.push(`Max-Age=${Math.floor(maxAge)}`);
  if (attributes.domain) parts.push(`Domain=${attributes.domain}`);
  parts.push(`Path=${attributes.path ?? "/"}`);
  if (attributes.httpOnly) parts.push("HttpOnly");
  if (attributes.secure || attributes.partitioned) parts.push("Secure");
  if (attributes.sameSite) {
    parts.push(`SameSite=${attributes.sameSite.charAt(0).toUpperCase()}${attributes.sameSite.slice(1).toLowerCase()}`);
  }
  if (attributes.partitioned) parts.push("Partitioned");
  return parts.join("; ");
}

/**
 * The credentials this request needs re-signed, with the instance context their cookies are written from —
 * or `null` when there is no prior version, or nothing to re-sign.
 */
async function resignedFor(c: Context<PithyHonoEnv>, instance: AuthInstance) {
  const versions = await resolveSessionSecrets(c.env as unknown as SecretsStoreEnv);
  const current = versions.versions[versions.currentVersion];
  const prior = priorSessionSecrets(versions);
  if (current === undefined || prior.length === 0) return null;
  const context = await instance.$context;
  const names = [context.authCookies.sessionToken.name, context.authCookies.dontRememberToken.name];
  const resigned = await resignCredentials(c.req.raw.headers, { current, prior }, names);
  return resigned === null ? null : { resigned, context };
}

/**
 * Carry this request's credentials across a rotation, then run the rest of the chain, then hand the
 * re-signed credentials back on the response.
 *
 * Swaps `c.req.raw` for a request carrying the re-signed credentials, so the session middleware, the auth
 * handler and every route that reads the request see one consistent set. A response that already sets the
 * cookie — a sign-out, a refresh — keeps its own; this only fills the silence.
 */
export async function withResignedCredentials(
  c: Context<PithyHonoEnv>,
  instance: AuthInstance,
  next: () => Promise<void>,
): Promise<void> {
  // A failure to read the version set is not this function's to raise: the request goes on with the
  // credential it arrived with, and Better Auth answers it exactly as it would have.
  const prepared = await resignedFor(c, instance).catch(() => null);
  if (prepared === null) return await next();
  const { resigned, context } = prepared;
  const session = context.authCookies.sessionToken;
  const dontRemember = context.authCookies.dontRememberToken;

  c.req.raw = new Request(c.req.raw, { headers: resigned.headers });
  await next();

  const response = new Response(c.res.body, c.res);
  const setting = response.headers.getSetCookie().map((line) => line.slice(0, line.indexOf("=")));
  // A remembered session's cookie lasts the session's lifetime; a "don't remember me" one ends with the
  // browser, which is what the companion cookie's presence says. Either way it is what Better Auth writes.
  const remembered = !(resigned.headers.get("cookie") ?? "")
    .split(";")
    .some((part) => part.trim().startsWith(`${dontRemember.name}=`));
  for (const cookie of resigned.cookies) {
    if (setting.includes(cookie.name)) continue;
    const isSession = cookie.name === session.name;
    const attributes = (isSession ? session.attributes : dontRemember.attributes) as CookieAttributes;
    response.headers.append(
      "set-cookie",
      setCookie(
        cookie.name,
        cookie.value,
        attributes,
        isSession && remembered ? context.sessionConfig.expiresIn : undefined,
      ),
    );
  }
  if (resigned.bearer !== undefined && !response.headers.has("set-auth-token")) {
    response.headers.set("set-auth-token", encodeURIComponent(resigned.bearer));
    const exposed = new Set(
      (response.headers.get("access-control-expose-headers") ?? "")
        .split(",")
        .map((header) => header.trim())
        .filter(Boolean),
    );
    exposed.add("set-auth-token");
    response.headers.set("access-control-expose-headers", [...exposed].join(", "));
  }
  c.res = response;
}
