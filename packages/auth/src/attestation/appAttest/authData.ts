// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/** The authenticator data App Attest signs over, as far as a verifier reads it. */
export interface AuthenticatorData {
  /** SHA-256 of the App ID, `<TeamID>.<bundleId>`. */
  rpIdHash: Uint8Array;
  /** How many assertions the key has made: 0 in an attestation, then strictly increasing. */
  counter: number;
}

/** An attestation's authenticator data, which also carries the attested credential. */
export interface AttestedAuthenticatorData extends AuthenticatorData {
  /** `appattestdevelop`, or `appattest` and seven zero bytes. */
  aaguid: Uint8Array;
  /** The key id the credential was created under. */
  credentialId: Uint8Array;
}

/** The header every authenticator data starts with: `rpIdHash`, flags, counter. */
const HEADER = 37;

/** Read an assertion's authenticator data, or answer `undefined` when it is too short to hold one. */
export function readAuthenticatorData(bytes: Uint8Array): AuthenticatorData | undefined {
  if (bytes.length < HEADER) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { rpIdHash: bytes.slice(0, 32), counter: view.getUint32(33) };
}

/**
 * Read an attestation's authenticator data, through the credential id. What follows it, the COSE key and any
 * extensions, is not read: the public key is taken from the certificate, whose digest the key id must match.
 */
export function readAttestedAuthenticatorData(bytes: Uint8Array): AttestedAuthenticatorData | undefined {
  const header = readAuthenticatorData(bytes);
  if (header === undefined || bytes.length < HEADER + 18) return undefined;
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(HEADER + 16);
  const start = HEADER + 18;
  if (bytes.length < start + length) return undefined;
  return {
    ...header,
    aaguid: bytes.slice(HEADER, HEADER + 16),
    credentialId: bytes.slice(start, start + length),
  };
}
