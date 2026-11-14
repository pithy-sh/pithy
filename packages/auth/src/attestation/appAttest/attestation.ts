// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { AppleAppIdentity } from "../config";
import { readAttestedAuthenticatorData } from "./authData";
import { equalBytes, sha256 } from "./bytes";
import { CborError, type CborValue, cborBytes, cborText, decodeCbor } from "./cbor";
import { DER_OCTET_STRING, DER_SEQUENCE, DerError, derChildren, expectTag, readDer } from "./der";
import { type Certificate, parseCertificate, verifyChain } from "./x509";

/** The App Attest environment an AAGUID names. */
export type AppAttestEnvironment = "production" | "development";

/** The checks an attestation can fail, each named in the refusal's `detail`. */
export type AppAttestationCheck =
  | "format"
  | "chain"
  | "nonce"
  | "keyId"
  | "rpIdHash"
  | "counter"
  | "aaguid"
  | "credentialId";

/** A key an attestation proved, ready to store. */
export interface AttestedAppAttestKey {
  /** The key id: SHA-256 of {@link publicKey}. */
  keyId: Uint8Array;
  /** The P-256 public key, as an X9.62 uncompressed point. */
  publicKey: Uint8Array;
  /** The App ID the attestation was made for, `<TeamID>.<bundleId>`. */
  appId: string;
  environment: AppAttestEnvironment;
}

/** What {@link verifyAppAttestation} judges. */
export interface AppAttestationInput {
  /** The attestation object, decoded from the base64 `attestKey` hands over. */
  attestation: Uint8Array;
  /** The key id, decoded from the base64 `generateKey` hands over. */
  keyId: Uint8Array;
  /** What the app passed to `attestKey`. */
  clientDataHash: Uint8Array;
  /** The apps allowed to attest. */
  apps: readonly AppleAppIdentity[];
  /** Whether a development AAGUID is accepted. A production one always is. */
  allowDevelopment: boolean;
  /** The root CA the chain must lead to, DER. */
  root: Uint8Array;
  now: Date;
}

export type AppAttestationResult =
  | { ok: true; key: AttestedAppAttestKey }
  | { ok: false; check: AppAttestationCheck; reason: string };

/** The leaf extension holding the nonce: a SEQUENCE holding `[1]` holding an OCTET STRING. */
const NONCE_EXTENSION = "1.2.840.113635.100.8.2";

const AAGUIDS: Record<AppAttestEnvironment, Uint8Array> = {
  production: new Uint8Array([...new TextEncoder().encode("appattest"), 0, 0, 0, 0, 0, 0, 0]),
  development: new TextEncoder().encode("appattestdevelop"),
};

const refuse = (check: AppAttestationCheck, reason: string): AppAttestationResult => ({ ok: false, check, reason });

/** `apple-appattest` statement parts, or `undefined` for anything else. */
function statement(value: CborValue): { x5c: Uint8Array[]; authData: Uint8Array } | undefined {
  if (cborText(value, "fmt") !== "apple-appattest") return undefined;
  const authData = cborBytes(value, "authData");
  const attStmt = value instanceof Map ? value.get("attStmt") : undefined;
  const x5c = attStmt instanceof Map ? attStmt.get("x5c") : undefined;
  if (authData === undefined || !Array.isArray(x5c) || !x5c.every((cert) => cert instanceof Uint8Array)) {
    return undefined;
  }
  return { x5c: x5c as Uint8Array[], authData };
}

function nonceOf(leaf: Certificate): Uint8Array | undefined {
  const value = leaf.extensions.get(NONCE_EXTENSION);
  if (value === undefined) return undefined;
  try {
    const [tagged] = derChildren(expectTag(readDer(value), DER_SEQUENCE, "the nonce extension"));
    if (tagged?.tag !== 0xa1) return undefined;
    const [nonce] = derChildren(tagged);
    return expectTag(nonce, DER_OCTET_STRING, "the nonce").content;
  } catch (cause) {
    if (cause instanceof DerError) return undefined;
    throw cause;
  }
}

/**
 * Verify an App Attest attestation object, Apple's way: the certificate chain leads to `root`, the leaf's nonce
 * extension is SHA-256 of the authenticator data and the client data hash, the leaf's key hashes to the key id,
 * the `rpIdHash` is an allowed app's, the counter is zero, the AAGUID is an accepted environment's, and the
 * credential id is the key id. Answers the first check that fails.
 */
export async function verifyAppAttestation(input: AppAttestationInput): Promise<AppAttestationResult> {
  let parts: ReturnType<typeof statement>;
  try {
    parts = statement(decodeCbor(input.attestation));
  } catch (cause) {
    if (!(cause instanceof CborError)) throw cause;
    return refuse("format", `the attestation object is not CBOR: ${cause.message}`);
  }
  if (parts === undefined) return refuse("format", "the attestation object is not an apple-appattest statement");
  if (parts.x5c.length !== 2) return refuse("chain", "x5c does not hold exactly the leaf and the intermediate");

  let chain: Certificate[];
  let root: Certificate;
  try {
    chain = parts.x5c.map(parseCertificate);
    root = parseCertificate(input.root);
  } catch (cause) {
    if (!(cause instanceof DerError)) throw cause;
    return refuse("chain", `a certificate does not parse: ${cause.message}`);
  }
  const chained = await verifyChain(chain, root, input.now);
  if (!chained.ok) return refuse("chain", chained.reason);
  const leaf = chain[0] as Certificate;

  const nonce = nonceOf(leaf);
  if (nonce === undefined) return refuse("nonce", "the leaf certificate carries no nonce extension");
  if (!equalBytes(nonce, await sha256(parts.authData, input.clientDataHash))) {
    return refuse("nonce", "the leaf certificate's nonce is not bound to this challenge");
  }

  if (leaf.publicKey.curve !== "P-256") return refuse("keyId", "the leaf certificate's key is not on P-256");
  if (!equalBytes(await sha256(leaf.publicKey.point), input.keyId)) {
    return refuse("keyId", "the leaf certificate's key does not hash to the key id");
  }

  const authData = readAttestedAuthenticatorData(parts.authData);
  if (authData === undefined) return refuse("format", "the authenticator data is too short");

  let appId: string | undefined;
  for (const app of input.apps) {
    const candidate = `${app.teamId}.${app.bundleId}`;
    if (equalBytes(await sha256(new TextEncoder().encode(candidate)), authData.rpIdHash)) appId = candidate;
  }
  if (appId === undefined) return refuse("rpIdHash", "the rpIdHash is not SHA-256 of an allowed app's App ID");

  if (authData.counter !== 0) return refuse("counter", `an attestation's counter is ${authData.counter}, not 0`);

  const environment = (Object.keys(AAGUIDS) as AppAttestEnvironment[]).find((name) =>
    equalBytes(AAGUIDS[name], authData.aaguid),
  );
  if (environment === undefined) return refuse("aaguid", "the AAGUID is neither App Attest environment's");
  if (environment === "development" && !input.allowDevelopment) {
    return refuse("aaguid", "a development AAGUID is refused here: only production keys are accepted");
  }

  if (!equalBytes(authData.credentialId, input.keyId)) {
    return refuse("credentialId", "the credential id is not the key id");
  }

  return { ok: true, key: { keyId: input.keyId, publicKey: leaf.publicKey.point, appId, environment } };
}
