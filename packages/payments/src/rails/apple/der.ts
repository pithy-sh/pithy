// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PaymentsInvalidReceiptError } from "../../error/errors";

/**
 * The byte encodings Apple's signed data is built from: base64 and base64url, and just enough ASN.1 DER
 * to walk an X.509 certificate.
 *
 * **Why this exists at all.** Verifying an App Store Server Notification means verifying a JWS against a
 * certificate chain, and there is no certificate parser in the Workers runtime — `crypto.subtle` imports a
 * SubjectPublicKeyInfo but will not open a certificate to find one. Node's `X509Certificate` is not
 * available here. So the parts of DER the chain needs are read directly, and nothing more: this is a
 * reader, never a general ASN.1 library, and it has no encoder.
 *
 * **Every parse is hostile-input parsing.** These bytes arrive in an unauthenticated HTTP request, which
 * is the whole point of verifying them, so every length is checked against the buffer it claims to live in
 * before it is trusted. A length that overruns its buffer or its parent is refused rather than clamped —
 * clamping would let a crafted certificate present bytes that were never inside it. Indefinite lengths are
 * refused outright: DER forbids them, and honouring BER's end-of-contents marker is how a parser is made
 * to disagree with the verifier about where a structure ends.
 *
 * Failures throw `payments/invalid_receipt` — malformed, not merely unverified. A caller on the webhook
 * path maps that to `payments/webhook_unverified`, so one implementation serves both paths with the right
 * code on each.
 */

/** DER tag for a constructed SEQUENCE. */
export const ASN1_SEQUENCE = 0x30;
/** DER tag for an INTEGER. */
export const ASN1_INTEGER = 0x02;
/** DER tag for a BIT STRING. */
export const ASN1_BIT_STRING = 0x03;
/** DER tag for an OBJECT IDENTIFIER. */
export const ASN1_OID = 0x06;
/** DER tag for a UTCTime. */
export const ASN1_UTC_TIME = 0x17;
/** DER tag for a GeneralizedTime. */
export const ASN1_GENERALIZED_TIME = 0x18;
/** DER tag for a BOOLEAN — how an extension states `critical`, and how basicConstraints states `cA`. */
export const ASN1_BOOLEAN = 0x01;
/** DER tag for an OCTET STRING — an X.509 extension's value is one, wrapping the extension's own DER. */
export const ASN1_OCTET_STRING = 0x04;

/** The bit in a tag byte that marks a node constructed (its contents are further nodes). */
const ASN1_CONSTRUCTED = 0x20;

/** One ASN.1 node: its tag, the whole encoding, and the contents. */
export interface Asn1Node {
  /** The tag byte, context-specific tags included (`0xa0` for `[0]`). */
  tag: number;
  /**
   * The node's whole DER encoding, tag and length bytes included. This is the field a signature covers —
   * a certificate's `tbsCertificate` is signed as encoded, not as contents — so it is kept rather than
   * reconstructed.
   */
  der: Uint8Array;
  /** The contents octets, without the tag or length. */
  value: Uint8Array;
}

/** A structural refusal. The detail names the position, because a chain has several places to fail. */
function malformed(detail: string): PaymentsInvalidReceiptError {
  return new PaymentsInvalidReceiptError({
    message: "That purchase could not be read.",
    action: "Submit the transaction exactly as the store SDK returned it.",
    detail,
  });
}

/**
 * Read one DER node at `offset`. Returns the node and the offset just past it, so a caller walks a
 * sequence by feeding the returned `end` back in.
 */
export function readAsn1(bytes: Uint8Array, offset = 0): { node: Asn1Node; end: number } {
  if (offset + 2 > bytes.length) throw malformed(`DER: truncated header at offset ${offset}.`);
  const tag = bytes[offset] as number;
  const first = bytes[offset + 1] as number;
  let length: number;
  let contentsAt: number;

  if (first < 0x80) {
    length = first;
    contentsAt = offset + 2;
  } else {
    const lengthBytes = first & 0x7f;
    // 0x80 is BER's indefinite length. DER forbids it, and a reader that accepted it would have to trust
    // an end-of-contents marker inside the very data it is checking.
    if (lengthBytes === 0) throw malformed(`DER: indefinite length at offset ${offset}.`);
    // Four bytes is 4 GiB; anything wider cannot be a real length and could overflow the accumulator.
    if (lengthBytes > 4) throw malformed(`DER: length of ${lengthBytes} bytes at offset ${offset} is too wide.`);
    if (offset + 2 + lengthBytes > bytes.length) throw malformed(`DER: truncated length at offset ${offset}.`);
    length = 0;
    for (let i = 0; i < lengthBytes; i += 1) length = length * 256 + (bytes[offset + 2 + i] as number);
    contentsAt = offset + 2 + lengthBytes;
  }

  const end = contentsAt + length;
  if (end > bytes.length) {
    throw malformed(`DER: node at offset ${offset} claims ${length} bytes, ${bytes.length - contentsAt} remain.`);
  }
  return { node: { tag, der: bytes.subarray(offset, end), value: bytes.subarray(contentsAt, end) }, end };
}

/**
 * The members of a constructed node, in order. Each member is read from the parent's contents, so a member
 * that overruns the parent is refused — the check the parent's own length would otherwise not enforce.
 */
export function asn1Children(node: Asn1Node): Asn1Node[] {
  if ((node.tag & ASN1_CONSTRUCTED) === 0) throw malformed(`DER: tag 0x${node.tag.toString(16)} is not constructed.`);
  const children: Asn1Node[] = [];
  let offset = 0;
  while (offset < node.value.length) {
    const { node: child, end } = readAsn1(node.value, offset);
    children.push(child);
    offset = end;
  }
  return children;
}

/**
 * An OBJECT IDENTIFIER as dotted decimal. Algorithm and curve identities are compared as strings rather
 * than as byte patterns, so the comparison sites read as the names they mean.
 */
export function readOid(node: Asn1Node): string {
  if (node.tag !== ASN1_OID)
    throw malformed(`DER: expected an OBJECT IDENTIFIER, found tag 0x${node.tag.toString(16)}.`);
  if (node.value.length === 0) throw malformed("DER: empty OBJECT IDENTIFIER.");
  const first = node.value[0] as number;
  // The first two arcs share one byte: 40 * arc1 + arc2, with arc1 capped at 2.
  const arcs: number[] = [Math.min(Math.floor(first / 40), 2)];
  arcs.push(first - (arcs[0] as number) * 40);
  let current = 0;
  for (let i = 1; i < node.value.length; i += 1) {
    const byte = node.value[i] as number;
    current = current * 128 + (byte & 0x7f);
    // The high bit means "this arc continues into the next byte".
    if ((byte & 0x80) === 0) {
      arcs.push(current);
      current = 0;
    }
  }
  return arcs.join(".");
}

/**
 * An X.509 ECDSA signature (`SEQUENCE { INTEGER r, INTEGER s }`) as the fixed-width `r || s` WebCrypto
 * verifies. `size` is the curve's coordinate size — 32 bytes for P-256, 48 for P-384.
 *
 * The two encodings differ in exactly the way that trips people up. DER writes each integer with the
 * fewest bytes that keep it positive, so a coordinate whose top bit is set gains a leading zero and a
 * small one loses leading bytes. WebCrypto wants both coordinates at full width. So the padding byte is
 * stripped and the remainder right-aligned; a value still wider than the curve after stripping is refused
 * rather than truncated, because truncating a signature makes a forgery verify.
 */
export function derSignatureToRaw(der: Uint8Array, size: number): Uint8Array {
  const { node } = readAsn1(der);
  if (node.tag !== ASN1_SEQUENCE) throw malformed("DER: an ECDSA signature must be a SEQUENCE.");
  const parts = asn1Children(node);
  if (parts.length !== 2) throw malformed(`DER: an ECDSA signature has two integers, found ${parts.length}.`);
  const raw = new Uint8Array(size * 2);
  for (const [index, part] of parts.entries()) {
    if (part.tag !== ASN1_INTEGER) throw malformed("DER: an ECDSA signature's members must be INTEGERs.");
    let value = part.value;
    while (value.length > 0 && value[0] === 0) value = value.subarray(1);
    if (value.length > size) throw malformed(`DER: ECDSA coordinate is ${value.length} bytes, the curve is ${size}.`);
    raw.set(value, index * size + (size - value.length));
  }
  return raw;
}

/**
 * A DER BOOLEAN. DER admits exactly two encodings — `0x00` false, `0xff` true — and anything else is
 * refused rather than coerced. A parser that read any non-zero byte as true would disagree with an encoder
 * that wrote `0x01`, and for `basicConstraints.cA` that disagreement is the difference between a
 * certificate authority and a leaf.
 */
export function readBoolean(node: Asn1Node): boolean {
  if (node.tag !== ASN1_BOOLEAN) throw malformed(`DER: expected a BOOLEAN, found tag 0x${node.tag.toString(16)}.`);
  if (node.value.length !== 1) throw malformed(`DER: a BOOLEAN is one byte, found ${node.value.length}.`);
  const byte = node.value[0] as number;
  if (byte === 0x00) return false;
  if (byte === 0xff) return true;
  throw malformed(`DER: 0x${byte.toString(16)} is not a DER BOOLEAN; only 0x00 and 0xff are.`);
}

/**
 * A non-negative INTEGER, as a number. Only used for small constrained values (`pathLenConstraint`), so a
 * value wider than is plausible is refused rather than silently losing precision past 2^53.
 */
export function readInteger(node: Asn1Node): number {
  if (node.tag !== ASN1_INTEGER) throw malformed(`DER: expected an INTEGER, found tag 0x${node.tag.toString(16)}.`);
  if (node.value.length === 0) throw malformed("DER: empty INTEGER.");
  if ((node.value[0] as number) & 0x80) throw malformed("DER: a negative INTEGER is not accepted here.");
  if (node.value.length > 4) throw malformed(`DER: INTEGER of ${node.value.length} bytes is wider than expected.`);
  let value = 0;
  for (const byte of node.value) value = value * 256 + byte;
  return value;
}

/**
 * A BIT STRING's bits, most-significant first, as booleans. The first contents byte counts the unused
 * trailing bits of the last byte, and those are dropped — a `keyUsage` with padding read as data would
 * report permissions the certificate never granted.
 */
export function readBits(node: Asn1Node): boolean[] {
  if (node.tag !== ASN1_BIT_STRING)
    throw malformed(`DER: expected a BIT STRING, found tag 0x${node.tag.toString(16)}.`);
  if (node.value.length === 0) throw malformed("DER: empty BIT STRING.");
  const unused = node.value[0] as number;
  if (unused > 7) throw malformed(`DER: a BIT STRING cannot have ${unused} unused bits.`);
  const bytes = node.value.subarray(1);
  if (bytes.length === 0) return [];
  const bits: boolean[] = [];
  for (const [index, byte] of bytes.entries()) {
    const width = index === bytes.length - 1 ? 8 - unused : 8;
    for (let bit = 0; bit < width; bit += 1) bits.push((byte & (0x80 >> bit)) !== 0);
  }
  return bits;
}

/** Bytes from a base64 string, standard alphabet — how a JWS header's `x5c` carries a certificate. */
export function decodeBase64(encoded: string): Uint8Array {
  if (encoded.length === 0) throw malformed("base64: empty value.");
  let binary: string;
  try {
    binary = atob(encoded);
  } catch (cause) {
    throw new PaymentsInvalidReceiptError({ detail: "base64: value is not valid base64." }, { cause });
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

/**
 * Bytes from a base64url string — how a JWS carries its header, payload, and signature. The URL alphabet
 * substitutes `-` and `_`, and drops the padding, so both are restored before decoding.
 */
export function decodeBase64Url(encoded: string): Uint8Array {
  if (encoded.length === 0) throw malformed("base64url: empty value.");
  const standard = encoded.replaceAll("-", "+").replaceAll("_", "/");
  return decodeBase64(standard.padEnd(standard.length + ((4 - (standard.length % 4)) % 4), "="));
}

/** Whether two byte strings have identical contents. Used to match a pinned root and to link a chain. */
export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) if (left[i] !== right[i]) return false;
  return true;
}
