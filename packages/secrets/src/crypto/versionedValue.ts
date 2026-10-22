// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { SecretCryptoError } from "../error/errors";

/**
 * The universal value serde. Every secret — rotatable or not — is stored the same way: a
 * `{ currentVersion, versions }` envelope, JSON-encoded, then sealed in one AES-256-GCM
 * envelope. The shape mirrors `EncryptionConfig`'s `{ currentVersion, keys }`: an explicit
 * pointer to the current version (so we never sort stringified-integer keys, where `"10" < "2"`)
 * plus every still-valid version. A new secret is a one-entry envelope; a value rotation adds the
 * next version ({@link stagedValue}) and, a cache lifetime later, repoints `currentVersion` at it
 * ({@link promotedValue}). So a version newer than the current one is a successor waiting to be promoted. Values are strings —
 * a `json` secret stores its serialized form, parsed at the read seam. This is the *value*
 * version, distinct from the envelope's encryption-key version (see `@pithy-sh/core/src/crypto/envelope`).
 *
 * A version is retired by removing it, after its overlap, by the rotation that replaced it (#602) —
 * see {@link retireVersions}. Nothing about a version records when it will go: the rotation Workflow
 * holds that clock, so the envelope stays `version → value` and nothing else.
 */
export const VersionedValue = z
  .object({
    currentVersion: z
      .string()
      .describe("The version key (a stringified integer) whose value is current — the default returned by `get`."),
    versions: z
      .record(z.string(), z.string())
      .describe("Every still-valid version: version key (stringified integer) → value. Always at least one entry."),
  })
  .describe("A secret's stored plaintext: an explicit current-version pointer plus every still-valid version.");
export type VersionedValue = z.output<typeof VersionedValue>;

/** The initial envelope for a freshly-created secret: version 1 is current and holds the value. */
export function initialVersionedValue(value: string): VersionedValue {
  return { currentVersion: "1", versions: { "1": value } };
}

/** Append `value` at the next version and make it current, keeping prior versions (a value rotation). */
export function appendVersion(value: VersionedValue, next: string): VersionedValue {
  const version = String(highestVersion(value) + 1);
  return { currentVersion: version, versions: { ...value.versions, [version]: next } };
}

/** One rotation's successor added to an envelope: the new envelope, the version it is under, and the ones beside it. */
export interface StagedValue {
  /** The envelope with the successor added. Its current version is the one it had before. */
  value: VersionedValue;
  /** The version key the successor was stored under. */
  version: string;
  /** Every other version still in the envelope, current included — what the rotation retires after its overlap. */
  prior: string[];
}

/**
 * Add `next` beside the current version **without making it current**, unless the envelope already holds it.
 *
 * **Two writes, because readers cache (#602).** A Worker reads a secret through a per-isolate cache that may
 * be an hour old. Had the successor become current in the write that added it, one isolate would sign under
 * it while another, still holding the envelope from before, had no key to verify the signature. Added first
 * and promoted a cache lifetime later ({@link promotedValue}), every isolate already holds the successor as a
 * verifying key by the time any of them signs under it.
 *
 * Idempotent on the value, and that is the property a retried store needs: the rotation produces its
 * successor once and writes the same string on every attempt, so an attempt that landed and lost its answer
 * finds the value already there and adds nothing — the prior version list would otherwise name the
 * successor as something to retire.
 */
export function stagedValue(value: VersionedValue, next: string): StagedValue {
  const existing = Object.entries(value.versions).find(([, held]) => held === next)?.[0];
  const version = existing ?? String(highestVersion(value) + 1);
  const staged = existing === undefined ? { ...value, versions: { ...value.versions, [version]: next } } : value;
  return { value: staged, version, prior: Object.keys(staged.versions).filter((key) => key !== version) };
}

/**
 * Make `version` current, keeping every other version. `null` when the envelope no longer holds it — an
 * `update` replaced the envelope while the successor waited, and there is nothing of this rotation left.
 */
export function promotedValue(value: VersionedValue, version: string): VersionedValue | null {
  if (value.versions[version] === undefined) return null;
  return { currentVersion: version, versions: value.versions };
}

/**
 * Remove `retired` from the envelope. **The current version is never removed**, whatever is asked, and a
 * version already gone is not an error — a retirement retried after it landed finds nothing left to do.
 */
export function retireVersions(value: VersionedValue, retired: readonly string[]): VersionedValue {
  const versions = Object.fromEntries(
    Object.entries(value.versions).filter(
      ([version]) => version === value.currentVersion || !retired.includes(version),
    ),
  );
  return { currentVersion: value.currentVersion, versions };
}

/** The highest existing version number — used only to pick the next on append (never to find "current"). */
function highestVersion(value: VersionedValue): number {
  const versions = Object.keys(value.versions)
    .map(Number)
    .filter((n) => Number.isInteger(n));
  if (versions.length === 0) {
    throw new SecretCryptoError({ detail: "decoded secret has no versions" });
  }
  return Math.max(...versions);
}

/** The current value — a direct lookup via the explicit `currentVersion` pointer, no sorting. */
export function currentValue(value: VersionedValue): string {
  const current = value.versions[value.currentVersion];
  if (current === undefined) {
    throw new SecretCryptoError({ detail: `currentVersion '${value.currentVersion}' is absent from versions` });
  }
  return current;
}

/** Serialize an envelope to the plaintext that goes into the AES-256-GCM envelope. */
export function encodeVersionedValue(value: VersionedValue): string {
  return JSON.stringify(VersionedValue.parse(value));
}

/** Parse decrypted plaintext into a validated envelope. Throws `secrets/crypto_failed` on a bad shape. */
export function decodeVersionedValue(plaintext: string): VersionedValue {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch (cause) {
    throw new SecretCryptoError({ detail: "decrypted secret plaintext is not valid JSON" }, { cause });
  }
  const result = VersionedValue.safeParse(parsed);
  if (!result.success) {
    throw new SecretCryptoError({ detail: "decrypted secret plaintext is not a versioned value" });
  }
  return result.data;
}
