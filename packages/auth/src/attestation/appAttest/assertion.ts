// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readAuthenticatorData } from "./authData";
import { equalBytes, sha256 } from "./bytes";
import { CborError, cborBytes, decodeCbor } from "./cbor";
import { verifyEcdsa } from "./x509";

/** The checks an assertion can fail, each named in the refusal's `detail`. */
export type AppAttestAssertionCheck = "format" | "rpIdHash" | "signature" | "counter";

/** What {@link verifyAppAttestAssertion} judges. */
export interface AppAttestAssertionInput {
  /** The assertion, decoded from the base64 `generateAssertion` hands over. */
  assertion: Uint8Array;
  /** The registered key's P-256 public point. */
  publicKey: Uint8Array;
  /** The App ID the key was registered for. */
  appId: string;
  /** What the app passed to `generateAssertion`. */
  clientDataHash: Uint8Array;
  /** The counter stored from the key's last accepted assertion, or 0 after registration. */
  counter: number;
}

export type AppAttestAssertionResult =
  | { ok: true; counter: number }
  | { ok: false; check: AppAttestAssertionCheck; reason: string };

/**
 * Verify an App Attest assertion, Apple's way: the signature is the key's ECDSA P-256 SHA-256 signature over
 * SHA-256 of the authenticator data and the client data hash, the `rpIdHash` is the key's app's, and the counter is
 * above the stored one. Answers the new counter, which the caller stores only if it is still above the stored one.
 */
export async function verifyAppAttestAssertion(input: AppAttestAssertionInput): Promise<AppAttestAssertionResult> {
  let signature: Uint8Array | undefined;
  let authenticatorData: Uint8Array | undefined;
  try {
    const decoded = decodeCbor(input.assertion);
    signature = cborBytes(decoded, "signature");
    authenticatorData = cborBytes(decoded, "authenticatorData");
  } catch (cause) {
    if (!(cause instanceof CborError)) throw cause;
    return { ok: false, check: "format", reason: `the assertion is not CBOR: ${cause.message}` };
  }
  const data = authenticatorData === undefined ? undefined : readAuthenticatorData(authenticatorData);
  if (signature === undefined || authenticatorData === undefined || data === undefined) {
    return { ok: false, check: "format", reason: "the assertion lacks a signature or authenticator data" };
  }
  if (!equalBytes(data.rpIdHash, await sha256(new TextEncoder().encode(input.appId)))) {
    return { ok: false, check: "rpIdHash", reason: `the rpIdHash is not SHA-256 of ${input.appId}` };
  }
  const nonce = await sha256(authenticatorData, input.clientDataHash);
  if (!(await verifyEcdsa({ curve: "P-256", point: input.publicKey }, "SHA-256", signature, nonce))) {
    return { ok: false, check: "signature", reason: "the signature does not verify with the registered key" };
  }
  if (data.counter <= input.counter) {
    return {
      ok: false,
      check: "counter",
      reason: `the counter ${data.counter} does not increase on the stored ${input.counter}`,
    };
  }
  return { ok: true, counter: data.counter };
}
