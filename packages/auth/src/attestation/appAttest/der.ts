// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * A DER reader (X.690) for the certificates App Attest sends: definite, minimal lengths, low tag numbers. Anything
 * else is a {@link DerError}, because every input here is attacker-supplied.
 */

/** The input is not DER this reader accepts. */
export class DerError extends Error {
  override name = "DerError";
}

/** One DER element. */
export interface DerNode {
  /** The identifier octet: class, constructed bit and tag number. */
  tag: number;
  /** The content octets. */
  content: Uint8Array;
  /** The whole element, identifier and length included: what a signature over it covers. */
  raw: Uint8Array;
}

export const DER_INTEGER = 0x02;
export const DER_BIT_STRING = 0x03;
export const DER_OCTET_STRING = 0x04;
export const DER_OID = 0x06;
export const DER_BOOLEAN = 0x01;
export const DER_SEQUENCE = 0x30;
const UTC_TIME = 0x17;
const GENERALIZED_TIME = 0x18;

/** Read the element at `offset`, and answer it with the offset just past it. */
function readAt(bytes: Uint8Array, offset: number): { node: DerNode; end: number } {
  if (offset + 2 > bytes.length) throw new DerError("DER element runs past the end of its input");
  const tag = bytes[offset] as number;
  if ((tag & 0x1f) === 0x1f) throw new DerError("DER high tag numbers are not supported");
  let length = bytes[offset + 1] as number;
  let header = 2;
  if (length & 0x80) {
    const width = length & 0x7f;
    if (width === 0) throw new DerError("DER indefinite lengths are not allowed");
    if (width > 4) throw new DerError("DER length is wider than four bytes");
    if (offset + 2 + width > bytes.length) throw new DerError("DER length runs past the end of its input");
    length = 0;
    for (let i = 0; i < width; i++) length = length * 256 + (bytes[offset + 2 + i] as number);
    if (length < 0x80 || (bytes[offset + 2] as number) === 0) throw new DerError("DER length is not minimal");
    header += width;
  }
  const end = offset + header + length;
  if (end > bytes.length) throw new DerError("DER content runs past the end of its input");
  return {
    node: { tag, content: bytes.subarray(offset + header, end), raw: bytes.subarray(offset, end) },
    end,
  };
}

/** Read exactly one element that fills `bytes`. */
export function readDer(bytes: Uint8Array): DerNode {
  const { node, end } = readAt(bytes, 0);
  if (end !== bytes.length) throw new DerError("DER has bytes after its one element");
  return node;
}

/** The elements inside a constructed element, in order. */
export function derChildren(node: DerNode): DerNode[] {
  if ((node.tag & 0x20) === 0) throw new DerError("DER element is primitive and has no children");
  const children: DerNode[] = [];
  let offset = 0;
  while (offset < node.content.length) {
    const { node: child, end } = readAt(node.content, offset);
    children.push(child);
    offset = end;
  }
  return children;
}

/** Assert `node` carries `tag`, naming `what` when it does not. */
export function expectTag(node: DerNode | undefined, tag: number, what: string): DerNode {
  if (node === undefined || node.tag !== tag) throw new DerError(`${what} is missing or has the wrong DER type`);
  return node;
}

/** An INTEGER's content octets, two's complement big-endian. */
export function derInteger(node: DerNode | undefined): Uint8Array {
  return expectTag(node, DER_INTEGER, "the integer").content;
}

/** An OBJECT IDENTIFIER in dotted form. */
export function derOid(node: DerNode | undefined): string {
  const content = expectTag(node, DER_OID, "the object identifier").content;
  if (content.length === 0) throw new DerError("DER object identifier is empty");
  const arcs: number[] = [];
  let value = 0;
  for (const byte of content) {
    value = value * 128 + (byte & 0x7f);
    if (!Number.isSafeInteger(value)) throw new DerError("DER object identifier arc is too large");
    if ((byte & 0x80) === 0) {
      arcs.push(value);
      value = 0;
    }
  }
  if ((content[content.length - 1] as number) & 0x80) throw new DerError("DER object identifier is truncated");
  const first = arcs.shift() as number;
  const head = first < 40 ? [0, first] : first < 80 ? [1, first - 40] : [2, first - 80];
  return [...head, ...arcs].join(".");
}

/** A UTCTime or GeneralizedTime, which RFC 5280 requires in UTC to the second. */
export function derTime(node: DerNode | undefined): Date {
  if (node === undefined) throw new DerError("DER time is missing");
  const text = new TextDecoder().decode(node.content);
  const match =
    node.tag === UTC_TIME
      ? /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(text)
      : node.tag === GENERALIZED_TIME
        ? /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(text)
        : null;
  if (match === null) throw new DerError("DER time is not a UTC UTCTime or GeneralizedTime to the second");
  const [, y, mo, d, h, mi, s] = match.map(Number) as number[];
  // RFC 5280 §4.1.2.5.1: a two-digit year of 50 or more is 19YY, below 50 is 20YY.
  const year = node.tag === UTC_TIME ? (y as number) + ((y as number) >= 50 ? 1900 : 2000) : (y as number);
  const time = Date.UTC(year, (mo as number) - 1, d, h, mi, s);
  if (Number.isNaN(time)) throw new DerError("DER time is not a real date");
  return new Date(time);
}
