// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { OidcJwk, OidcJwksFetch, OidcJwksResponse } from "../http/oidcWebhook";

/**
 * The identity provider's half of the protocol `requireOidcWebhook` verifies: mint a signing key,
 * publish it as a JWKS, and sign tokens with it.
 *
 * **Why it ships rather than staying private to the kit's own suite.** A route guarded by
 * `requireOidcWebhook` can only be tested by presenting a token the
 * guard accepts, and building one means WebCrypto key generation, base64url without padding, a compact
 * JWS, and a transport that publishes the public half. That came to 103 lines the first time an adopter
 * wrote it, none of it adopter-specific — and a hand-rolled copy is **a second definition of the wire
 * format**, which is the argument this repository already makes about signers. It can agree with itself
 * and disagree with the verifier. The first copy did: its fake transport returned `json()` where
 * {@link OidcJwksResponse} declares `text()`, so every delivery 502'd from a fixture that looked right.
 * Here that is unrepresentable — {@link publishing} is typed as the seam, so a `json()` is a red build
 * rather than a wrong answer at runtime.
 *
 * **Real WebCrypto, never a stubbed signature.** Every negative case an adopter writes with these is a
 * token somebody really signed — the impostor key, the wrong `kid`, the tampered claims. A hand-rolled
 * key and a hand-rolled signature would let every signature assertion pass by agreeing with itself.
 *
 * **What is deliberately not here.** No helper that builds a *provider's* claims: GitHub's
 * `repo:owner/name:environment:x` is the adopter's business and differs per provider, so claims stay a
 * plain object the test writes. And no algorithm-confusion forgery — that proves a property of the kit's
 * verifier, which the kit tests, rather than of an adopter's route.
 *
 * `oidcFixtures.test.ts` holds all of this to the real `verifyOidcToken`:
 * a token it accepts, and one it refuses for each reason. That is what keeps the fixture and the verifier
 * from drifting apart while both stay green.
 */

/** A minted signing key: the JWK a verifier is given, and the private half a test signs with. */
export interface MintedKey {
  /** The key id, matched against a token header's `kid`. */
  kid: string;
  /** The public key as a JWK, in the shape a JWKS endpoint publishes it. */
  jwk: OidcJwk;
  /** The private half. What signs a token. */
  privateKey: CryptoKey;
}

/**
 * Mint one RSA key pair and publish its public half as a JWK.
 *
 * Real WebCrypto, not a fixture: a hand-rolled key and a hand-rolled signature would let every signature
 * assertion pass by agreeing with itself. A second minted key is what makes "signed by somebody else" a
 * real statement rather than a label — mint one, publish only the first, and the refusal is the verifier's
 * rather than the test's.
 *
 * Key generation is the slow part of any suite using this and a key is immutable, so mint in a
 * `beforeAll` and reuse.
 */
export async function mintKey(kid: string): Promise<MintedKey> {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const exported = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  if (exported.kty === undefined || exported.n === undefined || exported.e === undefined) {
    // Cannot happen for an RSA key, and a fixture that silently minted one with an empty modulus would make
    // every signature test pass against nothing.
    throw new Error("WebCrypto exported an RSA public key with no kty, n, or e.");
  }
  return {
    kid,
    jwk: { ...exported, kty: exported.kty, n: exported.n, e: exported.e, kid, alg: "RS256", use: "sig" },
    privateKey: pair.privateKey,
  };
}

/**
 * base64url without padding — how every segment of a compact JWS is encoded.
 *
 * Exported because a test that builds a token by hand needs it: the tamper case swaps a claims segment and
 * keeps the signature, and re-encoding that segment with padding or with `+`/`/` would make the token
 * refused for the wrong reason.
 */
export function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/**
 * Sign a compact JWT the way an identity provider signs an OIDC token: `RS256`, `typ: "JWT"`, and the
 * signer's `kid` in the header.
 *
 * `payload` is the claims, written as the provider writes them — `iss`, `aud`, `exp`, and whatever the
 * route's `claims` predicate reads. Nothing here defaults a claim, because a fixture that quietly supplied
 * one would be testing itself.
 *
 * `header` overrides let a test present a header no provider would — `alg: "none"`, `alg: "RS512"`, a `kid`
 * nobody published, or `kid: undefined` — which is how a route proves algorithm confusion and an
 * unpublished key are rejected, instead of trusting that the kit covers it somewhere.
 */
export async function signToken(
  payload: unknown,
  signer: MintedKey,
  header: Record<string, unknown> = {},
): Promise<string> {
  const encoder = new TextEncoder();
  const head = base64Url(encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT", kid: signer.kid, ...header })));
  const body = base64Url(encoder.encode(JSON.stringify(payload)));
  const signature = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", signer.privateKey, encoder.encode(`${head}.${body}`)),
  );
  return `${head}.${body}.${base64Url(signature)}`;
}

/**
 * A JWKS transport that publishes `keys` at `jwksUrl` and nothing anywhere else, recording every URL it was
 * asked for in `seen`.
 *
 * **The response is the seam's own shape, which is the whole point of shipping this.** `text()`, never
 * `json()` — {@link OidcJwksResponse} reads the body as text deliberately, so a proxy's HTML error page is a
 * diagnosis rather than a throw. A hand-rolled transport that answers `json()` produces a 502 on every
 * delivery from a fixture that looks correct. Typed as {@link OidcJwksFetch}, that mistake will not compile.
 *
 * **The URL is a parameter rather than a wildcard.** A transport that served keys at any URL would pass a
 * route whose configured `jwksUrl` points at nothing — the one configuration mistake a test of a webhook
 * route exists to catch. Anything else gets a 404 with a body, which is what an issuer's CDN actually
 * returns and what the verifier maps to a 502.
 *
 * `seen` is an array the caller owns, so a test can assert the fetch count: one per delivery with no cache,
 * one per TTL with one, and zero when a cache is pre-seeded. Pass `publishing(url, [], seen)` to prove a
 * path never reaches the network at all — an empty key set is refused, so an unexpected fetch fails loudly.
 */
export function publishing(jwksUrl: string, keys: readonly OidcJwk[], seen: string[] = []): OidcJwksFetch {
  return async (url) => {
    seen.push(url);
    if (url !== jwksUrl) return { ok: false, status: 404, text: async () => "{}" };
    return { ok: true, status: 200, text: async () => JSON.stringify({ keys }) };
  };
}
