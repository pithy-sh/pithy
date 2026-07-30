import type { Ed25519PublicJwk } from "../data/connection";
import { base64UrlEncode } from "./base64url";
import { ControlPlaneClaims, type ControlPlaneJwsHeader } from "./claims";
import { sha256Base64Url } from "./digest";

/**
 * Mint a control-plane token — the management client's half of the seam.
 *
 * **This ships because the seam is MIT and is never gated by tier.** "You can build your own client
 * against your own Worker" has to be true, and it is not true if the only way to produce a token the
 * Worker accepts is to reverse-engineer the verifier. So the minting side lives here, beside the
 * verifying side, and the two are tested against each other.
 *
 * It is also what the hosted dashboard would use, and what every test in this package uses to sign a
 * real token rather than assert against a fixture.
 *
 * **Nothing here touches a private key store.** The caller supplies an already-imported `CryptoKey`.
 * Core holds no key material, has no opinion about where a private key lives, and this file would be
 * the wrong place to acquire one.
 */

/** One token's worth of claims, minus the parts {@link mintControlPlaneToken} computes. */
export interface MintControlPlaneToken {
  /** The signing key, imported for `Ed25519` with `["sign"]` usage. */
  privateKey: CryptoKey;
  /** The `kid` naming which registered public key verifies this token. */
  keyId: string;
  /** The management client's origin — must equal the `issuer` stored on the connection. */
  issuer: string;
  /** The connection this token addresses. */
  connectionId: string;
  /** Who, in the management client's own id space, is acting. */
  subject: string;
  /** The single operation this token authorizes. One call, one scope. */
  scope: string;
  /** The raw request body these claims are bound to. Empty for a request that carries none. */
  body?: Uint8Array;
  /** Seconds this token is good for. The Worker caps it, so asking for more only wastes the request. */
  lifetimeSeconds?: number;
  /** The clock, injected so a caller can mint a token at a chosen instant. */
  now?: () => Date;
  /** The token's unique id. Generated when absent; supply one only to test a replay. */
  tokenId?: string;
}

/** Base64url a UTF-8 JSON serialization — the encoding both JWS segments use. */
function encodeSegment(value: unknown): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
}

/**
 * Build and sign a compact JWS the seam will accept.
 *
 * The body digest is computed here rather than accepted from the caller, so a client cannot mint a
 * token whose digest disagrees with the bytes it is about to send. `bodySha256` is null exactly when
 * the body is empty, which is the same bijection the verifier enforces.
 */
export async function mintControlPlaneToken(input: MintControlPlaneToken): Promise<string> {
  const body = input.body ?? new Uint8Array(0);
  const issuedAt = Math.floor((input.now?.() ?? new Date()).getTime() / 1000);

  const header: ControlPlaneJwsHeader = { alg: "EdDSA", typ: "JWT", kid: input.keyId };
  const claims = ControlPlaneClaims.parse({
    iss: input.issuer,
    aud: input.connectionId,
    sub: input.subject,
    scope: input.scope,
    jti: input.tokenId ?? crypto.randomUUID(),
    iat: issuedAt,
    exp: issuedAt + (input.lifetimeSeconds ?? 60),
    bodySha256: body.byteLength === 0 ? null : await sha256Base64Url(body),
  });

  const signingInput = `${encodeSegment(header)}.${encodeSegment(claims)}`;
  const signature = await crypto.subtle.sign("Ed25519", input.privateKey, new TextEncoder().encode(signingInput));
  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/**
 * Export a generated key pair's public half as the JWK the adopter registers.
 *
 * `crv` and `kty` are re-asserted from our own constants rather than trusted from the export, so a
 * runtime that spelled them differently produces a key this seam still recognises — or fails here,
 * where it is obvious, rather than at the first verification.
 */
export async function exportPublicJwk(publicKey: CryptoKey): Promise<Ed25519PublicJwk> {
  const exported = (await crypto.subtle.exportKey("jwk", publicKey)) as { x?: string };
  if (!exported.x) throw new TypeError("Ed25519 public key export carried no `x` coordinate.");
  return { kty: "OKP", crv: "Ed25519", x: exported.x };
}
