import { z } from "zod";
import { SecretCryptoError } from "../error/errors";

/**
 * AES-256-GCM envelope helpers, ported from the CMS `secretsCrypto`. The master key never
 * leaves the worker: it is read from the `SECRETS_ENCRYPTION_KEYS` binding (CF Secrets Store)
 * as an {@link EncryptionConfig}, and every encrypt/decrypt runs in-process. Helpers take a
 * parsed config so a caller resolves it once and passes the typed value through.
 *
 * Two version axes live here: `currentVersion` (which master key encrypts new writes) and the
 * `keyVersion` persisted per row (which key decrypts it). Both let the at-rest rotation job
 * re-encrypt under a new key with an overlap window. This is the *encryption-key* version — the
 * *value* version is a separate concern (see `versionedValue.ts`).
 *
 * The config carries the same uniform `{ currentVersion, versions }` envelope every secret uses
 * (`versionedValue.ts`) — `versions` is the still-valid key set, `currentVersion` the active
 * pointer — plus `lastRotatedAt` beside it as rotation metadata. Stringified-integer version keys,
 * so the keys read is inherently a full-set read (every still-valid version, never current-only).
 */
export const EncryptionConfig = z
  .object({
    currentVersion: z
      .string()
      .describe(
        "The version key (a stringified integer) whose master key encrypts new writes — the active master key.",
      ),
    versions: z
      .record(z.string(), z.string())
      .describe(
        "Every still-valid master key: version key (stringified integer) → base64-encoded AES-256 key. Holds the current key plus any prior versions still needed to decrypt rows not yet re-encrypted.",
      ),
    lastRotatedAt: z.iso
      .datetime()
      .describe(
        "ISO-8601 timestamp of the last at-rest key rotation; the cron compares against it to decide when to rotate.",
      ),
  })
  .describe(
    "The master-key configuration, read from the worker-only SECRETS_ENCRYPTION_KEYS binding (CF Secrets Store). The uniform versioned-value shape (currentVersion + versions) plus rotation metadata.",
  );
export type EncryptionConfig = z.output<typeof EncryptionConfig>;

/** One AES-256-GCM envelope: base64 ciphertext, base64 IV, and the key version that produced it. */
export interface EncryptedEnvelope {
  encryptedValue: string;
  iv: string;
  keyVersion: number;
}

/** Base64-encode raw bytes without spreading into `fromCharCode` (stack-safe, lint-clean). */
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Decode base64 to raw bytes. */
function fromBase64(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (char) => char.charCodeAt(0));
}

/** Import the AES-GCM key for `version` from the config, or throw if that version is absent. */
async function importKey(
  config: EncryptionConfig,
  version: number,
  usage: ("encrypt" | "decrypt")[],
): Promise<CryptoKey> {
  const b64 = config.versions[String(version)];
  if (!b64) {
    throw new SecretCryptoError({
      detail: `encryption key version ${version} not present in SECRETS_ENCRYPTION_KEYS`,
    });
  }
  return crypto.subtle.importKey("raw", fromBase64(b64), "AES-GCM", false, usage);
}

/** Encrypt `plaintext` under the config's current key version. The IV is 12 fresh random bytes. */
export async function encryptValue(config: EncryptionConfig, plaintext: string): Promise<EncryptedEnvelope> {
  const keyVersion = Number(config.currentVersion);
  const key = await importKey(config, keyVersion, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext));
  return { encryptedValue: toBase64(new Uint8Array(ciphertext)), iv: toBase64(iv), keyVersion };
}

/**
 * Decrypt an envelope encrypted under `keyVersion`. The version may differ from
 * `currentVersion` during a rotation window; the matching key must still be in the config.
 * A missing key version or an unreadable ciphertext (tampering, wrong key) throws
 * `secrets/crypto_failed` — never the raw plaintext or key material.
 */
export async function decryptValue(
  config: EncryptionConfig,
  encryptedValue: string,
  iv: string,
  keyVersion: number,
): Promise<string> {
  const key = await importKey(config, keyVersion, ["decrypt"]);
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64(iv) },
      key,
      fromBase64(encryptedValue),
    );
    return new TextDecoder().decode(plaintext);
  } catch (cause) {
    throw new SecretCryptoError(
      { detail: `AES-GCM decrypt failed under key version ${keyVersion} (bad key or tampered ciphertext)` },
      { cause },
    );
  }
}
