// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import {
  AUTH_BASE_PATH,
  type AuthClientOptions,
  type AuthResult,
  callAuth,
  isBareOrigin,
  isSameOriginPath,
} from "./api";

/**
 * The native end of a redirect sign-in. Before it starts, the app makes a verifier with
 * {@link createHandoffVerifier} and keeps it in memory, and opens {@link nativeSignInStartURL} in the system
 * browser's sign-in sheet with {@link handoffCallbackURL} as `callbackURL`: its own link carrying the verifier's
 * S256 challenge. That link is best an https universal link (iOS) or app link (Android), which the system opens only
 * in the app that proves it owns the domain; a custom scheme works too for a social sign-in, and any app can claim
 * one. A magic link is handed off only to an https link, because whoever asks for it chooses the challenge and
 * somebody else opens it; without a universal link, sign in by email with a one-time code. The sign-in
 * returns to that link with a one-time `code`, never the session; the app trades the code and the verifier once,
 * within a minute, for the raw session token, and hands that to its bearer session's `adopt`. Another app that
 * catches the link has the code and not the verifier, so it has nothing it can trade.
 */

/** The app-link query parameter the Worker puts the one-time code in. */
export const HANDOFF_CODE_PARAM = "code";

/** The `callbackURL` query parameter the S256 challenge travels in. */
export const HANDOFF_CHALLENGE_PARAM = "handoff_challenge";

/**
 * The two primitives a verifier needs, injected so this module reaches for no platform: on React Native,
 * expo-crypto's `getRandomBytes` and `digest`; on the web, `crypto.getRandomValues` and `crypto.subtle.digest`.
 */
export interface HandoffCrypto {
  /** `length` cryptographically random bytes. */
  randomBytes(length: number): Uint8Array;
  /** The SHA-256 digest of `data`. */
  sha256(data: Uint8Array): Promise<ArrayBuffer>;
}

/** A verifier the app keeps to itself and the challenge it sends with the sign-in. */
export interface HandoffVerifier {
  verifier: string;
  challenge: string;
}

const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Unpadded base64url, written out so it needs neither `btoa` nor `Buffer`. */
function base64Url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += BASE64URL[a >> 2];
    out += BASE64URL[((a & 3) << 4) | ((b ?? 0) >> 4)];
    if (b !== undefined) out += BASE64URL[((b & 15) << 2) | ((c ?? 0) >> 6)];
    if (c !== undefined) out += BASE64URL[c & 63];
  }
  return out;
}

/**
 * Make a fresh verifier and its S256 challenge, as RFC 7636 does: 32 random octets, base64url-encoded, is the
 * verifier; the base64url SHA-256 of the verifier's ASCII is the challenge. Make one per sign-in.
 */
export async function createHandoffVerifier(source: HandoffCrypto): Promise<HandoffVerifier> {
  const verifier = base64Url(source.randomBytes(32));
  const ascii = Uint8Array.from(verifier, (char) => char.charCodeAt(0));
  const challenge = base64Url(new Uint8Array(await source.sha256(ascii)));
  return { verifier, challenge };
}

/** The app's link with the challenge on it: what a native sign-in passes as `callbackURL`. */
export function handoffCallbackURL(deepLink: string, challenge: string): string {
  const separator = deepLink.includes("?") ? "&" : "?";
  return `${deepLink}${separator}${HANDOFF_CHALLENGE_PARAM}=${encodeURIComponent(challenge)}`;
}

/**
 * The address a native app opens in the system browser's sign-in sheet to start a redirect sign-in: the Worker's
 * `GET {basePath}/sign-in/social/start`. Open it with `WebBrowser.openAuthSessionAsync` rather than posting
 * `/sign-in/social` from the app: the provider's state cookie is set on this answer, so it lands in the sheet's jar,
 * and the sheet is what comes back through the provider's callback. `callbackURL` is {@link handoffCallbackURL}'s.
 * Null for an origin that is not a bare http(s) origin, or a `basePath` that would leave it. Built without `URL`,
 * which React Native does not fully implement.
 */
export function nativeSignInStartURL(input: {
  origin: string;
  basePath?: string;
  provider: string;
  callbackURL: string;
  errorCallbackURL?: string;
}): string | null {
  const rooted = `${input.basePath ?? AUTH_BASE_PATH}/sign-in/social/start`;
  if (!isBareOrigin(input.origin) || !isSameOriginPath(rooted)) return null;
  const query = [
    ["provider", input.provider],
    ["callbackURL", input.callbackURL],
    ["errorCallbackURL", input.errorCallbackURL],
  ]
    .filter((pair): pair is [string, string] => pair[1] !== undefined)
    .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
    .join("&");
  return `${input.origin}${rooted}?${query}`;
}

/** What a trade answers: the raw session token and when the session lapses unless rotated first. */
export interface HandoffSession {
  token: string;
  expiresAt: string;
}

/** One query-string component, decoded as `application/x-www-form-urlencoded` does, or null when it is not valid. */
function decodeQueryComponent(raw: string): string | null {
  try {
    return decodeURIComponent(raw.replaceAll("+", " "));
  } catch {
    return null;
  }
}

/**
 * The one-time code on the link the sign-in returned to, a custom-scheme deep link or an https universal link, or
 * null when it carries none. Read from the query string by hand, since React Native's `URL` lacks `searchParams` on
 * some runtimes.
 */
export function handoffCode(link: string): string | null {
  const fragmentStart = link.indexOf("#");
  const beforeFragment = fragmentStart === -1 ? link : link.slice(0, fragmentStart);
  const queryStart = beforeFragment.indexOf("?");
  if (queryStart === -1) return null;
  const query = beforeFragment.slice(queryStart + 1);
  for (const pair of query.split("&")) {
    const equals = pair.indexOf("=");
    if (equals === -1) continue;
    if (decodeQueryComponent(pair.slice(0, equals)) !== HANDOFF_CODE_PARAM) continue;
    const code = decodeQueryComponent(pair.slice(equals + 1));
    return code ? code : null;
  }
  return null;
}

function isHandoffSession(value: unknown): value is HandoffSession {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.token === "string" && record.token.length > 0 && typeof record.expiresAt === "string";
}

/**
 * Trade the code, with the verifier whose challenge started the sign-in, for the session. A spent, expired or
 * unknown code, or a wrong verifier, is refused as `auth/handoff_invalid`, and the remedy is to sign in again.
 * Pass a bearer session's `options`, so the device headers ride along.
 */
export function exchangeHandoff(
  input: { code: string; verifier: string },
  options?: AuthClientOptions,
): Promise<AuthResult<HandoffSession>> {
  return callAuth(
    "/handoff",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: input.code, verifier: input.verifier }),
    },
    options,
    isHandoffSession,
  );
}
