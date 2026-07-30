import { PaymentsInvalidReceiptError, PaymentsVerificationFailedError } from "../../error/errors";
import {
  ASN1_BOOLEAN,
  ASN1_GENERALIZED_TIME,
  ASN1_INTEGER,
  ASN1_OCTET_STRING,
  ASN1_SEQUENCE,
  ASN1_UTC_TIME,
  type Asn1Node,
  asn1Children,
  bytesEqual,
  decodeBase64,
  derSignatureToRaw,
  readAsn1,
  readBits,
  readBoolean,
  readInteger,
  readOid,
} from "./der";

/**
 * X.509 certificates, and the chain check that makes an Apple signature mean something.
 *
 * A JWS signature only proves that whoever held a key signed the bytes. What makes it *Apple's* signature
 * is that the key belongs to a certificate Apple issued, through an intermediate Apple issued, from a root
 * we shipped. Skipping any link of that turns the webhook route into one that accepts a notification signed
 * by anybody who can mint a certificate — which is anybody.
 *
 * So the chain is verified in full, and every rule below exists because omitting it is a known bypass:
 *
 * - **Each link's signature is checked against the next certificate's key.** Reading `x5c` and trusting the
 *   leaf is the classic mistake: the header is attacker-controlled, so an unchecked chain is decoration.
 * - **The last certificate must be byte-identical to a pinned root.** Byte equality rather than
 *   re-verifying the root's self-signature, because a self-signature only proves a root vouches for itself,
 *   which every forged root also does.
 * - **Issuer and subject names must match, link by link.** Cheap, and it refuses a chain assembled out of
 *   two unrelated ones before any crypto runs.
 * - **Every certificate's validity window must contain the clock**, the root included. An expired
 *   intermediate is as much a refusal as an expired leaf, and the clock is injected so the check is a real
 *   comparison in tests rather than an accident of when the suite runs.
 * - **Every certificate above the leaf must be a CA**, by `basicConstraints.cA`, with `keyCertSign` in
 *   `keyUsage` where that extension is present, and its `pathLenConstraint` respected. Without this the
 *   other rules are not enough, and the hole is not theoretical: a chain of
 *   `[forged, someAppleLeaf, intermediate, root]` links correctly, sits inside every validity window, and
 *   roots in the pinned certificate. Anyone holding **any** ECDSA leaf certificate issued under Apple Root
 *   CA - G3 — a paid developer's own certificate is one — could sign `forged` themselves and every check
 *   above would pass. `cA` is what says a certificate may issue others, so it is what closes it.
 * - **The leaf and its issuer must carry Apple's marker extensions.** Apple publishes an OID it puts on the
 *   certificate that signs App Store data, and another on the WWDR intermediate that issues it. Requiring
 *   them means a chain must not merely root in Apple's CA but be *the* Apple chain for *this* purpose — so
 *   even a genuine Apple sub-CA issued for something else cannot sign a notification.
 *
 * Only ECDSA is accepted, on P-256 and P-384, with SHA-256 or SHA-384. Apple's chain is elliptic-curve end
 * to end (see `certs.ts`), and an algorithm the boundary never meets is surface with no user.
 *
 * A structural problem throws `payments/invalid_receipt`; a chain that is well-formed but does not verify
 * throws `payments/verification_failed`. The distinction is worth keeping: the first is a malformed
 * request, the second is a rejected one.
 */

/** ECDSA signature-algorithm OIDs → the digest each one names. */
const SIGNATURE_HASHES: Record<string, "SHA-256" | "SHA-384"> = {
  "1.2.840.10045.4.3.2": "SHA-256",
  "1.2.840.10045.4.3.3": "SHA-384",
};

/** Named-curve OIDs → the curve names WebCrypto knows them by. */
const CURVES: Record<string, "P-256" | "P-384"> = {
  "1.2.840.10045.3.1.7": "P-256",
  "1.3.132.0.34": "P-384",
};

/** The coordinate width of each curve, which is what an ECDSA signature's two halves are padded to. */
const COORDINATE_BYTES: Record<"P-256" | "P-384", number> = { "P-256": 32, "P-384": 48 };

/** `basicConstraints` — whether a certificate may issue others, and how deep beneath it a path may run. */
const OID_BASIC_CONSTRAINTS = "2.5.29.19";
/** `keyUsage` — the bit field whose `keyCertSign` says the key may sign certificates. */
const OID_KEY_USAGE = "2.5.29.15";
/** `keyCertSign` is bit 5 of `keyUsage`, counting from the most significant bit of the first byte. */
const KEY_CERT_SIGN_BIT = 5;

/**
 * Apple's marker on the certificate that signs App Store Server Notifications and transactions, and on the
 * WWDR intermediate that issues it. Published by Apple and checked by Apple's own `app-store-server-library`,
 * which is where these values come from; they are identifiers, not secrets.
 *
 * They are what make the chain check an identity check. Rooting in Apple Root CA - G3 proves Apple issued
 * something in the path; these prove the path is Apple's App-Store-data-signing path specifically.
 */
export const APPLE_RECEIPT_SIGNER_OID = "1.2.840.113635.100.6.11.1";
export const APPLE_WWDR_INTERMEDIATE_OID = "1.2.840.113635.100.6.2.1";

/**
 * The most certificates a chain may carry. Apple sends three. The cap exists because every link costs a
 * signature verification, and the chain arrives in an unauthenticated request — an attacker who can make us
 * verify an unbounded chain has found a way to spend our CPU for the price of one POST.
 */
const MAX_CHAIN_LENGTH = 10;

/** One certificate extension: whether it was marked critical, and its own DER. */
export interface CertificateExtension {
  critical: boolean;
  value: Uint8Array;
}

/** `basicConstraints`, decoded. Absent from a certificate means "not a CA" (the ASN.1 default for `cA`). */
export interface BasicConstraints {
  ca: boolean;
  pathLen?: number;
}

/** One parsed certificate — only the fields a chain check needs, and nothing else. */
export interface ParsedCertificate {
  /** The whole certificate's DER, for byte-comparing against a pinned root. */
  der: Uint8Array;
  /** The `tbsCertificate` as encoded, tag and length included — exactly the bytes the issuer signed. */
  tbs: Uint8Array;
  /** The issuer Name's DER, compared against the next certificate's subject to link the chain. */
  issuer: Uint8Array;
  /** The subject Name's DER. */
  subject: Uint8Array;
  /** When the certificate becomes valid. */
  notBefore: Date;
  /** When it stops being valid. */
  notAfter: Date;
  /** The SubjectPublicKeyInfo, ready for `crypto.subtle.importKey("spki", …)`. */
  spki: Uint8Array;
  /** The curve the subject's key is on. */
  curve: "P-256" | "P-384";
  /** The OID of the algorithm the issuer signed this certificate with. */
  signatureAlgorithm: string;
  /** The signature value — a DER `SEQUENCE { INTEGER r, INTEGER s }`. */
  signature: Uint8Array;
  /** Every extension, by OID. Unknown ones are kept rather than refused; only the checked ones are decoded. */
  extensions: Map<string, CertificateExtension>;
  /** `basicConstraints`, or undefined when the certificate carries none — which means it is not a CA. */
  basicConstraints?: BasicConstraints;
  /** Whether `keyUsage` is present and grants `keyCertSign`; undefined when the extension is absent. */
  keyCertSign?: boolean;
}

/** A leaf's verifying key and the curve it is on. The curve is returned because ES256 requires P-256. */
export interface VerifiedLeaf {
  key: CryptoKey;
  curve: "P-256" | "P-384";
}

/** What the chain check needs: which roots to trust, and the clock to judge validity against. */
export interface VerifyChainOptions {
  /** base64 DER of every acceptable root. The chain's last certificate must equal one of them. */
  roots: readonly string[];
  /** The clock. Injected, so a validity refusal is deterministic. */
  now: Date;
  /**
   * An extension OID the leaf must carry. Defaults to {@link APPLE_RECEIPT_SIGNER_OID}. Pass `null` only
   * where a chain genuinely is not Apple's App-Store-signing chain — there is no such caller in the package,
   * and the option exists so the requirement is visible at the boundary rather than buried.
   */
  requiredLeafExtension?: string | null;
  /** An extension OID the leaf's issuer must carry. Defaults to {@link APPLE_WWDR_INTERMEDIATE_OID}. */
  requiredIssuerExtension?: string | null;
}

function malformed(detail: string): PaymentsInvalidReceiptError {
  return new PaymentsInvalidReceiptError({ detail });
}

/** A well-formed chain that does not verify. The public message never says which link failed. */
function rejected(detail: string): PaymentsVerificationFailedError {
  return new PaymentsVerificationFailedError({
    message: "That purchase could not be verified.",
    action: "Retry. If it persists, the store's signing certificates may have changed — update the package.",
    detail,
  });
}

/** An X.509 `Time`, which is a UTCTime before 2050 and a GeneralizedTime after it. */
function readTime(node: Asn1Node): Date {
  const text = new TextDecoder().decode(node.value);
  if (node.tag === ASN1_UTC_TIME) {
    if (!/^\d{12}Z$/.test(text)) throw malformed(`X.509: malformed UTCTime "${text}".`);
    const twoDigitYear = Number(text.slice(0, 2));
    // RFC 5280: 50–99 is 19xx, 00–49 is 20xx.
    const year = twoDigitYear >= 50 ? 1900 + twoDigitYear : 2000 + twoDigitYear;
    return new Date(
      `${year}-${text.slice(2, 4)}-${text.slice(4, 6)}T${text.slice(6, 8)}:${text.slice(8, 10)}:${text.slice(10, 12)}Z`,
    );
  }
  if (node.tag === ASN1_GENERALIZED_TIME) {
    if (!/^\d{14}Z$/.test(text)) throw malformed(`X.509: malformed GeneralizedTime "${text}".`);
    return new Date(
      `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}T${text.slice(8, 10)}:${text.slice(10, 12)}:${text.slice(12, 14)}Z`,
    );
  }
  throw malformed(`X.509: tag 0x${node.tag.toString(16)} is not a Time.`);
}

/** The curve named in a SubjectPublicKeyInfo's algorithm parameters. */
function readCurve(spki: Asn1Node): "P-256" | "P-384" {
  const algorithm = asn1Children(spki)[0];
  if (!algorithm) throw malformed("X.509: SubjectPublicKeyInfo has no algorithm.");
  const parameters = asn1Children(algorithm)[1];
  if (!parameters) throw malformed("X.509: the subject key names no curve — only ECDSA keys are accepted.");
  const curve = CURVES[readOid(parameters)];
  if (!curve) throw malformed(`X.509: curve ${readOid(parameters)} is not one this verifier accepts.`);
  return curve;
}

/**
 * The extensions of a tbsCertificate, by OID.
 *
 * `extensions` is `[3] EXPLICIT Extensions OPTIONAL`, the last field, and each `Extension` is
 * `SEQUENCE { extnID OID, critical BOOLEAN DEFAULT FALSE, extnValue OCTET STRING }`. A repeated OID is
 * refused: RFC 5280 forbids it, and a parser that kept the first while another kept the last would let one
 * certificate mean two things.
 */
function readExtensions(fields: readonly Asn1Node[]): Map<string, CertificateExtension> {
  const found = new Map<string, CertificateExtension>();
  const container = fields.find((field) => field.tag === 0xa3);
  if (!container) return found;
  const [list] = asn1Children(container);
  if (!list || list.tag !== ASN1_SEQUENCE) throw malformed("X.509: extensions is not a SEQUENCE.");
  for (const extension of asn1Children(list)) {
    const parts = asn1Children(extension);
    const [id] = parts;
    if (!id) throw malformed("X.509: an extension has no OID.");
    const oid = readOid(id);
    // `critical` is optional, so the value is whichever OCTET STRING is present rather than a fixed index.
    const critical = parts[1]?.tag === ASN1_BOOLEAN ? readBoolean(parts[1]) : false;
    const value = parts.find((part, index) => index > 0 && part.tag === ASN1_OCTET_STRING);
    if (!value) throw malformed(`X.509: extension ${oid} has no value.`);
    if (found.has(oid)) throw malformed(`X.509: extension ${oid} appears twice.`);
    found.set(oid, { critical, value: value.value });
  }
  return found;
}

/** `basicConstraints ::= SEQUENCE { cA BOOLEAN DEFAULT FALSE, pathLenConstraint INTEGER OPTIONAL }`. */
function readBasicConstraints(extension: CertificateExtension): BasicConstraints {
  const { node } = readAsn1(extension.value);
  if (node.tag !== ASN1_SEQUENCE) throw malformed("X.509: basicConstraints is not a SEQUENCE.");
  const parts = asn1Children(node);
  // Both members are optional, and an empty SEQUENCE is the encoding of `cA` at its default of false.
  const ca = parts[0]?.tag === ASN1_BOOLEAN ? readBoolean(parts[0]) : false;
  const lengthNode = parts.find((part) => part.tag === ASN1_INTEGER);
  return lengthNode ? { ca, pathLen: readInteger(lengthNode) } : { ca };
}

/** Whether `keyUsage` grants `keyCertSign`. A short BIT STRING simply does not reach the bit. */
function readKeyCertSign(extension: CertificateExtension): boolean {
  const { node } = readAsn1(extension.value);
  return readBits(node)[KEY_CERT_SIGN_BIT] === true;
}

/**
 * Parse one DER certificate.
 *
 * `Certificate ::= SEQUENCE { tbsCertificate, signatureAlgorithm, signatureValue }`, and inside the tbs,
 * `SEQUENCE { [0] version, serialNumber, signature, issuer, validity, subject, subjectPublicKeyInfo, … }`.
 * The version field is optional, so the fields after it are located by counting from the end of whichever
 * prefix is present rather than by fixed index.
 */
export function parseCertificate(der: Uint8Array): ParsedCertificate {
  const { node: certificate } = readAsn1(der);
  if (certificate.tag !== ASN1_SEQUENCE) throw malformed("X.509: a certificate must be a SEQUENCE.");
  const [tbs, algorithm, signature] = asn1Children(certificate);
  if (!tbs || !algorithm || !signature) throw malformed("X.509: a certificate has three members.");

  const fields = asn1Children(tbs);
  // `[0] EXPLICIT Version` is optional and tagged 0xa0; without it the certificate is a v1 and
  // serialNumber comes first. Everything after is positional from there.
  const offset = fields[0]?.tag === 0xa0 ? 1 : 0;
  const issuer = fields[offset + 2];
  const validity = fields[offset + 3];
  const subject = fields[offset + 4];
  const spki = fields[offset + 5];
  if (!issuer || !validity || !subject || !spki) throw malformed("X.509: tbsCertificate is missing fields.");

  const [notBefore, notAfter] = asn1Children(validity);
  if (!notBefore || !notAfter) throw malformed("X.509: validity needs both bounds.");

  const extensions = readExtensions(fields);
  const constraints = extensions.get(OID_BASIC_CONSTRAINTS);
  const usage = extensions.get(OID_KEY_USAGE);

  return {
    der,
    tbs: tbs.der,
    issuer: issuer.der,
    subject: subject.der,
    notBefore: readTime(notBefore),
    notAfter: readTime(notAfter),
    spki: spki.der,
    curve: readCurve(spki),
    signatureAlgorithm: readOid(asn1Children(algorithm)[0] ?? algorithm),
    // A BIT STRING's first contents byte counts unused trailing bits; for a signature it is always zero.
    signature: signature.value.subarray(1),
    extensions,
    basicConstraints: constraints ? readBasicConstraints(constraints) : undefined,
    keyCertSign: usage ? readKeyCertSign(usage) : undefined,
  };
}

/** Import a certificate's public key for verification. */
async function importKey(certificate: ParsedCertificate): Promise<CryptoKey> {
  try {
    return await crypto.subtle.importKey(
      "spki",
      certificate.spki as unknown as ArrayBuffer,
      { name: "ECDSA", namedCurve: certificate.curve },
      false,
      ["verify"],
    );
  } catch (cause) {
    throw new PaymentsInvalidReceiptError(
      { detail: `X.509: the ${certificate.curve} public key could not be imported.` },
      { cause },
    );
  }
}

/** Whether `issuer` signed `certificate`. */
async function signedBy(certificate: ParsedCertificate, issuer: ParsedCertificate): Promise<boolean> {
  const hash = SIGNATURE_HASHES[certificate.signatureAlgorithm];
  if (!hash) throw rejected(`X.509: signature algorithm ${certificate.signatureAlgorithm} is not accepted.`);
  const raw = derSignatureToRaw(certificate.signature, COORDINATE_BYTES[issuer.curve]);
  return crypto.subtle.verify(
    { name: "ECDSA", hash },
    await importKey(issuer),
    raw as unknown as ArrayBuffer,
    certificate.tbs as unknown as ArrayBuffer,
  );
}

/**
 * Verify a certificate chain — leaf first, root last, the order `x5c` uses — and return the leaf's
 * verifying key. Throws rather than returning a boolean: there is no caller that wants to carry on with an
 * unverified chain, and a boolean invites one.
 */
export async function verifyCertificateChain(
  chain: readonly Uint8Array[],
  options: VerifyChainOptions,
): Promise<VerifiedLeaf> {
  // Two is the minimum that can be checked at all: a lone certificate would be trusted on its own word.
  if (chain.length < 2) throw rejected(`X.509: a chain of ${chain.length} cannot be verified; leaf and root at least.`);
  // Bounded before anything is parsed, so an oversized chain costs one length check rather than N signature
  // verifications. The chain arrives unauthenticated; this is the only thing standing between that and our CPU.
  if (chain.length > MAX_CHAIN_LENGTH) {
    throw rejected(`X.509: a chain of ${chain.length} is longer than the ${MAX_CHAIN_LENGTH} accepted.`);
  }

  const certificates = chain.map((der) => parseCertificate(der));
  const at = options.now.getTime();
  for (const [index, certificate] of certificates.entries()) {
    if (at < certificate.notBefore.getTime() || at > certificate.notAfter.getTime()) {
      throw rejected(
        `X.509: certificate ${index} is valid ${certificate.notBefore.toISOString()}–${certificate.notAfter.toISOString()}.`,
      );
    }
  }

  const root = certificates[certificates.length - 1] as ParsedCertificate;
  const pinned = options.roots.some((encoded) => bytesEqual(decodeBase64(encoded), root.der));
  if (!pinned) throw rejected("X.509: the chain's root is not one of the pinned roots.");

  /**
   * Every certificate above the leaf must be entitled to issue the one below it.
   *
   * This is the check whose absence makes the rest decorative. A chain of
   * `[forged, someAppleLeaf, intermediate, root]` links, sits inside every window, and roots in the pinned
   * certificate — so without `cA` anyone holding any ECDSA certificate issued under Apple's root could sign
   * `forged` and be believed. `pathLenConstraint` is the same rule stated as a depth: a CA that says "no
   * intermediates beneath me" must not have any.
   */
  for (let index = 1; index < certificates.length; index += 1) {
    const authority = certificates[index] as ParsedCertificate;
    if (authority.basicConstraints?.ca !== true) {
      throw rejected(`X.509: certificate ${index} issued the one below it but is not a CA (basicConstraints).`);
    }
    if (authority.keyCertSign === false) {
      throw rejected(`X.509: certificate ${index} issued the one below it but its keyUsage omits keyCertSign.`);
    }
    // Certificates below this one that are themselves CAs — indices 1..index-1.
    const intermediatesBelow = index - 1;
    const { pathLen } = authority.basicConstraints;
    if (pathLen !== undefined && intermediatesBelow > pathLen) {
      throw rejected(
        `X.509: certificate ${index} permits ${pathLen} intermediates beneath it, the chain has ${intermediatesBelow}.`,
      );
    }
  }

  for (let index = 0; index < certificates.length - 1; index += 1) {
    const certificate = certificates[index] as ParsedCertificate;
    const issuer = certificates[index + 1] as ParsedCertificate;
    if (!bytesEqual(certificate.issuer, issuer.subject)) {
      throw rejected(`X.509: certificate ${index}'s issuer name does not match certificate ${index + 1}'s subject.`);
    }
    if (!(await signedBy(certificate, issuer))) {
      throw rejected(`X.509: certificate ${index} was not signed by certificate ${index + 1}.`);
    }
  }

  const leaf = certificates[0] as ParsedCertificate;
  // The identity half. Rooting in Apple's CA proves the path is Apple's; these prove it is the path Apple
  // signs App Store data with, so a genuine Apple certificate issued for anything else cannot stand in.
  const leafExtension =
    options.requiredLeafExtension === undefined ? APPLE_RECEIPT_SIGNER_OID : options.requiredLeafExtension;
  if (leafExtension !== null && !leaf.extensions.has(leafExtension)) {
    throw rejected(`X.509: the leaf does not carry ${leafExtension}, so it is not an App Store signing certificate.`);
  }
  const issuerExtension =
    options.requiredIssuerExtension === undefined ? APPLE_WWDR_INTERMEDIATE_OID : options.requiredIssuerExtension;
  const issuer = certificates[1] as ParsedCertificate;
  if (issuerExtension !== null && !issuer.extensions.has(issuerExtension)) {
    throw rejected(`X.509: the leaf's issuer does not carry ${issuerExtension}, so it is not the WWDR intermediate.`);
  }

  return { key: await importKey(leaf), curve: leaf.curve };
}
