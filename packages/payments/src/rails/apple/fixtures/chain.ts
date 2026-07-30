// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * Test material: a real X.509 certificate chain and real JWS signatures, minted at test time.
 *
 * Verifying Apple's signature is the security boundary on the webhook route, so its tests must exercise
 * genuine cryptography — a stubbed verifier proves nothing about the one thing that matters. No test may
 * reach a live store either. So the tests mint their own chain here with WebCrypto and sign real
 * certificates with it: leaf ← intermediate ← root, the shape Apple's `x5c` carries, with the root pinned
 * into the verifier the way `APPLE_ROOT_CERTIFICATES` is pinned in production.
 *
 * That makes the negative cases real too. A chain rooted elsewhere is a second minted root the verifier was
 * never given. An expired leaf is a leaf minted with a past `notAfter`. A tampered body is a byte changed
 * after signing. None of them is a mock refusing on command.
 *
 * This file is a DER **encoder** and the only one in the package — the shipped code reads certificates and
 * never writes them, and that asymmetry is deliberate. It lives under `fixtures/` for the same reason the
 * recorded notification payloads do: it is test input, not product.
 */

/** The curves the minter and Apple's own chain use: P-256 for a leaf, P-384 for a CA. */
export type TestCurve = "P-256" | "P-384";

/** One minted certificate: its DER, its key pair, and the name it was issued to. */
interface MintedCertificate {
  der: Uint8Array;
  publicKey: CryptoKey;
  privateKey: CryptoKey;
  /** The DER of the subject Name, which the certificate it issues carries as its issuer. */
  subject: Uint8Array;
}

/** A minted chain, in the order a JWS `x5c` header carries it. */
export interface MintedChain {
  /** base64 DER, leaf first, root last. */
  x5c: string[];
  /** The leaf's private key — what signs a JWS. */
  leafKey: CryptoKey;
  /** base64 DER of the root, for pinning into the verifier under test. */
  root: string;
}

/** How a caller bends the chain: shift a validity window, or change a curve. */
export interface MintChainOptions {
  /** The leaf's validity window. Defaults to a year either side of now. */
  leafNotBefore?: Date;
  leafNotAfter?: Date;
  /** The intermediate's validity window. Defaults to the same. */
  intermediateNotBefore?: Date;
  intermediateNotAfter?: Date;
  /** The leaf's curve. P-256 is what ES256 requires; P-384 is how algorithm confusion is tested. */
  leafCurve?: TestCurve;
  /** A distinguishing name, so two chains minted in one test are told apart. */
  label?: string;
  /**
   * Mint the intermediate without `basicConstraints` CA:TRUE — as an ordinary leaf certificate would be.
   * This is the shape of the attack the CA check exists to refuse: any certificate Apple issued, used to
   * sign a certificate of the attacker's own.
   */
  intermediateNotCa?: boolean;
  /** Mint the intermediate with `keyUsage` present but `keyCertSign` cleared. */
  intermediateWithoutKeyCertSign?: boolean;
  /** `pathLenConstraint` on the intermediate, so a chain deeper than it permits can be minted. */
  intermediatePathLen?: number;
  /** Omit Apple's receipt-signer marker from the leaf. */
  leafWithoutSignerOid?: boolean;
  /** Omit Apple's WWDR marker from the intermediate. */
  intermediateWithoutWwdrOid?: boolean;
  /** Mint a fourth certificate between the leaf and the intermediate, for the depth cases. */
  extraIntermediate?: boolean;
}

const OID_COMMON_NAME = "2.5.4.3";
const OID_ECDSA_SHA256 = "1.2.840.10045.4.3.2";
const OID_ECDSA_SHA384 = "1.2.840.10045.4.3.3";
const OID_BASIC_CONSTRAINTS = "2.5.29.19";
const OID_KEY_USAGE = "2.5.29.15";
/** Apple's published marker OIDs — the same two `x509.ts` requires. */
const OID_APPLE_RECEIPT_SIGNER = "1.2.840.113635.100.6.11.1";
const OID_APPLE_WWDR = "1.2.840.113635.100.6.2.1";

/** Tag-length-value. Long-form length whenever the contents need it, exactly as DER requires. */
function tlv(tag: number, contents: Uint8Array): Uint8Array {
  if (contents.length < 0x80) return new Uint8Array([tag, contents.length, ...contents]);
  const lengthBytes: number[] = [];
  let remaining = contents.length;
  while (remaining > 0) {
    lengthBytes.unshift(remaining & 0xff);
    remaining = Math.floor(remaining / 256);
  }
  return new Uint8Array([tag, 0x80 | lengthBytes.length, ...lengthBytes, ...contents]);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const sequence = (...parts: Uint8Array[]): Uint8Array => tlv(0x30, concat(...parts));
const set = (...parts: Uint8Array[]): Uint8Array => tlv(0x31, concat(...parts));
const utf8String = (text: string): Uint8Array => tlv(0x0c, new TextEncoder().encode(text));
const bitString = (bytes: Uint8Array): Uint8Array => tlv(0x03, concat(new Uint8Array([0x00]), bytes));
const explicit = (index: number, contents: Uint8Array): Uint8Array => tlv(0xa0 | index, contents);
const octetString = (bytes: Uint8Array): Uint8Array => tlv(0x04, bytes);
/** DER admits only 0x00 and 0xff for a BOOLEAN, and the reader under test enforces exactly that. */
const boolean = (value: boolean): Uint8Array => tlv(0x01, new Uint8Array([value ? 0xff : 0x00]));

/** `Extension ::= SEQUENCE { extnID, critical DEFAULT FALSE, extnValue OCTET STRING }`. */
function extension(id: string, value: Uint8Array, critical = false): Uint8Array {
  const parts = critical ? [oid(id), boolean(true), octetString(value)] : [oid(id), octetString(value)];
  return sequence(...parts);
}

/** `BasicConstraints ::= SEQUENCE { cA BOOLEAN DEFAULT FALSE, pathLenConstraint INTEGER OPTIONAL }`. */
function basicConstraints(ca: boolean, pathLen?: number): Uint8Array {
  const members: Uint8Array[] = [];
  // `cA` at its default is encoded by omission, which is the shape an ordinary leaf certificate has.
  if (ca) members.push(boolean(true));
  if (pathLen !== undefined) members.push(integer(pathLen));
  return extension(OID_BASIC_CONSTRAINTS, sequence(...members), true);
}

/**
 * `keyUsage`, as the bits a CA needs. `digitalSignature` is bit 0 and `keyCertSign` bit 5, so a CA's byte is
 * `0b00000100` with two unused trailing bits and a leaf's is `0b10000000` with seven.
 */
function keyUsage(keyCertSign: boolean): Uint8Array {
  const bytes = keyCertSign ? new Uint8Array([0x02, 0x04]) : new Uint8Array([0x07, 0x80]);
  return extension(OID_KEY_USAGE, tlv(0x03, bytes), true);
}

/** A positive INTEGER, with DER's leading zero when the high bit would read as a sign. */
function integer(value: number): Uint8Array {
  const bytes: number[] = [];
  let remaining = value;
  do {
    bytes.unshift(remaining & 0xff);
    remaining = Math.floor(remaining / 256);
  } while (remaining > 0);
  if ((bytes[0] as number) & 0x80) bytes.unshift(0x00);
  return tlv(0x02, new Uint8Array(bytes));
}

function oid(dotted: string): Uint8Array {
  const arcs = dotted.split(".").map(Number);
  const bytes: number[] = [40 * (arcs[0] as number) + (arcs[1] as number)];
  for (const arc of arcs.slice(2)) {
    const base128: number[] = [arc & 0x7f];
    let remaining = Math.floor(arc / 128);
    while (remaining > 0) {
      base128.unshift((remaining & 0x7f) | 0x80);
      remaining = Math.floor(remaining / 128);
    }
    bytes.push(...base128);
  }
  return tlv(0x06, new Uint8Array(bytes));
}

/** UTCTime, `YYMMDDHHMMSSZ` — the encoding X.509 uses for any year before 2050. */
function utcTime(when: Date): Uint8Array {
  const iso = when.toISOString();
  const text = `${iso.slice(2, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
  return tlv(0x17, new TextEncoder().encode(text));
}

/** A Name carrying one common name — enough to link a chain, which matches issuer against subject. */
const name = (commonName: string): Uint8Array => sequence(set(sequence(oid(OID_COMMON_NAME), utf8String(commonName))));

/** WebCrypto's fixed-width `r || s` as the `SEQUENCE { INTEGER r, INTEGER s }` X.509 carries. */
function rawSignatureToDer(raw: Uint8Array): Uint8Array {
  const half = raw.length / 2;
  const parts = [raw.subarray(0, half), raw.subarray(half)].map((coordinate) => {
    let value = coordinate;
    while (value.length > 1 && value[0] === 0) value = value.subarray(1);
    const bytes = (value[0] as number) & 0x80 ? concat(new Uint8Array([0x00]), value) : value;
    return tlv(0x02, bytes);
  });
  return sequence(...parts);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** base64url without padding — how every segment of a JWS is encoded. */
export function base64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function generateKeyPair(curve: TestCurve): Promise<CryptoKeyPair> {
  // `generateKey`'s return type is the union of both its overloads under the Workers types, and an EC
  // algorithm always yields a pair. Narrowed once here rather than at each of the three call sites.
  return (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: curve }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
}

/**
 * Mint one certificate. `issuer` is undefined for a self-signed root, in which case the certificate names
 * and signs itself the way a real root does.
 */
async function mintCertificate(options: {
  commonName: string;
  curve: TestCurve;
  notBefore: Date;
  notAfter: Date;
  issuer?: MintedCertificate;
  issuerHash: "SHA-256" | "SHA-384";
  serial: number;
  /** The extensions to put in `[3] EXPLICIT Extensions`. Omitted entirely when empty, as a v1 would be. */
  extensions?: Uint8Array[];
}): Promise<MintedCertificate> {
  const { publicKey, privateKey } = await generateKeyPair(options.curve);
  // `exportKey`'s type is the union over every format; `spki` is always an ArrayBuffer.
  const spki = new Uint8Array((await crypto.subtle.exportKey("spki", publicKey)) as ArrayBuffer);
  const subject = name(options.commonName);
  const algorithm = sequence(oid(options.issuerHash === "SHA-384" ? OID_ECDSA_SHA384 : OID_ECDSA_SHA256));
  const extensions = options.extensions ?? [];

  const tbs = sequence(
    explicit(0, integer(2)),
    integer(options.serial),
    algorithm,
    options.issuer?.subject ?? subject,
    sequence(utcTime(options.notBefore), utcTime(options.notAfter)),
    subject,
    spki,
    ...(extensions.length > 0 ? [explicit(3, sequence(...extensions))] : []),
  );
  const signingKey = options.issuer?.privateKey ?? privateKey;
  const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: options.issuerHash }, signingKey, tbs));
  const der = sequence(tbs, algorithm, bitString(rawSignatureToDer(raw)));
  return { der, publicKey, privateKey, subject };
}

/**
 * Mint a three-certificate chain shaped like Apple's: P-256 leaf ← P-384 intermediate ← P-384 root.
 *
 * The default mint is a chain the verifier accepts, which means it carries what a real Apple chain carries:
 * `basicConstraints` CA:TRUE on the root and intermediate, `keyUsage` with `keyCertSign` on both, and Apple's
 * two marker OIDs. Every `MintChainOptions` flag that removes one of those exists so a test can prove the
 * corresponding refusal is real rather than assumed.
 */
export async function mintChain(options: MintChainOptions = {}): Promise<MintedChain> {
  const year = 365 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const label = options.label ?? "pithy";

  const root = await mintCertificate({
    commonName: `${label} test root`,
    curve: "P-384",
    notBefore: new Date(now - year),
    notAfter: new Date(now + year),
    issuerHash: "SHA-384",
    serial: 1,
    extensions: [basicConstraints(true), keyUsage(true)],
  });

  const intermediateExtensions: Uint8Array[] = [];
  // A non-CA intermediate is minted the way an ordinary leaf is: `basicConstraints` absent altogether, which
  // is `cA` at its ASN.1 default of false. That is exactly the certificate an attacker would already hold.
  if (!options.intermediateNotCa) {
    intermediateExtensions.push(basicConstraints(true, options.intermediatePathLen));
  }
  intermediateExtensions.push(keyUsage(!options.intermediateWithoutKeyCertSign));
  if (!options.intermediateWithoutWwdrOid) {
    intermediateExtensions.push(extension(OID_APPLE_WWDR, sequence()));
  }
  const intermediate = await mintCertificate({
    commonName: `${label} test intermediate`,
    curve: "P-384",
    notBefore: options.intermediateNotBefore ?? new Date(now - year),
    notAfter: options.intermediateNotAfter ?? new Date(now + year),
    issuer: root,
    issuerHash: "SHA-384",
    serial: 2,
    extensions: intermediateExtensions,
  });

  // A second CA between the leaf and the intermediate, so a `pathLenConstraint` of 0 has something to refuse.
  const extra = options.extraIntermediate
    ? await mintCertificate({
        commonName: `${label} test sub-intermediate`,
        curve: "P-384",
        notBefore: new Date(now - year),
        notAfter: new Date(now + year),
        issuer: intermediate,
        issuerHash: "SHA-384",
        serial: 4,
        extensions: [basicConstraints(true), keyUsage(true), extension(OID_APPLE_WWDR, sequence())],
      })
    : undefined;

  const leafExtensions: Uint8Array[] = [keyUsage(false)];
  if (!options.leafWithoutSignerOid) leafExtensions.push(extension(OID_APPLE_RECEIPT_SIGNER, sequence()));
  const leaf = await mintCertificate({
    commonName: `${label} test leaf`,
    curve: options.leafCurve ?? "P-256",
    notBefore: options.leafNotBefore ?? new Date(now - year),
    notAfter: options.leafNotAfter ?? new Date(now + year),
    issuer: extra ?? intermediate,
    issuerHash: "SHA-384",
    serial: 3,
    extensions: leafExtensions,
  });

  const chain = extra ? [leaf.der, extra.der, intermediate.der, root.der] : [leaf.der, intermediate.der, root.der];
  return {
    x5c: chain.map(bytesToBase64),
    leafKey: leaf.privateKey,
    root: bytesToBase64(root.der),
  };
}

/**
 * Sign a compact JWS the way Apple does: an `ES256` header carrying the chain in `x5c`, the payload, and a
 * P-256 signature over `header.payload`.
 *
 * `header` overrides let a test present a header Apple never would — `alg: "none"`, a missing `x5c`, an
 * `HS256` claim over an EC signature — which is how algorithm confusion is proved rejected rather than
 * assumed impossible.
 */
export async function signJws(
  payload: unknown,
  chain: MintedChain,
  header: Record<string, unknown> = {},
  hash: "SHA-256" | "SHA-384" = "SHA-256",
): Promise<string> {
  const encoder = new TextEncoder();
  const head = base64Url(encoder.encode(JSON.stringify({ alg: "ES256", x5c: chain.x5c, ...header })));
  const body = base64Url(encoder.encode(JSON.stringify(payload)));
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash }, chain.leafKey, encoder.encode(`${head}.${body}`)),
  );
  return `${head}.${body}.${base64Url(signature)}`;
}

/** A compact JWS with its payload swapped for another, keeping the original signature. The tamper case. */
export function tamperPayload(jws: string, payload: unknown): string {
  const [head, , signature] = jws.split(".");
  return `${head}.${base64Url(new TextEncoder().encode(JSON.stringify(payload)))}.${signature}`;
}

/**
 * A recorded notification, as the `*.json` files beside this module store one.
 *
 * The files hold **decoded** payloads, and this is why: Apple nests three independently-signed JWS inside
 * one notification, and a recorded signature can only ever be verified against Apple's real chain, which no
 * test may reach. So the recording keeps the payloads — redacted, but faithful to Apple's published
 * `responseBodyV2DecodedPayload`, `JWSTransactionDecodedPayload`, and `JWSRenewalInfoDecodedPayload` shapes
 * — and {@link signNotification} re-signs them with the minted chain. The shapes are the fixture; the
 * signatures are the test's own.
 */
export interface NotificationFixture {
  /** The notification payload, without the nested JWS fields — those are produced from the two below. */
  notification: Record<string, unknown> & { data?: Record<string, unknown> };
  /** The transaction payload, signed into `data.signedTransactionInfo`. Absent for a state-free type. */
  transaction?: Record<string, unknown>;
  /** The renewal payload, signed into `data.signedRenewalInfo`. Absent for a one-time purchase. */
  renewalInfo?: Record<string, unknown>;
}

/** Sign a recorded notification into the nested-JWS form Apple actually delivers. */
export async function signNotification(fixture: NotificationFixture, chain: MintedChain): Promise<string> {
  const data = fixture.notification.data;
  const signedData = data
    ? {
        ...data,
        ...(fixture.transaction ? { signedTransactionInfo: await signJws(fixture.transaction, chain) } : {}),
        ...(fixture.renewalInfo ? { signedRenewalInfo: await signJws(fixture.renewalInfo, chain) } : {}),
      }
    : undefined;
  return signJws({ ...fixture.notification, ...(signedData ? { data: signedData } : {}) }, chain);
}

/** A minted App Store Connect API key: the PKCS#8 PEM a `.p8` holds, and the public half to verify against. */
export interface MintedAppStoreKey {
  /** The private key in the exact PEM armour App Store Connect issues. */
  pem: string;
  /** The public half, so a test can verify a minted token rather than trust its shape. */
  publicKey: CryptoKey;
}

/**
 * Mint an App Store Connect API key.
 *
 * A real P-256 pair exported as PKCS#8 PEM, because that is exactly what a downloaded `.p8` is — so a suite
 * that mints a token with it and verifies it against the public half has proved Apple would have accepted
 * the token, rather than proved the string has three dots in it.
 */
export async function mintAppStoreKey(): Promise<MintedAppStoreKey> {
  // `generateKey`'s type is the union over every algorithm; an EC key is always a pair.
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const pkcs8 = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
  let binary = "";
  for (const byte of pkcs8) binary += String.fromCharCode(byte);
  const body = (btoa(binary).match(/.{1,64}/g) ?? []).join("\n");
  return { pem: `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`, publicKey: pair.publicKey };
}
