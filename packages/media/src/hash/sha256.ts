/**
 * SHA-256 content hashing — the exact-duplicate key.
 *
 * Every stored object gets a SHA-256 of its bytes. Identical uploads produce an identical hash, so an
 * exact-duplicate check is a single equality lookup on this value (see {@link findDuplicates}). The digest
 * is computed with Web Crypto (`crypto.subtle`), which is a global in the Workers runtime and on Node 22+
 * — no import, no dependency, same code everywhere the package runs.
 */

/** Lowercase hex alphabet, indexed by nibble. Precomputed so the encode loop does no per-byte formatting. */
const HEX = "0123456789abcdef";

/** Encode raw digest bytes as a lowercase-hex string. Two hex chars per byte, high nibble first. */
function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    out += HEX.charAt(byte >> 4) + HEX.charAt(byte & 0x0f);
  }
  return out;
}

/**
 * Compute the lowercase-hex SHA-256 of a byte payload. Accepts a `Uint8Array` or a raw `ArrayBuffer`, so
 * a caller can hand over either a decoded view or the buffer straight off an upload. The result is a
 * stable 64-character hex string — the exact-duplicate key stored on every record.
 */
export async function computeSha256(bytes: Uint8Array | ArrayBuffer): Promise<string> {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const digest = await crypto.subtle.digest("SHA-256", view);
  return toHex(new Uint8Array(digest));
}
