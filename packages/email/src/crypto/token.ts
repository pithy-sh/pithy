// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { EmailInvalidTokenError } from "../error/errors";

/**
 * HMAC-signed callback tokens. Click, open, and unsubscribe links carry one of these so a callback
 * is tamper-proof: the claims (which job, which recipient, where a click goes, which campaign) are
 * signed, and the signature is verified constant-time via `crypto.subtle.verify` before the callback
 * acts. The signing secret is a **rotatable** key from `@pithy-sh/secrets`; every token records the
 * key version (`kid`) it was signed with, so a link in a months-old email still verifies against the
 * retained version set after a rotation — and is rejected once that version is pruned.
 *
 * **A token also names the origin it was minted for (`aud`), and only that origin may act on it (#596).**
 * A link points at the environment that minted it, so nothing about the product needs a staging token to
 * verify on production. The key is per environment, and that alone would keep them apart — for exactly as
 * long as nobody misconfigures one as shared. The claim is what makes that misconfiguration harmless rather
 * than a staging token that 302s through production's domain, records a staging job into production's
 * events, and writes a staging unsubscribe into the suppression list both environments bind, stamped as
 * production's. The key authorizes; the audience says where.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const TokenKind = z
  .enum(["click", "open", "unsubscribe"])
  .describe("Which callback a token authorizes: a tracked link `click`, an open-pixel `open`, or an `unsubscribe`.");
export type TokenKind = z.output<typeof TokenKind>;

/** The signed claims a callback token carries. `kid`/`exp`/`v`/`aud` are set by `mintToken`; the rest are caller claims. */
export const CallbackToken = z
  .object({
    v: z
      .literal(2)
      .describe(
        "Token format version, so the scheme can evolve without ambiguity. `2` added `aud`; a `1` token names no audience and is refused.",
      ),
    kid: z.string().describe("The signing-key version this token was signed with; selects the key to verify against."),
    aud: z
      .string()
      .describe(
        "The origin this token was minted for — the scheme, host and port its links point at. It verifies at that origin and nowhere else.",
      ),
    kind: TokenKind.describe("Which callback this token authorizes."),
    jobId: z.string().describe("The `pithy_email_jobs.id` this token is bound to."),
    recipient: z.string().describe("The recipient address the callback is recorded against."),
    exp: z.number().int().describe("Expiry as a Unix timestamp in seconds; the callback rejects a token past it."),
    destination: z
      .string()
      .optional()
      .describe("For a `click` token, the absolute URL to 302-redirect to after recording."),
    linkLabel: z
      .string()
      .optional()
      .describe("For a `click` token, the link's identity/label, recorded for attribution."),
    campaignId: z.string().optional().describe("The marketing campaign this token is attributed to, when applicable."),
  })
  .describe("The signed claims carried by an email callback token (click/open/unsubscribe).");
export type CallbackToken = z.output<typeof CallbackToken>;

/** The caller-supplied claims for a token — everything except the fields `mintToken` fills in. */
export type TokenClaims = Omit<CallbackToken, "v" | "kid" | "exp" | "aud">;

/**
 * The audience a URL names: its origin, and nothing else.
 *
 * One function for both sides, so a minting side that kept a path or a trailing slash and a verifying side
 * that did not cannot come to two strings for one place. A URL that will not parse is refused as an invalid
 * token rather than thrown as a `TypeError`: on the verifying side it is the request's own URL, and on the
 * minting side it is `BASE_URL`, which the host has already validated as a URL.
 */
export function tokenAudience(url: string): string {
  try {
    return new URL(url).origin;
  } catch (cause) {
    throw new EmailInvalidTokenError({ detail: "token audience is not a URL" }, { cause });
  }
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function importKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

/**
 * Mint a signed token. The claims plus `kid`/`exp`/`v` are JSON-encoded and base64url-packed, then
 * HMAC-SHA-256 signed with `key`. The token is `<payload>.<signature>`; `kid` rides inside the signed
 * payload so the verifier knows which key to check without trusting an unsigned header.
 */
export async function mintToken(
  claims: TokenClaims,
  options: {
    key: string;
    kid: string;
    expiresAt: Date;
    /** Any URL on the origin the links point at — `BASE_URL`. Reduced to its origin by {@link tokenAudience}. */
    audience: string;
  },
): Promise<string> {
  const payload: CallbackToken = {
    ...claims,
    // After the caller's claims, so nothing spread in can overwrite what this function is the authority on.
    v: 2,
    kid: options.kid,
    aud: tokenAudience(options.audience),
    exp: Math.floor(options.expiresAt.getTime() / 1000),
  };
  const payloadB64 = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  const key = await importKey(options.key);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(payloadB64)));
  return `${payloadB64}.${base64UrlEncode(signature)}`;
}

/**
 * Verify a token against the valid signing-key version set (`@pithy-sh/secrets`' `getVersions` shape)
 * and return its claims. Rejects — as `email/invalid_token` — a malformed token, an unknown/pruned
 * `kid`, a bad signature (constant-time via `crypto.subtle.verify`), a token minted for another origin,
 * or an expired token. The order is deliberate: structure, then signature, then audience, then expiry,
 * so a forged token never reaches a claim check.
 *
 * `audience` is **required**, and is the URL the token arrived on — the request's own. A verifier that
 * could omit it would be a verifier that accepts every origin, which is the hole the claim closes.
 *
 * **What the check cannot see:** where the caller got the URL. It compares against the string it is handed,
 * so a caller that passed a value read out of the token, or a header a client controls, would pass every
 * token. `http/callbacks.ts` hands it the request's own URL, and its route test plants a staging token on
 * each route to hold that; a new verifying caller needs the same.
 */
export async function verifyToken(
  token: string,
  keys: { versions: Record<string, string> },
  now: Date,
  audience: string,
): Promise<CallbackToken> {
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new EmailInvalidTokenError({ detail: "token is not in <payload>.<signature> form" });
  }
  const [payloadB64, signatureB64] = parts;

  let raw: unknown;
  try {
    raw = JSON.parse(decoder.decode(base64UrlDecode(payloadB64)));
  } catch (cause) {
    throw new EmailInvalidTokenError({ detail: "token payload is not valid base64url JSON" }, { cause });
  }

  const parsed = CallbackToken.safeParse(raw);
  if (!parsed.success) {
    throw new EmailInvalidTokenError({ detail: "token payload does not match the claim schema" });
  }

  // Look the key up as an OWN property only — a bracket lookup with an attacker-controlled `kid`
  // like `__proto__`/`constructor` would otherwise resolve up the prototype chain to a truthy
  // non-string (Object.prototype / the Object function), pass an `if (!secret)` check, and let
  // `importKey` coerce it to a fixed, attacker-known key string — forging the signature. The
  // own-property + string-type checks close that off.
  const versions = keys.versions;
  const secret = Object.hasOwn(versions, parsed.data.kid) ? versions[parsed.data.kid] : undefined;
  if (typeof secret !== "string") {
    throw new EmailInvalidTokenError({ detail: `token kid '${parsed.data.kid}' is not in the valid key set` });
  }

  const key = await importKey(secret);
  let valid: boolean;
  try {
    valid = await crypto.subtle.verify("HMAC", key, base64UrlDecode(signatureB64), encoder.encode(payloadB64));
  } catch (cause) {
    throw new EmailInvalidTokenError({ detail: "token signature could not be decoded" }, { cause });
  }
  if (!valid) {
    throw new EmailInvalidTokenError({ detail: "token signature did not verify" });
  }

  const expected = tokenAudience(audience);
  if (parsed.data.aud !== expected) {
    throw new EmailInvalidTokenError({
      detail: `token was minted for '${parsed.data.aud}' and presented at '${expected}'`,
    });
  }

  if (parsed.data.exp * 1000 <= now.getTime()) {
    throw new EmailInvalidTokenError({ detail: "token has expired" });
  }

  return parsed.data;
}
