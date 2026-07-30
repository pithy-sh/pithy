// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { PaymentsInvalidReceiptError, PaymentsVerificationFailedError } from "../../error/errors";
import { type GoogleHttpFetch, googleHttpFetch, googleJson } from "./http";
import { base64UrlDecode, decodeJwtJson, splitJwt } from "./jwt";

/**
 * The authenticity boundary on Google's webhook: the OIDC token a Pub/Sub push carries.
 *
 * Play's Real-time Developer Notifications do not arrive from Google Play. They arrive from **Pub/Sub**, which
 * POSTs to a URL an operator configured, carrying a Google-signed OIDC token in the `Authorization` header.
 * So there is no signature over the body the way Apple signs a notification — the token is the proof, and what
 * it proves is narrow.
 *
 * **The audience check is the actual boundary.** Google signs these tokens with the same handful of keys for
 * every push subscription on the planet. A valid signature therefore says only *Google minted this*, which
 * anyone can arrange for themselves in thirty seconds. What makes a token ours is the `aud` claim: Pub/Sub sets
 * it to the audience configured on the push subscription, and that value is the endpoint the token was minted
 * for. Verify the signature and skip the audience and you have built an endpoint that accepts notifications
 * from any Google customer who points a subscription at it.
 *
 * Four checks, in this order, and the order is deliberate:
 *
 * 1. **Pin the algorithm before touching a key.** `alg` arrives in a header nobody has verified, so it is
 *    parsed against a literal `RS256` rather than looked up. That is what makes the two published confusions
 *    unreachable — `none`, which asks for the signature to be skipped, and `HS256`, which asks the verifier to
 *    HMAC with the public key as if it were a shared secret. Neither survives a literal.
 * 2. **Resolve the key by `kid` from Google's published set.** Never from the token, which is why there is no
 *    `jwk`/`x5u` handling here: a token that carries its own key is a token that verifies itself.
 * 3. **Verify the signature over the exact received segments** — `header.claims` as encoded.
 * 4. **Then read the claims,** and only then, because a claim from an unverified token means nothing.
 *
 * A failure to *read* the token is `payments/invalid_receipt`; a token that is well-formed and does not check
 * out is `payments/verification_failed`. On the webhook path the guard maps either to
 * `payments/webhook_unverified` (401), so the distinction serves the operator reading `detail` rather than the
 * caller — and a forger is told nothing about how close it got.
 */

/** Where Google publishes the keys that sign an OIDC token. Public, so it is pinned here rather than stored. */
export const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";

/**
 * The two spellings Google issues an OIDC token under. Both are current, and which one arrives is not ours to
 * decide, so both are accepted and nothing else is.
 */
export const GOOGLE_OIDC_ISSUERS: readonly string[] = ["https://accounts.google.com", "accounts.google.com"];

/** How long a fetched key set is reused. Google rotates slowly, and an unknown `kid` forces a refresh anyway. */
const JWKS_TTL_MS = 60 * 60 * 1000;

/** Tolerance on `exp` and `iat`. A minute covers clock drift; an hour would cover a replay. */
const DEFAULT_CLOCK_SKEW_SECONDS = 60;

/** RSASSA-PKCS1-v1_5 with SHA-256 — the one algorithm `alg: RS256` names, fixed here rather than derived. */
const RS256 = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;

/**
 * The header of a Pub/Sub push token, as tightly as it can be stated. `alg` is a literal for the reason in the
 * module doc; `kid` is required because a key is resolved by it and a token that names no key cannot be
 * checked against one.
 */
const GoogleOidcHeader = z
  .object({
    alg: z
      .literal("RS256")
      .describe(
        "The signing algorithm. A literal, not a lookup: `alg` arrives in an unverified header, and accepting `none` or `HS256` from it is how JWS verifiers are bypassed.",
      ),
    kid: z
      .string()
      .min(1)
      .describe("Which of Google's published keys signed the token. Resolved against Google's key endpoint."),
  })
  .loose()
  .describe("The header of a Google-signed OIDC token, constrained to the one shape Pub/Sub sends.");

/**
 * One published RSA verification key, in the shape Google's key endpoint returns. `.loose()` because Google
 * adds fields and a key set must not be rejected for carrying something new.
 */
export const GoogleJwk = z
  .object({
    kid: z.string().min(1).describe("The key id a token header names."),
    kty: z.string().min(1).describe("The key type. Only `RSA` is accepted — Google signs these with RSA keys."),
    n: z.string().min(1).describe("The RSA modulus, base64url."),
    e: z.string().min(1).describe("The RSA public exponent, base64url."),
    alg: z.string().min(1).optional().describe("The algorithm the key is published for, when stated."),
    use: z.string().min(1).optional().describe("What the key is published for — `sig` for a signing key."),
  })
  .loose()
  .describe("One of Google's published OIDC verification keys.");
export type GoogleJwk = z.infer<typeof GoogleJwk>;

/** Google's published key set. At least one key: an empty set is an endpoint that is not answering properly. */
export const GoogleJwks = z
  .object({
    keys: z.array(GoogleJwk).min(1).describe("Every key currently signing Google OIDC tokens."),
  })
  .loose()
  .describe("The response of Google's OIDC key endpoint.");
export type GoogleJwks = z.infer<typeof GoogleJwks>;

/**
 * The claims a Pub/Sub push token carries, narrowed to the ones that decide anything. `.loose()` keeps the
 * rest — the whole token is never stored, but a claim set must not be refused for being richer than expected.
 */
export const GoogleOidcClaims = z
  .object({
    iss: z.string().min(1).describe("Who issued the token. One of Google's two issuer spellings, and nothing else."),
    aud: z
      .string()
      .min(1)
      .describe(
        "Who the token was minted for — the audience configured on the push subscription. The claim that makes a token ours rather than merely Google's.",
      ),
    exp: z.number().int().describe("When the token expires, in seconds since the epoch."),
    iat: z.number().int().optional().describe("When the token was issued, in seconds since the epoch."),
    email: z
      .string()
      .min(1)
      .optional()
      .describe("The service account Pub/Sub used to mint the token. Checked against the configured one."),
    email_verified: z
      .boolean()
      .optional()
      .describe("Whether Google vouches for that address. Always true on a real push token."),
    sub: z.string().min(1).optional().describe("The service account's numeric id."),
  })
  .loose()
  .describe("The claims on a Pub/Sub push OIDC token, narrowed to the ones verification depends on.");
export type GoogleOidcClaims = z.infer<typeof GoogleOidcClaims>;

/** What verifying a push token needs. Everything is explicit, so verification is deterministic in a test. */
export interface VerifyGoogleOidcOptions {
  /** The audience the token must claim — the push subscription's configured audience. The real boundary. */
  audience: string;
  /** The service account the token must have been minted by. Google's own recommended second check. */
  serviceAccountEmail: string;
  /** The clock. Injected so an expiry refusal is deterministic. */
  now: Date;
  /** The HTTP seam Google's key endpoint is reached through. Defaults to the runtime's `fetch`. */
  transport?: GoogleHttpFetch;
  /**
   * Keys accepted **in addition to** Google's published set, matched by `kid`.
   *
   * Additive, so nothing can narrow production's trust: a token whose `kid` these do not cover still resolves
   * against Google. Two callers have a real reason — the tests, which mint their own key so the signature check
   * is exercised for real, and a local Pub/Sub emulator, whose tokens are signed by a key Google never saw.
   */
  trustedKeys?: readonly GoogleJwk[];
  /** Tolerance on `exp` and `iat`, in seconds. Defaults to a minute. */
  clockSkewSeconds?: number;
}

/**
 * Google's published keys, cached per isolate.
 *
 * A cache of *public* keys is not the thing CLAUDE.md's secrets rule forbids — nothing here is confidential,
 * and the whole point of the endpoint is that anyone may read it. What the cache buys is one round-trip per
 * hour instead of one per notification, on a path that already has a mandatory Play API call in it.
 */
let publishedKeys: { keys: GoogleJwk[]; expiresAt: number } | null = null;

/** Drop the cached key set. For tests, which must not inherit another suite's keys. */
export function resetGoogleJwksCache(): void {
  publishedKeys = null;
}

/** Fetch and validate Google's key set, replacing the cache. */
async function refreshPublishedKeys(transport: GoogleHttpFetch, now: Date): Promise<GoogleJwk[]> {
  const body = await googleJson(transport, GOOGLE_JWKS_URL, { what: "Google's OIDC verification keys" });
  const parsed = GoogleJwks.safeParse(body);
  if (!parsed.success) {
    // Fail closed. A verifier that cannot read a key set must deny, not wave the token through.
    throw new PaymentsVerificationFailedError({
      detail: `Google: the OIDC key endpoint answered an unexpected shape — ${issues(parsed.error)}.`,
    });
  }
  publishedKeys = { keys: parsed.data.keys, expiresAt: now.getTime() + JWKS_TTL_MS };
  return parsed.data.keys;
}

/**
 * The key a token's `kid` names.
 *
 * A `kid` the cache does not hold triggers **exactly one** refresh, which is what makes Google's key rotation
 * invisible: a new signing key appears in a token before anything tells us to look for it. Exactly one,
 * because otherwise a stream of forged tokens naming random `kid`s is a way to make us hammer Google.
 */
async function resolveKey(kid: string, options: VerifyGoogleOidcOptions): Promise<GoogleJwk> {
  const configured = options.trustedKeys?.find((key) => key.kid === kid);
  if (configured) return configured;

  const transport = options.transport ?? googleHttpFetch;
  const fresh = publishedKeys !== null && publishedKeys.expiresAt > options.now.getTime();
  if (fresh) {
    const cached = publishedKeys?.keys.find((key) => key.kid === kid);
    if (cached) return cached;
  }

  const refreshed = await refreshPublishedKeys(transport, options.now);
  const found = refreshed.find((key) => key.kid === kid);
  if (!found) {
    throw new PaymentsVerificationFailedError({
      detail: `Google: no published key matches the token's kid "${kid}".`,
    });
  }
  return found;
}

/** Import one published JWK as a verification key. A non-RSA key is refused rather than handed to WebCrypto. */
async function importKey(jwk: GoogleJwk): Promise<CryptoKey> {
  if (jwk.kty !== "RSA") {
    throw new PaymentsVerificationFailedError({
      detail: `Google: published key "${jwk.kid}" is ${jwk.kty}, and only RSA keys sign an OIDC token.`,
    });
  }
  try {
    return await crypto.subtle.importKey("jwk", { ...jwk, alg: "RS256" }, RS256, false, ["verify"]);
  } catch (cause) {
    throw new PaymentsVerificationFailedError(
      { detail: `Google: published key "${jwk.kid}" could not be imported.` },
      { cause },
    );
  }
}

/**
 * Verify one Pub/Sub push OIDC token and return its claims.
 *
 * @throws {@link PaymentsInvalidReceiptError} when the token cannot be read — wrong segment count, a header
 *   Google would never send, a non-JSON segment.
 * @throws {@link PaymentsVerificationFailedError} when it is well-formed and does not check out — an unknown
 *   key, a bad signature, the wrong audience, the wrong issuer, an expiry, the wrong service account.
 */
export async function verifyGoogleOidcToken(
  token: string,
  options: VerifyGoogleOidcOptions,
): Promise<GoogleOidcClaims> {
  const { head, body, mac } = splitJwt(token);

  const header = GoogleOidcHeader.safeParse(decodeJwtJson(head, "the token header"));
  if (!header.success) {
    throw new PaymentsInvalidReceiptError({
      detail: `Google: the token header is not one Pub/Sub sends — ${issues(header.error)}.`,
    });
  }

  const key = await importKey(await resolveKey(header.data.kid, options));
  const verified = await crypto.subtle.verify(
    RS256.name,
    key,
    base64UrlDecode(mac, "the token signature") as unknown as ArrayBuffer,
    new TextEncoder().encode(`${head}.${body}`) as unknown as ArrayBuffer,
  );
  if (!verified) {
    throw new PaymentsVerificationFailedError({
      detail: `Google: the token signature does not match the signed segments under key "${header.data.kid}".`,
    });
  }

  // Only now. A claim read from a token whose signature has not been checked is a claim an attacker wrote.
  const parsed = GoogleOidcClaims.safeParse(decodeJwtJson(body, "the token claims"));
  if (!parsed.success) {
    throw new PaymentsVerificationFailedError({
      detail: `Google: the token claims are not those of a Pub/Sub push token — ${issues(parsed.error)}.`,
    });
  }
  const claims = parsed.data;
  const skew = options.clockSkewSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS;
  const seconds = Math.floor(options.now.getTime() / 1000);

  if (!GOOGLE_OIDC_ISSUERS.includes(claims.iss)) {
    throw failed(`the token issuer is "${claims.iss}", not one of Google's.`);
  }
  // The boundary. Everything above proves Google minted the token; this is what proves it was minted for us.
  if (claims.aud !== options.audience) {
    throw failed(`the token audience is "${claims.aud}", and this endpoint expects "${options.audience}".`);
  }
  if (claims.exp + skew < seconds) {
    throw failed(`the token expired at ${new Date(claims.exp * 1000).toISOString()}.`);
  }
  if (claims.iat !== undefined && claims.iat - skew > seconds) {
    throw failed(`the token was issued at ${new Date(claims.iat * 1000).toISOString()}, which is in the future.`);
  }
  // Google's own guidance, and a second, independent statement: the audience says which endpoint the token was
  // minted for, the email says which identity minted it. Both are always present on a real push token.
  if (claims.email !== options.serviceAccountEmail) {
    throw failed(`the token names service account "${claims.email ?? "none"}", not the configured one.`);
  }
  if (claims.email_verified !== true) {
    throw failed("the token's service-account address is not marked verified by Google.");
  }

  return claims;
}

/** A post-signature refusal. `Google:` prefixed, and the token itself never appears. */
function failed(detail: string): PaymentsVerificationFailedError {
  return new PaymentsVerificationFailedError({ detail: `Google: ${detail}` });
}

/** Zod issues as `path:code` pairs — never `message` or `received`, which would echo the token. */
function issues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "<root>"}:${issue.code}`).join(", ");
}
