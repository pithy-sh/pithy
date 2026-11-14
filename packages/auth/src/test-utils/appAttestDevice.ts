// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { base64UrlEncode } from "@pithy-sh/core/src/controlPlane/token/base64url";

/**
 * A stand-in for Apple's App Attest service and a device's Secure Enclave, built on WebCrypto.
 *
 * It mints a root and an intermediate in the shape Apple's are (P-384, ECDSA with SHA-384), and per key a P-256
 * leaf signed with SHA-256 that carries the nonce extension `1.2.840.113635.100.8.2`, then the attestation object
 * and assertions exactly as `DCAppAttestService` returns them. A test trusts {@link AppAttestAuthority.root} in
 * place of Apple's, which is the only difference from a real device: every byte goes through the same reader.
 */

type Bytes = Uint8Array;

function concat(...parts: Bytes[]): Bytes {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function standardBase64(bytes: Bytes): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function sha256(...parts: Bytes[]): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", concat(...parts)));
}

// DER writer.

function tlv(tag: number, content: Bytes): Bytes {
  const length = content.length;
  const header =
    length < 0x80
      ? [length]
      : length < 0x100
        ? [0x81, length]
        : length < 0x10000
          ? [0x82, length >> 8, length & 0xff]
          : [0x83, length >> 16, (length >> 8) & 0xff, length & 0xff];
  return concat(new Uint8Array([tag, ...header]), content);
}
const seq = (...items: Bytes[]) => tlv(0x30, concat(...items));
const set = (...items: Bytes[]) => tlv(0x31, concat(...items));
const octets = (bytes: Bytes) => tlv(0x04, bytes);
const bits = (bytes: Bytes) => tlv(0x03, concat(new Uint8Array([0]), bytes));
const utf8 = (text: string) => tlv(0x0c, new TextEncoder().encode(text));

function integer(bytes: Bytes): Bytes {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start++;
  const digits = bytes.subarray(start);
  return tlv(0x02, (digits[0] as number) & 0x80 ? concat(new Uint8Array([0]), digits) : digits);
}

function oid(dotted: string): Bytes {
  const [first, second, ...rest] = dotted.split(".").map(Number) as number[];
  const out = [(first as number) * 40 + (second as number)];
  for (const arc of rest) {
    const chunk = [arc & 0x7f];
    for (let value = Math.floor(arc / 128); value > 0; value = Math.floor(value / 128))
      chunk.unshift((value & 0x7f) | 0x80);
    out.push(...chunk);
  }
  return tlv(0x06, new Uint8Array(out));
}

function time(date: Date): Bytes {
  const iso = date.toISOString();
  const text = `${iso.slice(2, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
  return tlv(0x17, new TextEncoder().encode(text));
}

const name = (commonName: string) =>
  seq(set(seq(oid("2.5.4.3"), utf8(commonName))), set(seq(oid("2.5.4.10"), utf8("Apple Inc."))));

const CURVE_OID = { "P-256": "1.2.840.10045.3.1.7", "P-384": "1.3.132.0.34" } as const;
const SIGNATURE_OID = { "SHA-256": "1.2.840.10045.4.3.2", "SHA-384": "1.2.840.10045.4.3.3" } as const;
const FIELD = { "P-256": 32, "P-384": 48 } as const;

type Curve = keyof typeof CURVE_OID;
type Hash = keyof typeof SIGNATURE_OID;

interface KeyPair {
  curve: Curve;
  privateKey: CryptoKey;
  point: Bytes;
}

async function keyPair(curve: Curve): Promise<KeyPair> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: curve }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const point = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  return { curve, privateKey: pair.privateKey, point };
}

/** An ECDSA signature, DER-encoded as X.509 and App Attest carry it. */
async function sign(key: KeyPair, hash: Hash, data: Bytes): Promise<Bytes> {
  const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash }, key.privateKey, data));
  const size = FIELD[key.curve];
  return seq(integer(raw.subarray(0, size)), integer(raw.subarray(size)));
}

interface CertificateSpec {
  serial: number;
  issuer: string;
  subject: string;
  subjectKey: KeyPair;
  signer: KeyPair;
  hash: Hash;
  notBefore: Date;
  notAfter: Date;
  ca: boolean;
  extensions?: Bytes[];
}

async function certificate(spec: CertificateSpec): Promise<Bytes> {
  const algorithm = seq(oid(SIGNATURE_OID[spec.hash]));
  const spki = seq(seq(oid("1.2.840.10045.2.1"), oid(CURVE_OID[spec.subjectKey.curve])), bits(spec.subjectKey.point));
  const extensions = [
    ...(spec.ca
      ? [seq(oid("2.5.29.19"), tlv(0x01, new Uint8Array([0xff])), octets(seq(tlv(0x01, new Uint8Array([0xff])))))]
      : []),
    ...(spec.extensions ?? []),
  ];
  const tbs = seq(
    tlv(0xa0, integer(new Uint8Array([2]))),
    integer(new Uint8Array([spec.serial >> 8, spec.serial & 0xff])),
    algorithm,
    name(spec.issuer),
    seq(time(spec.notBefore), time(spec.notAfter)),
    name(spec.subject),
    spki,
    ...(extensions.length > 0 ? [tlv(0xa3, seq(...extensions))] : []),
  );
  return seq(tbs, algorithm, bits(await sign(spec.signer, spec.hash, tbs)));
}

// CBOR writer.

type CborIn = number | string | Bytes | CborIn[] | Map<CborIn, CborIn>;

function cborHead(major: number, value: number): Bytes {
  if (value < 24) return new Uint8Array([(major << 5) | value]);
  if (value < 0x100) return new Uint8Array([(major << 5) | 24, value]);
  if (value < 0x10000) return new Uint8Array([(major << 5) | 25, value >> 8, value & 0xff]);
  return new Uint8Array([(major << 5) | 26, value >>> 24, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]);
}

function cbor(value: CborIn): Bytes {
  if (typeof value === "number") return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);
  if (typeof value === "string") {
    const bytes = new TextEncoder().encode(value);
    return concat(cborHead(3, bytes.length), bytes);
  }
  if (value instanceof Uint8Array) return concat(cborHead(2, value.length), value);
  if (Array.isArray(value)) return concat(cborHead(4, value.length), ...value.map(cbor));
  return concat(cborHead(5, value.size), ...[...value.entries()].flatMap(([k, v]) => [cbor(k), cbor(v)]));
}

function uint32(value: number): Bytes {
  return new Uint8Array([value >>> 24, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]);
}

const AAGUID = {
  production: concat(new TextEncoder().encode("appattest"), new Uint8Array(7)),
  development: new TextEncoder().encode("appattestdevelop"),
};

/** What to put in one attestation. Each override breaks the one field a refusal test is about. */
export interface AttestOptions {
  /** `<TeamID>.<bundleId>`, hashed into the authenticator data's `rpIdHash`. */
  appId: string;
  /** What the app passed to `attestKey`. */
  clientDataHash: Bytes;
  environment?: "production" | "development";
  /** The authenticator data's counter. Apple's is always 0. */
  counter?: number;
  /** A nonce to write into the leaf in place of the right one. */
  nonce?: Bytes;
  /** A credential id to write in place of the key id. */
  credentialId?: Bytes;
  /** Leaf validity, defaulting to an hour either side of the authority's `now`. */
  notBefore?: Date;
  notAfter?: Date;
}

/** One attested key. */
export interface AttestedKey {
  /** The key id as `generateKey` hands it over: standard base64 of SHA-256 over the public point. */
  keyId: string;
  /** The attestation object as `attestKey` hands it over: standard base64. */
  attestation: string;
  /** The raw public point. */
  publicKey: Bytes;
  /** An assertion over `clientDataHash`, as `generateAssertion` hands it over: standard base64. */
  assert(options: { appId: string; clientDataHash: Bytes; counter: number }): Promise<string>;
}

/** A key generated in the fake Secure Enclave and not yet attested, as `generateKey` leaves it. */
export interface GeneratedKey {
  /** The key id as `generateKey` hands it over: standard base64 of SHA-256 over the public point. */
  keyId: string;
  /** The raw public point. */
  publicKey: Bytes;
  /** Apple's attestation of this key, as `attestKey` hands it over: standard base64. */
  attest(options: AttestOptions): Promise<string>;
  /** An assertion over `clientDataHash`, as `generateAssertion` hands it over: standard base64. */
  assert(options: { appId: string; clientDataHash: Bytes; counter: number }): Promise<string>;
}

/** A fake App Attest service. */
export interface AppAttestAuthority {
  /** The root to trust in place of Apple's, DER. */
  root: Bytes;
  /** Generate a key and attest to it. */
  attest(options: AttestOptions): Promise<AttestedKey>;
  /** Generate a key, to attest later: the two steps a device takes, `generateKey` then `attestKey`. */
  generate(): Promise<GeneratedKey>;
}

/** Stand up a fake App Attest service whose certificates are valid around `now`. */
export async function appAttestAuthority(options: { now?: Date } = {}): Promise<AppAttestAuthority> {
  const now = options.now ?? new Date();
  const hours = (n: number) => new Date(now.getTime() + n * 3_600_000);
  const rootKey = await keyPair("P-384");
  const intermediateKey = await keyPair("P-384");
  const rootName = "Test App Attestation Root CA";
  const intermediateName = "Test App Attestation CA 1";
  const root = await certificate({
    serial: 1,
    issuer: rootName,
    subject: rootName,
    subjectKey: rootKey,
    signer: rootKey,
    hash: "SHA-384",
    notBefore: hours(-24 * 365),
    notAfter: hours(24 * 365 * 20),
    ca: true,
  });
  const intermediate = await certificate({
    serial: 2,
    issuer: rootName,
    subject: intermediateName,
    subjectKey: intermediateKey,
    signer: rootKey,
    hash: "SHA-384",
    notBefore: hours(-24 * 365),
    notAfter: hours(24 * 365 * 10),
    ca: true,
  });

  async function generate(): Promise<GeneratedKey> {
    const key = await keyPair("P-256");
    const keyId = await sha256(key.point);
    return {
      keyId: standardBase64(keyId),
      publicKey: key.point,
      async attest(spec) {
        const authData = concat(
          await sha256(new TextEncoder().encode(spec.appId)),
          new Uint8Array([0x40]),
          uint32(spec.counter ?? 0),
          AAGUID[spec.environment ?? "production"],
          new Uint8Array([0, (spec.credentialId ?? keyId).length]),
          spec.credentialId ?? keyId,
          cbor(
            new Map<CborIn, CborIn>([
              [1, 2],
              [3, -7],
              [-1, 1],
              [-2, key.point.subarray(1, 33)],
              [-3, key.point.subarray(33)],
            ]),
          ),
        );
        const nonce = spec.nonce ?? (await sha256(authData, spec.clientDataHash));
        const leaf = await certificate({
          serial: 3,
          issuer: intermediateName,
          subject: Array.from(keyId, (byte) => byte.toString(16).padStart(2, "0")).join(""),
          subjectKey: key,
          signer: intermediateKey,
          hash: "SHA-256",
          notBefore: spec.notBefore ?? hours(-1),
          notAfter: spec.notAfter ?? hours(72),
          ca: false,
          extensions: [seq(oid("1.2.840.113635.100.8.2"), octets(seq(tlv(0xa1, octets(nonce)))))],
        });
        return standardBase64(
          cbor(
            new Map<CborIn, CborIn>([
              ["fmt", "apple-appattest"],
              [
                "attStmt",
                new Map<CborIn, CborIn>([
                  ["x5c", [leaf, intermediate]],
                  ["receipt", new Uint8Array([1, 2, 3])],
                ]),
              ],
              ["authData", authData],
            ]),
          ),
        );
      },
      async assert({ appId, clientDataHash, counter }) {
        const authenticatorData = concat(
          await sha256(new TextEncoder().encode(appId)),
          new Uint8Array([0x40]),
          uint32(counter),
        );
        const signature = await sign(key, "SHA-256", await sha256(authenticatorData, clientDataHash));
        return standardBase64(
          cbor(
            new Map<CborIn, CborIn>([
              ["signature", signature],
              ["authenticatorData", authenticatorData],
            ]),
          ),
        );
      },
    };
  }

  return {
    root,
    generate,
    async attest(spec) {
      const key = await generate();
      return { keyId: key.keyId, attestation: await key.attest(spec), publicKey: key.publicKey, assert: key.assert };
    },
  };
}

/** A key id as auth stores it: base64url of the 32 bytes. */
export function storedKeyId(keyId: string): string {
  return base64UrlEncode(Uint8Array.from(atob(keyId), (char) => char.charCodeAt(0)));
}

/** A fake device's `@expo/app-integrity`: the shape `appAttestAttester` takes, over `authority`'s keys. */
export interface AppAttestDeviceModule {
  readonly isSupported: boolean;
  generateKeyAsync(): Promise<string>;
  attestKeyAsync(keyId: string, challenge: string): Promise<string>;
  generateAssertionAsync(keyId: string, challenge: string): Promise<string>;
  /** Forget every key, as a reinstall or a restore to a new phone does: asserting with one then throws. */
  wipe(): void;
  /** Each call in order, with the string it was handed. */
  readonly calls: string[];
}

/**
 * `@expo/app-integrity`'s App Attest half on a fake device: the key lives in `authority`'s Secure Enclave stand-in,
 * and each call hashes the string it is handed with SHA-256 over its UTF-8 into `clientDataHash`, as the native
 * module does. Each key's counter rises by one per assertion, as the Secure Enclave's does.
 */
export function appAttestDeviceModule(authority: AppAttestAuthority, appId: string): AppAttestDeviceModule {
  const keys = new Map<string, { key: GeneratedKey; counter: number }>();
  const calls: string[] = [];
  const hash = (text: string) => sha256(new TextEncoder().encode(text));
  const find = (keyId: string) => {
    const entry = keys.get(keyId);
    if (entry === undefined) throw new Error("invalidKey");
    return entry;
  };
  return {
    isSupported: true,
    calls,
    async generateKeyAsync() {
      const key = await authority.generate();
      keys.set(key.keyId, { key, counter: 0 });
      calls.push(`generateKeyAsync -> ${key.keyId}`);
      return key.keyId;
    },
    async attestKeyAsync(keyId, challenge) {
      calls.push(`attestKeyAsync ${keyId} ${challenge}`);
      return find(keyId).key.attest({ appId, clientDataHash: await hash(challenge) });
    },
    async generateAssertionAsync(keyId, challenge) {
      calls.push(`generateAssertionAsync ${keyId} ${challenge}`);
      const entry = find(keyId);
      entry.counter += 1;
      return entry.key.assert({ appId, clientDataHash: await hash(challenge), counter: entry.counter });
    },
    wipe() {
      keys.clear();
    },
  };
}
