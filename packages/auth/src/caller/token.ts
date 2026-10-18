// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { z } from "zod";

/**
 * **A short-lived, audience-restricted caller token — the portable way to prove a request came from the
 * adopter's own backend (#560).**
 *
 * `resolveScopes` asks one question: is this request's caller the adopter's trusted backend, or a device?
 * Where that backend is a Worker, a service binding answers it with no credential at all, and where the
 * zone can run mTLS a client certificate answers it at the edge. Neither works everywhere — a service
 * binding needs both ends on Cloudflare, mTLS needs a proxied zone and an exact hostname, so not
 * `workers.dev`. This is what works on day one anywhere, and it is shipped because the alternative every
 * adopter otherwise reaches for is a long-lived shared secret compared in a header, which fails every
 * control RFC 9700 names at once.
 *
 * So it holds to those controls, each on its own line below:
 *
 * - **Audience-restricted.** `aud` is the origin the token was minted for, and it verifies there and nowhere
 *   else — a staging token presented to production is refused, and so is one Worker's token replayed at
 *   another that happens to share the key.
 * - **Short-lived.** Five minutes by default, and a ceiling of fifteen that no token and no configuration
 *   gets past. A token whose `exp` is a day after its `iat` is refused even when it is otherwise perfect,
 *   because honoring it would make it a shared secret with extra steps.
 * - **Signed with a rotatable key from `@pithy-sh/secrets`.** The `kid` names the key version, so a token
 *   minted a minute before a rotation still verifies during the overlap and stops verifying after it.
 *
 * What it is not is **sender-constrained**: a token lifted off the wire is usable by whoever lifted it, for
 * the minutes it has left. RFC 9700 says a token SHOULD be bound to its sender, and the two answers are
 * mTLS (`readClientCertificate`) and DPoP, which the kit does not ship yet. Short lifetime is what limits
 * the damage here, which is why the ceiling is not negotiable.
 *
 * **HS256 and nothing else.** One algorithm, one key type, one token shape — the header is validated
 * against a literal, so `alg: none` and an asymmetric algorithm are malformed rather than negotiated. No
 * JWT library: the algorithm agility one brings is where the JWT vulnerabilities live.
 */

/** The header a caller token travels on. Not `Authorization`, which carries the backend's own session. */
export const CALLER_TOKEN_HEADER = "pithy-caller";

/** How long a minted token lives unless the minter asks for less: five minutes. */
export const DEFAULT_CALLER_TOKEN_LIFETIME_SECONDS = 5 * 60;

/**
 * The longest a caller token may live, from its `iat` to its `exp` — fifteen minutes, minted or verified.
 *
 * A ceiling rather than a default, and it refuses above rather than clamping: a verifier configured past it
 * is a configuration error, and a token claiming more is refused. Minutes because the token is a bearer
 * credential with no sender binding, and its lifetime is the whole of what bounds a stolen one.
 */
export const MAX_CALLER_TOKEN_LIFETIME_SECONDS = 15 * 60;

/** How far in the future an `iat` may sit before the token is refused — clocks disagree by seconds, not minutes. */
export const CALLER_TOKEN_CLOCK_SKEW_SECONDS = 30;

/** The protected header of a caller token. */
export const CallerTokenHeader = z
  .object({
    alg: z.literal("HS256").describe("The signature algorithm. HMAC-SHA-256, and nothing else is accepted."),
    typ: z.literal("JWT").optional().describe("The media type, `JWT` when present."),
    kid: z.string().min(1).describe("The version of the caller-token key this token was signed with."),
  })
  .describe("The protected header of a caller token: HS256, and which key version signed it.");
export type CallerTokenHeader = z.infer<typeof CallerTokenHeader>;

/** The claims a caller token carries. */
export const CallerTokenClaims = z
  .object({
    aud: z.string().describe("The origin this token was minted for. It verifies at that origin and nowhere else."),
    iat: z.number().int().describe("When it was minted, in Unix seconds."),
    exp: z.number().int().describe("When it stops verifying, in Unix seconds. At most fifteen minutes after `iat`."),
    sub: z
      .string()
      .optional()
      .describe("Which backend minted it, for the adopter's own logs. The verifier grants nothing on it."),
  })
  .describe("The claims of a caller token: where it is valid, and for how long.");
export type CallerTokenClaims = z.infer<typeof CallerTokenClaims>;

/**
 * Why a caller token was not trusted. Distinct values so the adopter's own log can say which, never so a
 * response can — a resolver answers `[]` for every one of them, and the gate's 403 is the same either way.
 */
export type CallerTokenRefusal =
  | "absent"
  | "malformed"
  | "unknown_key"
  | "signature"
  | "audience"
  | "expired"
  | "lifetime";

/** What {@link verifyCallerToken} decided. */
export type CallerTokenVerdict =
  | { trusted: true; claims: CallerTokenClaims }
  | { trusted: false; reason: CallerTokenRefusal };

/** A key set in the shape `secretsStore(...).getVersions(name)` answers: version → key. */
export interface CallerTokenKeys {
  versions: Record<string, string>;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The url alphabet, unpadded. Padding and the standard alphabet are refused, so a token has one spelling. */
const BASE64URL = /^[A-Za-z0-9_-]+$/;

function encodeSegment(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Decode one unpadded base64url segment, or `null` — strict, because every segment is attacker-supplied. */
function decodeSegment(segment: string): Uint8Array | null {
  if (!BASE64URL.test(segment) || segment.length % 4 === 1) return null;
  try {
    const binary = atob(segment.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (segment.length % 4)) % 4));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/** Decode a JSON segment through its schema, or `null` for any failure at all. */
function decodeJson<T>(segment: string, schema: z.ZodType<T>): T | null {
  const bytes = decodeSegment(segment);
  if (bytes === null) return null;
  let json: unknown;
  try {
    json = JSON.parse(decoder.decode(bytes));
  } catch {
    return null;
  }
  const parsed = schema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

/** The origin a URL names, or the string unchanged when it is not one — so it can only fail to match. */
function originOf(audience: string): string {
  try {
    return new URL(audience).origin;
  } catch {
    return audience;
  }
}

function hmacKey(key: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(key), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

/** Refuse a lifetime outside `(0, MAX]` — a configuration error, raised loudly rather than clamped. */
function assertLifetime(seconds: number, what: string): void {
  if (!Number.isInteger(seconds) || seconds <= 0 || seconds > MAX_CALLER_TOKEN_LIFETIME_SECONDS) {
    throw new InternalError({
      message: `A caller token's ${what} must be a whole number of seconds from 1 to ${MAX_CALLER_TOKEN_LIFETIME_SECONDS}.`,
      action: `Use a lifetime of minutes, not hours — at most ${MAX_CALLER_TOKEN_LIFETIME_SECONDS} seconds.`,
      detail: `got ${String(seconds)}`,
    });
  }
}

/** What {@link mintCallerToken} takes. */
export interface MintCallerTokenOptions {
  /** The current caller-token key — `getVersions(...).versions[currentVersion]`. */
  key: string;
  /** Its version — `getVersions(...).currentVersion`. */
  kid: string;
  /** Any URL on the Worker the token will be presented to. Reduced to its origin. */
  audience: string;
  /** Which backend is minting, for the receiving Worker's logs. Optional; it grants nothing. */
  subject?: string;
  /** How long it lives. Defaults to {@link DEFAULT_CALLER_TOKEN_LIFETIME_SECONDS}; never more than the ceiling. */
  lifetimeSeconds?: number;
  /** The clock. Defaults to now. */
  now?: Date;
}

/**
 * Mint a caller token — on the **trusted backend**, never on a device.
 *
 * Mint one per call, or per few minutes, and present it on {@link CALLER_TOKEN_HEADER}. A backend that is
 * another Worker in this project reads the key the way the verifier does, through `@pithy-sh/secrets`.
 */
export async function mintCallerToken(options: MintCallerTokenOptions): Promise<string> {
  const lifetime = options.lifetimeSeconds ?? DEFAULT_CALLER_TOKEN_LIFETIME_SECONDS;
  assertLifetime(lifetime, "lifetime");
  const iat = Math.floor((options.now ?? new Date()).getTime() / 1000);
  const header: CallerTokenHeader = { alg: "HS256", typ: "JWT", kid: options.kid };
  const claims: CallerTokenClaims = {
    aud: originOf(options.audience),
    iat,
    exp: iat + lifetime,
    ...(options.subject === undefined ? {} : { sub: options.subject }),
  };
  const input = `${encodeSegment(encoder.encode(JSON.stringify(header)))}.${encodeSegment(encoder.encode(JSON.stringify(claims)))}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", await hmacKey(options.key, "sign"), encoder.encode(input)),
  );
  return `${input}.${encodeSegment(signature)}`;
}

/** What {@link verifyCallerToken} takes. */
export interface VerifyCallerTokenOptions {
  /** Every still-valid key version, as `getVersions` answers them. */
  keys: CallerTokenKeys;
  /**
   * This Worker's own public origin — the `baseURL` handed to `auth()`. **Never** a value read off the
   * request or the token: a verifier handed the caller's idea of the audience accepts every audience.
   */
  audience: string;
  /** The clock. Defaults to now. */
  now?: Date;
  /** A tighter ceiling than {@link MAX_CALLER_TOKEN_LIFETIME_SECONDS}, for a verifier that wants one. */
  maxLifetimeSeconds?: number;
}

/**
 * Decide whether a caller token is one to trust, and why not when it is not.
 *
 * **In this order, and the order is the security model:** structure, then the key, then the signature,
 * then the audience, then the lifetime, then expiry. Nothing about the claims is read as a fact until the
 * signature has verified, so a forgery learns nothing from the answer about how far it got.
 *
 * Returns a verdict rather than throwing, so a resolver can answer `[]` and log the reason. It throws only
 * for its own misconfiguration — a ceiling past the maximum — which `resolveScopes` turns into no scopes.
 */
export async function verifyCallerToken(token: string, options: VerifyCallerTokenOptions): Promise<CallerTokenVerdict> {
  const ceiling = options.maxLifetimeSeconds ?? MAX_CALLER_TOKEN_LIFETIME_SECONDS;
  assertLifetime(ceiling, "lifetime ceiling");

  const segments = token.split(".");
  const [encodedHeader, encodedClaims, encodedSignature] = segments;
  if (segments.length !== 3 || !encodedHeader || !encodedClaims || !encodedSignature) {
    return { trusted: false, reason: "malformed" };
  }
  const header = decodeJson(encodedHeader, CallerTokenHeader);
  const claims = decodeJson(encodedClaims, CallerTokenClaims);
  const signature = decodeSegment(encodedSignature);
  if (header === null || claims === null || signature === null) return { trusted: false, reason: "malformed" };

  // An own property and a string, or nothing. A bracket lookup with `kid: "__proto__"` would otherwise
  // reach up the prototype chain, hand `importKey` an object it coerces to a fixed string, and sign for it.
  const versions = options.keys.versions;
  const key = Object.hasOwn(versions, header.kid) ? versions[header.kid] : undefined;
  if (typeof key !== "string") return { trusted: false, reason: "unknown_key" };

  let verified: boolean;
  try {
    verified = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(key, "verify"),
      new Uint8Array(signature),
      encoder.encode(`${encodedHeader}.${encodedClaims}`),
    );
  } catch {
    verified = false;
  }
  if (!verified) return { trusted: false, reason: "signature" };

  if (claims.aud !== originOf(options.audience)) return { trusted: false, reason: "audience" };

  const now = Math.floor((options.now ?? new Date()).getTime() / 1000);
  if (claims.exp - claims.iat > ceiling || claims.iat > now + CALLER_TOKEN_CLOCK_SKEW_SECONDS) {
    return { trusted: false, reason: "lifetime" };
  }
  if (claims.exp <= now) return { trusted: false, reason: "expired" };

  return { trusted: true, claims };
}
