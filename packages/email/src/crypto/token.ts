import { z } from "zod";
import { EmailInvalidTokenError } from "../error/errors";

/**
 * HMAC-signed callback tokens. Click, open, and unsubscribe links carry one of these so a callback
 * is tamper-proof: the claims (which job, which recipient, where a click goes, which campaign) are
 * signed, and the signature is verified constant-time via `crypto.subtle.verify` before the callback
 * acts. The signing secret is a **rotatable** key from `@pithy-sh/secrets`; every token records the
 * key version (`kid`) it was signed with, so a link in a months-old email still verifies against the
 * retained version set after a rotation — and is rejected once that version is pruned.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const TokenKind = z
  .enum(["click", "open", "unsubscribe"])
  .describe("Which callback a token authorizes: a tracked link `click`, an open-pixel `open`, or an `unsubscribe`.");
export type TokenKind = z.output<typeof TokenKind>;

/** The signed claims a callback token carries. `kid`/`exp`/`v` are set by `mintToken`; the rest are caller claims. */
export const CallbackToken = z
  .object({
    v: z.literal(1).describe("Token format version, so the scheme can evolve without ambiguity."),
    kid: z.string().describe("The signing-key version this token was signed with; selects the key to verify against."),
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
export type TokenClaims = Omit<CallbackToken, "v" | "kid" | "exp">;

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
  options: { key: string; kid: string; expiresAt: Date },
): Promise<string> {
  const payload: CallbackToken = {
    v: 1,
    kid: options.kid,
    exp: Math.floor(options.expiresAt.getTime() / 1000),
    ...claims,
  };
  const payloadB64 = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  const key = await importKey(options.key);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(payloadB64)));
  return `${payloadB64}.${base64UrlEncode(signature)}`;
}

/**
 * Verify a token against the valid signing-key version set (`@pithy-sh/secrets`' `getVersions` shape)
 * and return its claims. Rejects — as `email/invalid_token` — a malformed token, an unknown/pruned
 * `kid`, a bad signature (constant-time via `crypto.subtle.verify`), or an expired token. The order
 * is deliberate: structure, then signature, then expiry, so a forged token never reaches the expiry
 * check.
 */
export async function verifyToken(
  token: string,
  keys: { versions: Record<string, string> },
  now: Date,
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

  if (parsed.data.exp * 1000 <= now.getTime()) {
    throw new EmailInvalidTokenError({ detail: "token has expired" });
  }

  return parsed.data;
}
