// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

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
 *
 * ## The secret's name is authenticated, not decorative
 *
 * Every seal binds the secret's **stored name** as AES-GCM additional authenticated data. It is not
 * encrypted; it is bound. Without it a ciphertext is valid under the key alone, so one lifted from
 * one row and written into another opens cleanly and the envelope has no opinion about whether it
 * belongs there — every decision about which secret a caller gets then lives in the query above, and
 * a bug there is a disclosure rather than a failure. With the name bound, a moved ciphertext does
 * not open, inside the primitive, however that query is later rewritten.
 *
 * The stored name is the right thing to bind because it *is* the row's identity: `name` is unique in
 * `pithy_secrets_system_secrets`, and for a keyspace member it is the whole `<entry>/<key>`
 * (`keyspace.ts`) — so one tenant's credential does not open under another tenant's key.
 *
 * **What is bound must be stable for the life of the ciphertext, and this is.** Nothing renames a
 * secret: the store offers `put` and `delete`, and a rename is a create under the new name plus a
 * delete of the old, which re-encrypts through the plaintext. An `UPDATE ... SET name` in raw SQL
 * would leave a row that never opens again — which is the property, not a regression. Choosing
 * anything mutable (a display label, an owning tenant that could be reassigned) would make a rename
 * an unopenable secret; the name cannot be renamed, so it cannot.
 *
 * The AAD is prefixed with {@link AAD_CONTEXT} for domain separation: a ciphertext from some future
 * construction under the same master key will not open here, and vice versa. That prefix is
 * versioned so a later change to what is bound is a deliberate, visible break.
 *
 * **No compatibility path.** Ciphertexts written before the binding existed carry no AAD and do not
 * open — they fail as `secrets/crypto_failed`, like any other unreadable row. Nothing is published
 * and no adopter stores production values yet, so accepting an unbound ciphertext "just this once"
 * would buy nothing and leave the exact hole this closes permanently reachable.
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

/**
 * One AES-256-GCM envelope: base64 ciphertext, base64 IV, and the key version that produced it. The
 * bound name is deliberately not in here — it is the row's own `name` column, supplied by the caller
 * on the way back in, so a row that has been moved cannot carry its old context with it.
 */
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

/**
 * The domain-separation prefix on every seal's authenticated data. Versioned: changing what is bound
 * changes this too, so the break is deliberate and every old ciphertext fails loudly rather than
 * opening under a rule it was not sealed with.
 */
const AAD_CONTEXT = "pithy.secrets.v1:";

/**
 * The authenticated data for one secret: the domain prefix and the stored name.
 *
 * An empty name is refused on both halves. It would bind the prefix alone — every secret sharing one
 * context is the same as binding nothing, and it would fail open rather than loudly.
 */
function additionalData(name: string): Uint8Array {
  if (name.length === 0) {
    throw new SecretCryptoError({ detail: "the envelope needs a secret name to bind; an empty name binds nothing" });
  }
  return new TextEncoder().encode(`${AAD_CONTEXT}${name}`);
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

/**
 * Encrypt `plaintext` for the secret stored as `name`, under the config's current key version. The
 * IV is 12 fresh random bytes; `name` is bound as authenticated data, so the result opens only for
 * that name.
 */
export async function encryptValue(
  config: EncryptionConfig,
  name: string,
  plaintext: string,
): Promise<EncryptedEnvelope> {
  const aad = additionalData(name);
  const keyVersion = Number(config.currentVersion);
  const key = await importKey(config, keyVersion, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad },
    key,
    new TextEncoder().encode(plaintext),
  );
  return { encryptedValue: toBase64(new Uint8Array(ciphertext)), iv: toBase64(iv), keyVersion };
}

/**
 * Decrypt an envelope sealed for the secret stored as `name`. The key version may differ from
 * `currentVersion` during a rotation window; the matching key must still be in the config.
 *
 * A missing key version, a tampered ciphertext, the wrong key, or a ciphertext sealed for a
 * different name all throw `secrets/crypto_failed` — never the raw plaintext or key material. GCM
 * cannot tell those apart, and separating them for the caller would be an oracle: the `detail` names
 * the context the decrypt was *attempted under*, which is what an operator needs to see. `name`
 * reaches logs verbatim there, which is safe because every name is either a registry literal or a
 * `keyedSecretName` composed from a validated `SecretKey` — no newlines, no control bytes.
 */
export async function decryptValue(
  config: EncryptionConfig,
  name: string,
  envelope: EncryptedEnvelope,
): Promise<string> {
  const aad = additionalData(name);
  const key = await importKey(config, envelope.keyVersion, ["decrypt"]);
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64(envelope.iv), additionalData: aad },
      key,
      fromBase64(envelope.encryptedValue),
    );
    return new TextDecoder().decode(plaintext);
  } catch (cause) {
    throw new SecretCryptoError(
      {
        detail: `AES-GCM decrypt failed for secret '${name}' under key version ${envelope.keyVersion}: wrong key, tampered ciphertext, or a ciphertext sealed for a different name`,
      },
      { cause },
    );
  }
}
