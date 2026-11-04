// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { EmailInvalidTokenError } from "../error/errors";

/**
 * Sealed callback tokens. Click, open, and unsubscribe links carry one of these, and a link is written to every
 * request log between a mail client and the Worker: Cloudflare's, Workers observability and tail, a mail scanner, a
 * proxy. So a token says nothing to anyone who holds it. Its claims (which job, which recipient, where a click goes,
 * which campaign) are sealed with AES-256-GCM, which both hides them and makes them tamper-proof: a changed byte
 * fails the tag, and nothing is acted on before the tag verifies.
 *
 * Each token's sealing key is derived with HKDF-SHA256 from one version of the **rotatable** link-signing key in
 * `@pithy-sh/secrets`, under the label {@link SEAL_LABEL} and a random salt the token carries. One secret, one
 * rotation, and a fresh key per token, so no volume of mail brings two tokens near a shared key and IV. Every token names the key version
 * (`kid`) it was sealed under, so a link in a months-old email still opens against the retained version set after a
 * rotation, and is rejected once that version is pruned.
 *
 * A token also names the origin it was minted for (`aud`), and only that origin may act on it. A link points at the
 * environment that minted it, and the key is per environment; the claim keeps a key misconfigured as shared from
 * letting a staging token act on production's routes.
 *
 * ## Two formats on read, one on write
 *
 * - **`3.<kid>.<sealed>`**, minted by {@link mintToken}: `kid` base64url, `sealed` the 16-byte salt, the 12-byte
 *   IV, then the ciphertext and tag, base64url. The kid is bound as authenticated data, so a token moved to another
 *   version fails.
 * - **`<payload>.<signature>`**, the signed format before it: base64url JSON with `v: 2` and an HMAC-SHA-256
 *   signature. Its payload decodes on sight, recipient included, so nothing mints it. It is still read, because
 *   mail already sent carries it, and it is accepted only until its own `exp`: `LINK_TTL_DAYS` from when it was
 *   sent, 90 days by default. The last one expires that long after the first deploy that stopped minting them,
 *   and the reader can be deleted then.
 */

/** The HKDF label a sealing key is derived under. Versioned, so a change to the format is a change of key. */
export const SEAL_LABEL = "pithy/email/link-seal/3";

/** The first segment of a sealed token: its format version. */
const SEALED_PREFIX = "3";

/** The 16-byte HKDF salt, fresh for every token, so every token is sealed under its own key. */
const SALT_BYTES = 16;

/** The 12-byte AES-GCM initialization vector, fresh for every token. */
const IV_BYTES = 12;

/** The longest key version a token may name. A real one is a short stringified integer. */
const MAX_KID_LENGTH = 64;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const TokenKind = z
  .enum(["click", "open", "unsubscribe"])
  .describe("Which callback a token authorizes: a tracked link `click`, an open-pixel `open`, or an `unsubscribe`.");
export type TokenKind = z.output<typeof TokenKind>;

/** The claims every token carries, sealed or signed. */
const claimFields = {
  kid: z
    .string()
    .describe("The link-signing key version this token was minted under; selects the key to open it with."),
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
};

/** The claims a callback token carries. `kid`/`exp`/`v`/`aud` are set by `mintToken`; the rest are caller claims. */
export const CallbackToken = z
  .object({
    v: z
      .literal(3)
      .describe(
        "Token format version. `3` is sealed with AES-256-GCM; `2`, the signed format, is read and never minted.",
      ),
    ...claimFields,
  })
  .describe("The sealed claims carried by an email callback token (click/open/unsubscribe).");
export type CallbackToken = z.output<typeof CallbackToken>;

/** The claims of a token in the signed format, which is read until its links expire and never minted. */
const SignedCallbackToken = z
  .object({
    v: z.literal(2).describe("The signed format. `1` named no audience and is refused."),
    ...claimFields,
  })
  .describe("The signed, unsealed claims of a callback token minted before tokens were sealed.");

/** The claims a verified token hands back, whichever format it arrived in. */
export type VerifiedCallbackToken = Omit<CallbackToken, "v"> & { v: 2 | 3 };

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

function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new EmailInvalidTokenError({ detail: "token segment is not base64url" });
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** The authenticated data a sealed token binds: its format and its key version. */
function sealedContext(kid: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(encoder.encode(`${SEAL_LABEL}:${kid}`));
}

/** The AES-256-GCM key for one token: HKDF-SHA256 over a link-signing key version, its salt and {@link SEAL_LABEL}. */
async function sealingKey(
  secret: string,
  salt: Uint8Array<ArrayBuffer>,
  usage: "encrypt" | "decrypt",
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", Uint8Array.from(encoder.encode(secret)), "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: Uint8Array.from(encoder.encode(SEAL_LABEL)) },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    [usage],
  );
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
}

/**
 * The secret for `kid`, or a refusal. An own property only: a bracket lookup with an attacker-controlled `kid` like
 * `__proto__` or `constructor` would resolve up the prototype chain to a truthy non-string, which the key import would
 * coerce to a fixed string an attacker knows.
 */
function secretFor(keys: { versions: Record<string, string> }, kid: string): string {
  const secret = Object.hasOwn(keys.versions, kid) ? keys.versions[kid] : undefined;
  if (typeof secret !== "string") {
    // The kid is a stranger's string: bounded before it reaches a log line.
    throw new EmailInvalidTokenError({
      detail: `token kid '${kid.slice(0, 16).replace(/[^\x20-\x7e]/g, "?")}' is not in the valid key set`,
    });
  }
  return secret;
}

/**
 * Mint a sealed token: the claims plus `v`/`kid`/`aud`/`exp`, JSON-encoded and sealed with AES-256-GCM under the key
 * derived from `key`. Nothing in the result decodes to a claim.
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
    v: 3,
    kid: options.kid,
    aud: tokenAudience(options.audience),
    exp: Math.floor(options.expiresAt.getTime() / 1000),
  };
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await sealingKey(options.key, salt, "encrypt");
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: sealedContext(options.kid) },
      key,
      Uint8Array.from(encoder.encode(JSON.stringify(payload))),
    ),
  );
  const sealed = new Uint8Array(SALT_BYTES + IV_BYTES + ciphertext.length);
  sealed.set(salt, 0);
  sealed.set(iv, SALT_BYTES);
  sealed.set(ciphertext, SALT_BYTES + IV_BYTES);
  return `${SEALED_PREFIX}.${base64UrlEncode(encoder.encode(options.kid))}.${base64UrlEncode(sealed)}`;
}

/** Open a `3.<kid>.<sealed>` token, or refuse it. */
async function openSealed(
  kidB64: string,
  sealedB64: string,
  keys: { versions: Record<string, string> },
): Promise<VerifiedCallbackToken> {
  let kid: string;
  let sealed: Uint8Array<ArrayBuffer>;
  try {
    kid = decoder.decode(base64UrlDecode(kidB64));
    sealed = base64UrlDecode(sealedB64);
  } catch (cause) {
    throw new EmailInvalidTokenError({ detail: "token segments are not base64url" }, { cause });
  }
  if (kid.length === 0 || kid.length > MAX_KID_LENGTH) {
    throw new EmailInvalidTokenError({ detail: "token kid is empty or too long" });
  }
  if (sealed.length <= SALT_BYTES + IV_BYTES) throw new EmailInvalidTokenError({ detail: "sealed token is too short" });
  const key = await sealingKey(secretFor(keys, kid), sealed.slice(0, SALT_BYTES), "decrypt");
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: sealed.slice(SALT_BYTES, SALT_BYTES + IV_BYTES), additionalData: sealedContext(kid) },
      key,
      sealed.slice(SALT_BYTES + IV_BYTES),
    );
  } catch (cause) {
    throw new EmailInvalidTokenError({ detail: "sealed token did not open" }, { cause });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(decoder.decode(plaintext));
  } catch (cause) {
    throw new EmailInvalidTokenError({ detail: "sealed token payload is not JSON" }, { cause });
  }
  const parsed = CallbackToken.safeParse(raw);
  // The tag covered the kid as authenticated data; the copy inside must agree with it.
  if (!parsed.success || parsed.data.kid !== kid) {
    throw new EmailInvalidTokenError({ detail: "token payload does not match the claim schema" });
  }
  return parsed.data;
}

/** Verify a `<payload>.<signature>` token in the signed format, or refuse it. */
async function openSigned(
  payloadB64: string,
  signatureB64: string,
  keys: { versions: Record<string, string> },
): Promise<VerifiedCallbackToken> {
  let raw: unknown;
  try {
    raw = JSON.parse(decoder.decode(base64UrlDecode(payloadB64)));
  } catch (cause) {
    throw new EmailInvalidTokenError({ detail: "token payload is not valid base64url JSON" }, { cause });
  }
  const parsed = SignedCallbackToken.safeParse(raw);
  if (!parsed.success) {
    throw new EmailInvalidTokenError({ detail: "token payload does not match the claim schema" });
  }
  const key = await hmacKey(secretFor(keys, parsed.data.kid));
  let valid: boolean;
  try {
    valid = await crypto.subtle.verify("HMAC", key, base64UrlDecode(signatureB64), encoder.encode(payloadB64));
  } catch (cause) {
    throw new EmailInvalidTokenError({ detail: "token signature could not be decoded" }, { cause });
  }
  if (!valid) {
    throw new EmailInvalidTokenError({ detail: "token signature did not verify" });
  }
  return parsed.data;
}

/**
 * Verify a token against the valid key version set (`@pithy-sh/secrets`' `getVersions` shape) and return its claims.
 * Rejects — as `email/invalid_token` — a malformed token, an unknown or pruned `kid`, a token whose seal or signature
 * does not verify, a token minted for another origin, or an expired token. The order is deliberate: structure, then
 * the cryptographic check, then audience, then expiry, so a forged token never reaches a claim check.
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
): Promise<VerifiedCallbackToken> {
  const parts = token.split(".");
  let claims: VerifiedCallbackToken;
  if (parts.length === 3 && parts[0] === SEALED_PREFIX && parts[1] && parts[2]) {
    claims = await openSealed(parts[1], parts[2], keys);
  } else if (parts.length === 2 && parts[0] && parts[1]) {
    claims = await openSigned(parts[0], parts[1], keys);
  } else {
    throw new EmailInvalidTokenError({ detail: "token is not in a callback token form" });
  }

  const expected = tokenAudience(audience);
  if (claims.aud !== expected) {
    throw new EmailInvalidTokenError({
      detail: `token was minted for '${claims.aud}' and presented at '${expected}'`,
    });
  }

  if (claims.exp * 1000 <= now.getTime()) {
    throw new EmailInvalidTokenError({ detail: "token has expired" });
  }

  return claims;
}
