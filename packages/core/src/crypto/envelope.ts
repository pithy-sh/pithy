// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { InternalError } from "../error/pithyError";

/**
 * **The AES-256-GCM envelope: one primitive, two callers** (#390).
 *
 * It was `@pithy-sh/secrets`' own, ported from the CMS `secretsCrypto`, and it sealed that capability's rows and
 * nothing else. Field encryption needs the same primitive inside an adopter's own Workers, and a capability may not
 * depend on another's internals (principle 4), so it lives in core now and both callers import it from here. The
 * format did not change: a row secrets sealed before the move opens after it, byte for byte.
 *
 * ## Two version axes
 *
 * `currentVersion` says which key seals new writes, and the `keyVersion` persisted on every envelope says which key
 * opens it. A rotation adds a version, moves the pointer and keeps the old key until nothing is sealed under it, so
 * a row opens under whichever version sealed it, for as long as that version is in the set. This is the
 * *encryption-key* version. A secret's *value* version is a separate concern (`secrets/src/crypto/versionedValue.ts`).
 *
 * The config is the uniform `{ currentVersion, versions }` shape every versioned value uses, plus `lastRotatedAt`
 * beside it as rotation metadata. Version keys are stringified integers, so reading the keys is a full-set read:
 * every still-valid version, never the current one alone.
 *
 * ## The bound context is the caller's, and it is authenticated
 *
 * Every seal binds a **context** string as AES-GCM additional authenticated data. It is not encrypted; it is bound.
 * Without it a ciphertext is valid under the key alone, so one lifted from one row and written into another opens
 * cleanly, and every decision about which value a caller gets lives in the query above. With it, a moved ciphertext
 * fails inside the primitive, however that query is later rewritten.
 *
 * The primitive takes the context whole, because what to bind is the caller's fact, not this module's:
 *
 * - `@pithy-sh/secrets` binds `pithy.secrets.v1:<stored name>` — exactly what it always bound.
 * - A field marked `encrypted()` binds `pithy/enc/1:<declared name>:<field path>:<primary key>` (`../privacy/sealed`).
 *
 * Each prefix is versioned, so a later change to what is bound is a deliberate, visible break, and the two prefixes
 * are distinct, so a secret's ciphertext never opens as a field and a field's never opens as a secret. **What is bound
 * must be stable for the life of the ciphertext**: each caller states why its own context is.
 *
 * An empty context is refused on both halves. It binds nothing, and it would fail open rather than loudly.
 */

/** The key set a seal draws from: which version is current, every still-valid key, and when it last rotated. */
export const EncryptionConfig = z
  .object({
    currentVersion: z
      .string()
      .meta({ multiline: false })
      .describe("The version key (a stringified integer) whose key seals new writes — the active key."),
    versions: z
      // Every string leaf of a `json` secret says whether it fits on a terminal line, and a base64 key
      // does. See `cli/promptPlan.ts`; held repo-wide by `packages/cli/src/ci/secretFieldLines.test.ts`.
      .record(z.string(), z.string().meta({ multiline: false }))
      .describe(
        "Every still-valid key: version key (stringified integer) → base64-encoded AES-256 key. Holds the current key plus any prior versions still needed to open values not yet re-sealed.",
      ),
    lastRotatedAt: z.iso
      .datetime()
      .meta({ multiline: false })
      .describe(
        "ISO-8601 timestamp of the last rotation; the rotation cron compares against it to decide when to rotate.",
      ),
  })
  .describe(
    "A versioned AES-256 key set: the uniform versioned-value shape (currentVersion + versions) plus rotation metadata. Secrets' master key (`SECRETS_ENCRYPTION_KEYS`) and the field key (`PITHY_FIELD_KEYS`) both take it.",
  );
export type EncryptionConfig = z.output<typeof EncryptionConfig>;

/**
 * One AES-256-GCM envelope: base64 ciphertext, base64 IV, and the key version that sealed it.
 *
 * The bound context is deliberately not in here. It is supplied by the caller on the way back in, from the row's own
 * identity, so a row that has been moved cannot carry its old context with it.
 */
export const EncryptedEnvelope = z
  .object({
    encryptedValue: z.string().min(1).describe("The AES-256-GCM ciphertext and tag, base64."),
    iv: z.string().min(1).describe("The 12-byte initialization vector, base64. Fresh for every seal."),
    keyVersion: z
      .number()
      .int()
      .describe("The version of the key that sealed this value: the key set entry that opens it."),
  })
  .describe("An AES-256-GCM envelope: the ciphertext, its IV, and the key version that sealed it.");
export type EncryptedEnvelope = z.output<typeof EncryptedEnvelope>;

/** What the refusals name the key set by — its binding, so an operator knows which entry to inspect. */
export interface EnvelopeOptions {
  /** The binding the key set was read from, e.g. `SECRETS_ENCRYPTION_KEYS`. Defaults to `the key set`. */
  keys?: string;
}

/** Base64-encode raw bytes without spreading into `fromCharCode` (stack-safe, lint-clean). */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Decode base64 to raw bytes. */
export function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(b64), (char) => char.charCodeAt(0));
}

/** The authenticated data for one seal. An empty context is refused: it would bind nothing. */
function additionalData(context: string): Uint8Array<ArrayBuffer> {
  if (context.length === 0) {
    throw new InternalError({ detail: "the envelope needs a context to bind; an empty context binds nothing" });
  }
  // Copied through `from` so the view is backed by an `ArrayBuffer` rather than an `ArrayBufferLike`:
  // workers-types types `encode` as the wider one, which no longer satisfies `BufferSource`.
  return Uint8Array.from(new TextEncoder().encode(context));
}

/** The raw key bytes for `version`, or a refusal naming the key set. Never the key itself. */
export function keyBytes(
  config: EncryptionConfig,
  version: number,
  options: EnvelopeOptions = {},
): Uint8Array<ArrayBuffer> {
  const b64 = config.versions[String(version)];
  if (!b64) {
    throw new InternalError({
      detail: `encryption key version ${version} not present in ${options.keys ?? "the key set"}`,
    });
  }
  return fromBase64(b64);
}

/** Import the AES-GCM key for `version` from the config, or throw if that version is absent. */
async function importKey(
  config: EncryptionConfig,
  version: number,
  usage: ("encrypt" | "decrypt")[],
  options: EnvelopeOptions,
): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", keyBytes(config, version, options), "AES-GCM", false, usage);
}

/**
 * Seal `plaintext` under the config's current key version, binding `context`. The IV is 12 fresh random bytes, so
 * two seals of one value never share a ciphertext.
 */
export async function encryptValue(
  config: EncryptionConfig,
  context: string,
  plaintext: string,
  options: EnvelopeOptions = {},
): Promise<EncryptedEnvelope> {
  const aad = additionalData(context);
  const keyVersion = Number(config.currentVersion);
  const key = await importKey(config, keyVersion, ["encrypt"], options);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad },
    key,
    new TextEncoder().encode(plaintext),
  );
  return { encryptedValue: toBase64(new Uint8Array(ciphertext)), iv: toBase64(iv), keyVersion };
}

/**
 * Open an envelope sealed under `context`. The key version may differ from `currentVersion` during a rotation window;
 * the matching key must still be in the config.
 *
 * A missing key version, a tampered ciphertext, the wrong key, or a ciphertext sealed under another context all throw
 * — never the plaintext or key material. GCM cannot tell those apart, and separating them for the caller would be an
 * oracle: the `detail` names the context the open was *attempted under*, which is what an operator needs. Each caller
 * binds a context composed from validated identifiers, so it is safe in a log; neither binds a value.
 */
export async function decryptValue(
  config: EncryptionConfig,
  context: string,
  envelope: EncryptedEnvelope,
  options: EnvelopeOptions = {},
): Promise<string> {
  const aad = additionalData(context);
  const key = await importKey(config, envelope.keyVersion, ["decrypt"], options);
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64(envelope.iv), additionalData: aad },
      key,
      fromBase64(envelope.encryptedValue),
    );
    return new TextDecoder().decode(plaintext);
  } catch (cause) {
    throw new InternalError(
      {
        detail: `AES-GCM decrypt failed for '${context}' under key version ${envelope.keyVersion}: wrong key, tampered ciphertext, or a ciphertext sealed under a different context`,
      },
      { cause },
    );
  }
}
