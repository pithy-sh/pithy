// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { type EncryptionConfig, keyBytes } from "../crypto/envelope";
import { FIELD_KEYS_BINDING } from "../crypto/fieldKeys";
import { type BlindIndexNormalizer, normalizeForIndex } from "./encrypted";

/**
 * **A blind index: a keyed hash an encrypted column can be found by** (#390).
 *
 * An encrypted column cannot answer `WHERE email = ?`. A sibling column holding `HMAC(key, normalize(value))` can,
 * for equality and nothing else. One rule here is shared by the app Worker that seals, `sealed().match` that looks
 * up, and the rotator that re-indexes inside the manager, so the three cannot hash one value two ways.
 *
 * - **The key is derived, on the field key's own version axis.** Each version's index key is HKDF-SHA256 over that
 *   version's field key, with the label `pithy/blind-index/<normalizer>`. One secret, one rotation.
 * - **The value carries its version**: `<version>:<hmac>`, so the stale count reaches an index exactly as it reaches
 *   an envelope, by reading the prefix.
 * - **The normalizer is in the label**, so changing a field's normalizer cannot silently miss against old hashes: they
 *   are hashes under a different key, and the change reads as a re-index.
 */

/** The HKDF label one normalizer's index keys are derived under. */
export function blindIndexLabel(normalizer: BlindIndexNormalizer): string {
  return `pithy/blind-index/${normalizer}`;
}

/** Unpadded base64url, the alphabet a blind index is written in. */
function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The HMAC key for one version and normalizer: HKDF-SHA256 over that version's field key. */
export async function blindIndexKey(
  config: EncryptionConfig,
  version: number,
  normalizer: BlindIndexNormalizer,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    keyBytes(config, version, { keys: FIELD_KEYS_BINDING }),
    "HKDF",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: Uint8Array.from(new TextEncoder().encode(blindIndexLabel(normalizer))),
    },
    material,
    256,
  );
  return crypto.subtle.importKey("raw", bits, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

/** The blind index of `value` under `version`: `<version>:<hmac>`. The value is normalized first. */
export async function blindIndexValue(
  config: EncryptionConfig,
  version: number,
  normalizer: BlindIndexNormalizer,
  value: string,
): Promise<string> {
  const key = await blindIndexKey(config, version, normalizer);
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    Uint8Array.from(new TextEncoder().encode(normalizeForIndex(normalizer, value))),
  );
  return `${version}:${base64Url(new Uint8Array(mac))}`;
}

/** The version a blind-index value was written under, or `null` for a value that is not one. */
export function blindIndexVersion(value: string): number | null {
  const match = /^(\d+):/.exec(value);
  return match ? Number(match[1]) : null;
}
