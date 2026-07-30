// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { GoogleJwk } from "../oidc";

/**
 * Test material for Google's rail: a real RSA key, real RS256 signatures, and the Pub/Sub push envelope
 * Google wraps a Real-time Developer Notification in.
 *
 * The OIDC token on a push is the authenticity boundary for the Google webhook, so its tests have to exercise
 * genuine cryptography — a stubbed verifier proves only that a mock refuses when told to. And no test may
 * reach Google. So the suites mint their own signing key here, publish it as a JWK the verifier is given, and
 * sign real tokens with it: the same arrangement as the Apple rail's minted certificate chain, one layer
 * simpler because Google publishes bare keys rather than a chain.
 *
 * That makes the negative cases real too. A token signed by the wrong key is a second minted key. An expired
 * token is a real signature over a past `exp`. An algorithm-confused token is a genuine RSA signature under a
 * header that lies about it. None of them is a refusal on command.
 *
 * This module signs and encodes; the shipped code only verifies and decodes. It lives under `fixtures/` for
 * that reason, next to the recorded notification payloads.
 */

/** A minted signing key: the JWK a verifier is given, and the private half a test signs with. */
export interface MintedOidcKey {
  /** The key id, matched against a token header's `kid`. */
  kid: string;
  /** The public key as a JWK, in the shape Google's own key endpoint publishes. */
  jwk: GoogleJwk;
  /** The private half. What signs a token. */
  privateKey: CryptoKey;
}

/** RS256, which is the only algorithm Google signs a Pub/Sub push token with. */
const RS256 = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;

/** Mint one RSA key pair and publish its public half as a JWK. */
export async function mintOidcKey(kid = "pithy-test-1"): Promise<MintedOidcKey> {
  // `generateKey`'s return type is the union of both its overloads; an RSA algorithm always yields a pair.
  const pair = (await crypto.subtle.generateKey(
    { ...RS256, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  // `exportKey`'s type is the union over every format; `jwk` always yields a JsonWebKey.
  const exported = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  if (exported.kty === undefined || exported.n === undefined || exported.e === undefined) {
    // Cannot happen for an RSA key, and a fixture that silently minted a key with an empty modulus would make
    // every signature test pass against nothing.
    throw new Error("WebCrypto exported an RSA public key with no kty, n, or e.");
  }
  return {
    kid,
    // `kty`, `n`, and `e` come from the export; `kid`, `alg`, and `use` are what a key endpoint adds.
    jwk: { ...exported, kty: exported.kty, n: exported.n, e: exported.e, kid, alg: "RS256", use: "sig" },
    privateKey: pair.privateKey,
  };
}

/** A minted service-account key: the PEM a credential bundle carries, and the public half to check it with. */
export interface MintedServiceAccountKey {
  /** The PKCS#8 PEM, exactly as the `private_key` field of a downloaded Google key file holds it. */
  pem: string;
  /** The public half, so a test can verify the assertion the shipped code signed rather than trusting it. */
  publicKey: CryptoKey;
}

/**
 * Mint an RSA key pair and armour the private half as the PKCS#8 PEM a Google service-account key file carries.
 *
 * The public half comes back so a suite can **verify** the assertion the shipped signer produced. That is the
 * difference between asserting we posted something to the token endpoint and asserting we posted a signature
 * Google would accept.
 */
export async function mintServiceAccountKey(): Promise<MintedServiceAccountKey> {
  const pair = (await crypto.subtle.generateKey(
    { ...RS256, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pkcs8 = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
  let binary = "";
  for (const byte of pkcs8) binary += String.fromCharCode(byte);
  const body = (btoa(binary).match(/.{1,64}/g) ?? []).join("\n");
  return {
    pem: `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`,
    publicKey: pair.publicKey,
  };
}

/** base64url without padding — how every segment of a JWS is encoded. */
function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/**
 * Sign a compact JWT the way Google signs a push token: an `RS256` header naming the key, the claims, and an
 * RSASSA-PKCS1-v1_5 signature over `header.payload`.
 *
 * `header` overrides let a test present a header Google never would — `alg: "none"`, `alg: "HS256"`, a `kid`
 * nobody published — which is how algorithm confusion is proved rejected rather than assumed impossible.
 */
export async function signOidcToken(
  claims: unknown,
  key: MintedOidcKey,
  header: Record<string, unknown> = {},
): Promise<string> {
  const encoder = new TextEncoder();
  const head = base64Url(encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT", kid: key.kid, ...header })));
  const body = base64Url(encoder.encode(JSON.stringify(claims)));
  const signature = new Uint8Array(
    await crypto.subtle.sign(RS256.name, key.privateKey, encoder.encode(`${head}.${body}`)),
  );
  return `${head}.${body}.${base64Url(signature)}`;
}

/** A compact JWT with its claims swapped for others, keeping the original signature. The tamper case. */
export function tamperClaims(token: string, claims: unknown): string {
  const [head, , signature] = token.split(".");
  return `${head}.${base64Url(new TextEncoder().encode(JSON.stringify(claims)))}.${signature}`;
}

/** What a test varies about the envelope around a notification. */
export interface PushEnvelopeOptions {
  /** Pub/Sub's own message id — the dedupe key, stable across redeliveries of one message. */
  messageId?: string;
  /** When Pub/Sub published it, RFC 3339. */
  publishTime?: string;
  /** The push subscription's resource name. Informational; nothing is decided from it. */
  subscription?: string;
}

/**
 * Wrap a decoded Developer Notification in the Pub/Sub push envelope Google POSTs.
 *
 * `data` is **standard** base64 with padding, which is what Pub/Sub emits — deliberately not base64url, so the
 * decoder under test is exercised against the alphabet it will really receive.
 */
export function pushBody(notification: unknown, options: PushEnvelopeOptions = {}): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(JSON.stringify(notification))) binary += String.fromCharCode(byte);
  return JSON.stringify({
    message: {
      data: btoa(binary),
      messageId: options.messageId ?? "6714080000000001",
      publishTime: options.publishTime ?? "2026-01-15T00:00:00.000Z",
    },
    subscription: options.subscription ?? "projects/acme-42/subscriptions/pithy-payments-rtdn",
  });
}
