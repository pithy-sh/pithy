// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { z } from "zod";
import type { Ed25519PublicJwk } from "../data/connection";
import { ControlPlaneInvalidCredentialError } from "../error/errors";
import { base64UrlDecode } from "./base64url";
import { ControlPlaneClaims, ControlPlaneJwsHeader } from "./claims";

/**
 * Compact JWS: parse, then verify. Two functions, in that order, and the order is the security model.
 *
 * **No JWT library.** Core's runtime dependencies are fixed and `jose` is not among them — but the
 * better reason is that the whole surface is one algorithm, one key type, one token shape. Ed25519
 * over WebCrypto is a dozen lines; a general-purpose library brings the algorithm agility that causes
 * the JWT vulnerabilities in the first place. There is nothing to negotiate here, so nothing
 * negotiates.
 */

/** What {@link parseCompactJws} hands back: shape only, authenticity not yet established. */
export interface ParsedCompactJws {
  /** The validated protected header. `alg` is EdDSA because the schema says so, not because the token did. */
  header: ControlPlaneJwsHeader;
  /** The validated claims. Well-formed, entirely unproven. */
  claims: ControlPlaneClaims;
  /** The first two segments verbatim — the exact bytes the signature covers. */
  signingInput: string;
  /** The raw Ed25519 signature, 64 bytes when genuine. */
  signature: Uint8Array;
}

/**
 * Split a compact JWS, decode it, and validate both segments through their schemas.
 *
 * **Everything this returns is untrusted.** Parsing proves the token is well-formed; a forged token is
 * well-formed too. No caller may read a claim, load a connection by `aud`, or act on `scope` before
 * {@link verifyEd25519} has returned true for the `signingInput` and `signature` returned alongside
 * them. The only exception is the `kid` lookup that finds the key to verify *with* — and that lookup
 * grants nothing on its own.
 *
 * Every failure throws the one {@link ControlPlaneInvalidCredentialError}. Segment count, base64,
 * JSON, schema — a caller cannot tell which, and so cannot use the response to find out how far a
 * forgery got.
 */
export function parseCompactJws(token: string): ParsedCompactJws {
  const segments = token.split(".");
  const [encodedHeader, encodedClaims, encodedSignature] = segments;
  if (segments.length !== 3 || !encodedHeader || !encodedClaims || !encodedSignature) {
    throw new ControlPlaneInvalidCredentialError({
      detail: `expected 3 non-empty compact JWS segments, got ${segments.length}`,
    });
  }

  return {
    header: decodeSegment(encodedHeader, ControlPlaneJwsHeader, "header"),
    claims: decodeSegment(encodedClaims, ControlPlaneClaims, "claims"),
    // Verbatim, never re-serialized. Ed25519 signs bytes, and `JSON.stringify` of a parsed object is
    // not reliably the bytes that were signed — key order and whitespace are the client's, not ours.
    signingInput: `${encodedHeader}.${encodedClaims}`,
    signature: base64UrlDecode(encodedSignature),
  };
}

/** Decode one JSON segment and validate it, collapsing every failure into the one credential error. */
function decodeSegment<T>(segment: string, schema: z.ZodType<T>, label: string): T {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(base64UrlDecode(segment)));
  } catch (cause) {
    // A bad segment already threw the right error from `base64UrlDecode`. Rethrow it rather than
    // wrapping, so the detail keeps naming the step that actually failed.
    if (cause instanceof ControlPlaneInvalidCredentialError) throw cause;
    throw new ControlPlaneInvalidCredentialError({ detail: `token ${label} is not JSON` }, { cause });
  }
  const result = schema.safeParse(json);
  if (!result.success) {
    throw new ControlPlaneInvalidCredentialError({ detail: `token ${label} failed schema validation` });
  }
  return result.data;
}

/**
 * Verify an Ed25519 signature over the signing input with a registered public key.
 *
 * `false` rather than a throw is the contract, and it covers WebCrypto throwing too. An unimportable
 * key means the adopter's connection row holds something malformed — that is a denial, not a Worker
 * crash, and it must render as the same 401 a bad signature does. Turning a bad row into a 500 would
 * both leak that the row is bad and take the route down for everyone.
 */
export async function verifyEd25519(
  signingInput: string,
  signature: Uint8Array,
  jwk: Ed25519PublicJwk,
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify("Ed25519", key, signature, new TextEncoder().encode(signingInput));
  } catch {
    return false;
  }
}
