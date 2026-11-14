// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * A CBOR reader for what App Attest sends (RFC 8949): unsigned and negative integers, byte and text strings,
 * arrays, maps, `true`, `false` and `null`, all of definite length. Anything else, and any byte left over, is
 * a {@link CborError}, because every input here is attacker-supplied.
 */

/** A decoded CBOR value. Maps keep their keys' own types, so an integer key never collides with a text one. */
export type CborValue = number | boolean | null | string | Uint8Array | CborValue[] | Map<CborValue, CborValue>;

/** The input is not CBOR this reader accepts. */
export class CborError extends Error {
  override name = "CborError";
}

const MAX_DEPTH = 16;

class Reader {
  offset = 0;
  private readonly bytes: Uint8Array;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  take(length: number): Uint8Array {
    if (length > this.bytes.length - this.offset) throw new CborError("CBOR runs past the end of its input");
    const slice = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return slice;
  }

  byte(): number {
    return this.take(1)[0] as number;
  }

  argument(additional: number): number {
    if (additional < 24) return additional;
    const width = additional === 24 ? 1 : additional === 25 ? 2 : additional === 26 ? 4 : additional === 27 ? 8 : 0;
    if (width === 0) throw new CborError(`CBOR additional information ${additional} is not supported`);
    let value = 0;
    for (const byte of this.take(width)) value = value * 256 + byte;
    if (!Number.isSafeInteger(value)) throw new CborError("CBOR integer is past 2^53");
    return value;
  }

  value(depth: number): CborValue {
    if (depth > MAX_DEPTH) throw new CborError("CBOR is nested too deep");
    const initial = this.byte();
    const major = initial >> 5;
    const additional = initial & 0x1f;
    if (major === 7) {
      if (additional === 20) return false;
      if (additional === 21) return true;
      if (additional === 22) return null;
      throw new CborError(`CBOR simple value or float ${additional} is not supported`);
    }
    if (major === 6) throw new CborError("CBOR tags are not supported");
    const argument = this.argument(additional);
    switch (major) {
      case 0:
        return argument;
      case 1:
        return -1 - argument;
      case 2:
        return this.take(argument).slice();
      case 3:
        try {
          return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(this.take(argument));
        } catch (cause) {
          if (cause instanceof CborError) throw cause;
          throw new CborError("CBOR text string is not UTF-8");
        }
      case 4: {
        // Every item is at least one byte, so a count past what is left cannot be real.
        if (argument > this.bytes.length - this.offset)
          throw new CborError("CBOR array runs past the end of its input");
        const items: CborValue[] = [];
        for (let i = 0; i < argument; i++) items.push(this.value(depth + 1));
        return items;
      }
      default: {
        if (argument * 2 > this.bytes.length - this.offset)
          throw new CborError("CBOR map runs past the end of its input");
        const map = new Map<CborValue, CborValue>();
        for (let i = 0; i < argument; i++) {
          const key = this.value(depth + 1);
          if (map.has(key)) throw new CborError("CBOR map repeats a key");
          map.set(key, this.value(depth + 1));
        }
        return map;
      }
    }
  }
}

/** Decode exactly one CBOR item that fills `bytes`. Throws {@link CborError} on anything else. */
export function decodeCbor(bytes: Uint8Array): CborValue {
  const reader = new Reader(bytes);
  const value = reader.value(0);
  if (reader.offset !== bytes.length) throw new CborError("CBOR has bytes after its one item");
  return value;
}

/** The byte-string field `key` of a decoded map, or `undefined` when it is absent, or not a map or bytes. */
export function cborBytes(value: CborValue, key: string): Uint8Array | undefined {
  const field = value instanceof Map ? value.get(key) : undefined;
  return field instanceof Uint8Array ? field : undefined;
}

/** The text field `key` of a decoded map, or `undefined` when it is absent, or not a map or text. */
export function cborText(value: CborValue, key: string): string | undefined {
  const field = value instanceof Map ? value.get(key) : undefined;
  return typeof field === "string" ? field : undefined;
}
