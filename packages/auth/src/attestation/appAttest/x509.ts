// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { equalBytes } from "./bytes";
import {
  DER_BIT_STRING,
  DER_BOOLEAN,
  DER_OCTET_STRING,
  DER_SEQUENCE,
  DerError,
  type DerNode,
  derChildren,
  derInteger,
  derOid,
  derTime,
  expectTag,
  readDer,
} from "./der";

/** The elliptic curves an App Attest chain uses: P-384 for the root and intermediate, P-256 for the key. */
export type Curve = "P-256" | "P-384";

/** An EC public key as a certificate carries it. */
export interface EcPublicKey {
  curve: Curve;
  /** The X9.62 uncompressed point: `0x04`, then X and Y. */
  point: Uint8Array;
}

/** The parts of an X.509 certificate this verifier reads. */
export interface Certificate {
  /** The DER `tbsCertificate`: what the issuer signed. */
  tbs: Uint8Array;
  /** The signature algorithm's hash. */
  hash: "SHA-256" | "SHA-384";
  /** The DER ECDSA signature. */
  signature: Uint8Array;
  /** The DER issuer name, compared byte for byte against the issuer's subject. */
  issuer: Uint8Array;
  /** The DER subject name. */
  subject: Uint8Array;
  notBefore: Date;
  notAfter: Date;
  publicKey: EcPublicKey;
  /** Each extension's `extnValue` contents, by OID. */
  extensions: Map<string, Uint8Array>;
  /** Whether basic constraints mark it a CA. */
  isCA: boolean;
}

const EC_PUBLIC_KEY = "1.2.840.10045.2.1";
const CURVES: Record<string, Curve> = { "1.2.840.10045.3.1.7": "P-256", "1.3.132.0.34": "P-384" };
const SIGNATURE_HASHES: Record<string, Certificate["hash"]> = {
  "1.2.840.10045.4.3.2": "SHA-256",
  "1.2.840.10045.4.3.3": "SHA-384",
};
const BASIC_CONSTRAINTS = "2.5.29.19";
const FIELD_BYTES: Record<Curve, number> = { "P-256": 32, "P-384": 48 };

function bitStringBytes(node: DerNode | undefined, what: string): Uint8Array {
  const content = expectTag(node, DER_BIT_STRING, what).content;
  if (content[0] !== 0) throw new DerError(`${what} has unused bits`);
  return content.subarray(1);
}

function signatureHash(node: DerNode | undefined): Certificate["hash"] {
  const [identifier] = derChildren(expectTag(node, DER_SEQUENCE, "the signature algorithm"));
  const oid = derOid(identifier);
  const hash = SIGNATURE_HASHES[oid];
  if (hash === undefined) throw new DerError(`signature algorithm ${oid} is not ECDSA with SHA-256 or SHA-384`);
  return hash;
}

function publicKey(node: DerNode | undefined): EcPublicKey {
  const [algorithm, key] = derChildren(expectTag(node, DER_SEQUENCE, "the subject public key info"));
  const [type, parameters] = derChildren(expectTag(algorithm, DER_SEQUENCE, "the public key algorithm"));
  if (derOid(type) !== EC_PUBLIC_KEY) throw new DerError("the public key is not an EC key");
  const curve = parameters === undefined ? undefined : CURVES[derOid(parameters)];
  if (curve === undefined) throw new DerError("the public key is not on P-256 or P-384");
  const point = bitStringBytes(key, "the public key");
  if (point.length !== 1 + 2 * FIELD_BYTES[curve] || point[0] !== 0x04) {
    throw new DerError("the public key is not an uncompressed point");
  }
  return { curve, point };
}

function extensions(node: DerNode | undefined): Map<string, Uint8Array> {
  const found = new Map<string, Uint8Array>();
  if (node === undefined) return found;
  const [list] = derChildren(node);
  for (const extension of derChildren(expectTag(list, DER_SEQUENCE, "the extensions"))) {
    const parts = derChildren(expectTag(extension, DER_SEQUENCE, "an extension"));
    const oid = derOid(parts[0]);
    const value = parts[parts.length - 1];
    if (parts.length === 3) expectTag(parts[1], DER_BOOLEAN, "an extension's critical flag");
    if (found.has(oid)) throw new DerError(`extension ${oid} appears twice`);
    found.set(oid, expectTag(value, DER_OCTET_STRING, "an extension's value").content);
  }
  return found;
}

function isCA(found: Map<string, Uint8Array>): boolean {
  const value = found.get(BASIC_CONSTRAINTS);
  if (value === undefined) return false;
  const [flag] = derChildren(expectTag(readDer(value), DER_SEQUENCE, "basic constraints"));
  return flag?.tag === DER_BOOLEAN && flag.content[0] === 0xff;
}

/** Read an X.509 certificate. Throws {@link DerError} on anything this verifier cannot read. */
export function parseCertificate(der: Uint8Array): Certificate {
  const [tbsNode, algorithm, signature] = derChildren(expectTag(readDer(der), DER_SEQUENCE, "the certificate"));
  const tbs = expectTag(tbsNode, DER_SEQUENCE, "the tbsCertificate");
  const fields = derChildren(tbs);
  // The version is an explicit [0]; without it the certificate is v1, which carries no extensions.
  const offset = fields[0]?.tag === 0xa0 ? 1 : 0;
  const [, innerAlgorithm, issuer, validity, subject, spki] = fields.slice(offset);
  derInteger(fields[offset]);
  if (innerAlgorithm === undefined || algorithm === undefined || !equalBytes(innerAlgorithm.raw, algorithm.raw)) {
    throw new DerError("the certificate's two signature algorithms disagree");
  }
  const [notBefore, notAfter] = derChildren(expectTag(validity, DER_SEQUENCE, "the validity"));
  const found = extensions(fields.slice(offset + 6).find((field) => field.tag === 0xa3));
  return {
    tbs: tbs.raw,
    hash: signatureHash(algorithm),
    signature: bitStringBytes(signature, "the signature"),
    issuer: expectTag(issuer, DER_SEQUENCE, "the issuer").raw,
    subject: expectTag(subject, DER_SEQUENCE, "the subject").raw,
    notBefore: derTime(notBefore),
    notAfter: derTime(notAfter),
    publicKey: publicKey(spki),
    extensions: found,
    isCA: isCA(found),
  };
}

/** A DER ECDSA signature as WebCrypto takes it: `r` and `s`, each left-padded to the curve's field size. */
export function derSignatureToRaw(signature: Uint8Array, curve: Curve): Uint8Array | undefined {
  const size = FIELD_BYTES[curve];
  try {
    const [r, s, extra] = derChildren(expectTag(readDer(signature), DER_SEQUENCE, "the signature"));
    if (r === undefined || s === undefined || extra !== undefined) return undefined;
    const raw = new Uint8Array(size * 2);
    for (const [index, part] of [derInteger(r), derInteger(s)].entries()) {
      if (part.length === 0 || (part[0] as number) & 0x80) return undefined;
      let start = 0;
      while (start < part.length - 1 && part[start] === 0) start++;
      const digits = part.subarray(start);
      if (digits.length > size) return undefined;
      raw.set(digits, index * size + size - digits.length);
    }
    return raw;
  } catch (cause) {
    if (cause instanceof DerError) return undefined;
    throw cause;
  }
}

/** Whether `signature`, DER-encoded, is `key`'s ECDSA signature over `data` with `hash`. */
export async function verifyEcdsa(
  key: EcPublicKey,
  hash: "SHA-256" | "SHA-384",
  signature: Uint8Array,
  data: Uint8Array,
): Promise<boolean> {
  const raw = derSignatureToRaw(signature, key.curve);
  if (raw === undefined) return false;
  let imported: CryptoKey;
  try {
    imported = await crypto.subtle.importKey("raw", key.point, { name: "ECDSA", namedCurve: key.curve }, false, [
      "verify",
    ]);
  } catch {
    return false;
  }
  return crypto.subtle.verify({ name: "ECDSA", hash }, imported, raw, data);
}

/** Why a chain did not verify, or that it did. */
export type ChainVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Verify that `chain` (leaf first) leads to `root`: each certificate names the next as its issuer, is signed by
 * it, and is valid at `now`, every issuer is a CA, and the root is valid at `now` too. The root is trusted as
 * given; it is never read from the chain.
 */
export async function verifyChain(chain: readonly Certificate[], root: Certificate, now: Date): Promise<ChainVerdict> {
  if (chain.length === 0) return { ok: false, reason: "the chain is empty" };
  const all = [...chain, root];
  for (const [index, cert] of all.entries()) {
    const name = index === 0 ? "the leaf certificate" : index === all.length - 1 ? "the root" : `certificate ${index}`;
    if (now < cert.notBefore || now > cert.notAfter) {
      return {
        ok: false,
        reason: `${name} is not valid at ${now.toISOString()} (valid ${cert.notBefore.toISOString()} to ${cert.notAfter.toISOString()})`,
      };
    }
    const issuer = all[index + 1];
    if (issuer === undefined) break;
    if (!issuer.isCA) return { ok: false, reason: `the issuer of ${name} is not a CA` };
    if (!equalBytes(cert.issuer, issuer.subject)) {
      return { ok: false, reason: `${name} names an issuer other than the next certificate` };
    }
    if (!(await verifyEcdsa(issuer.publicKey, cert.hash, cert.signature, cert.tbs))) {
      return { ok: false, reason: `${name} is not signed by its issuer` };
    }
  }
  return { ok: true };
}
