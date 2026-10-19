// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import {
  decodeVersionedValue,
  encodeVersionedValue,
  retireVersions,
  rotatedValue,
  type VersionedValue,
} from "../crypto/versionedValue";
import { SecretNotFoundError } from "../error/errors";
import type { SecretValueType } from "../registry";
import type { SystemSecretsStore } from "../store/systemSecretsStore";
import { fingerprintVersions } from "./reencryption";

/**
 * **Where a rotation appends a version and, an overlap later, retires the one it replaced (#602).**
 *
 * `pithy secrets update` writes a fresh one-version envelope, which is right for a value pasted from a
 * console and wrong for a rotation: every reader of the old value fails the moment it lands. A rotation
 * keeps the old version beside the new one for the secret's declared overlap, so this seam has two writes
 * and neither of them is `update`.
 *
 * One shape over both backends, because the envelope is the same on both — `{ currentVersion, versions }`,
 * sealed in a D1 row or held as the plaintext of a Secrets Store entry. Only how it is read and written
 * differs, and that is all {@link EnvelopeIO} is.
 *
 * **Version keys cross this seam; values never do.** `append` takes the successor in and hands back its
 * version key and the keys it overlaps. Nothing returned here can carry a secret, so a Workflow step that
 * journals the answer journals no value. `fingerprints` is the one read that says anything about a value,
 * and what it says is a key-check value (`./reencryption.ts`), never the value.
 */

/** What an append did: the version the successor is current under, and every version it now overlaps. */
export interface AppendedVersion {
  /** The successor's version key. */
  version: string;
  /** The versions still in the envelope beside it — what a retirement removes once the overlap has passed. */
  prior: string[];
}

/** An envelope's version keys, without a value. */
export interface StoredVersions {
  /** The version key reads resolve to. */
  current: string;
  /** Every version key the envelope holds, current included, in numeric order. */
  versions: string[];
}

/** A rotation's two writes against one backend, and the read that plans them. */
export interface VersionedSecretStore {
  /** Make `value` the current version of `name`, keeping every prior one. Idempotent on the value. */
  append(name: string, value: string): Promise<AppendedVersion>;
  /** Remove `versions` from `name`. The current version is never removed; one already gone is not an error. */
  retire(name: string, versions: readonly string[]): Promise<StoredVersions>;
  /** The version keys `name` holds, or `undefined` when nothing is stored under it. */
  versions(name: string): Promise<StoredVersions | undefined>;
  /** Each version's fingerprint, by version key — what a re-encryption record is checked against. */
  fingerprints(name: string): Promise<Record<string, string> | undefined>;
}

/** How one backend reads and writes a whole envelope. */
export interface EnvelopeIO {
  /** The stored envelope, or `undefined` when nothing is stored under `name`. */
  read(name: string): Promise<VersionedValue | undefined>;
  /** Replace the stored envelope with `value`. */
  write(name: string, value: VersionedValue): Promise<void>;
}

/** Version keys, numerically sorted — so `"10"` follows `"9"` rather than `"1"`. */
function sortedVersions(value: VersionedValue): StoredVersions {
  return {
    current: value.currentVersion,
    versions: Object.keys(value.versions).sort((left, right) => Number(left) - Number(right)),
  };
}

/** Read `name`, refusing a name with nothing stored — a rotation of nothing has no version to keep. */
async function requireStored(io: EnvelopeIO, name: string): Promise<VersionedValue> {
  const value = await io.read(name);
  if (value === undefined) {
    throw new SecretNotFoundError({
      message: `Secret '${name}' has never been stored here, so there is nothing to rotate.`,
      detail: `value rotation of '${name}': no stored envelope to append to`,
    });
  }
  return value;
}

/** The version store over any backend that can read and write a whole envelope. */
export function envelopeVersionStore(io: EnvelopeIO): VersionedSecretStore {
  return {
    async append(name, value) {
      const stored = await requireStored(io, name);
      const rotated = rotatedValue(stored, value);
      // Nothing to write when the successor is already current: this attempt is a retry of one that landed.
      if (rotated.value !== stored) await io.write(name, rotated.value);
      return { version: rotated.version, prior: rotated.prior };
    },
    async retire(name, versions) {
      const stored = await requireStored(io, name);
      const retired = retireVersions(stored, versions);
      if (Object.keys(retired.versions).length !== Object.keys(stored.versions).length) {
        await io.write(name, retired);
      }
      return sortedVersions(retired);
    },
    async versions(name) {
      const stored = await io.read(name);
      return stored === undefined ? undefined : sortedVersions(stored);
    },
    async fingerprints(name) {
      const stored = await io.read(name);
      return stored === undefined ? undefined : await fingerprintVersions(stored.versions);
    },
  };
}

/** The version store over this environment's D1 vault: an envelope sealed under the master key, one row per name. */
export function d1VersionStore(store: SystemSecretsStore, valueType: SecretValueType): VersionedSecretStore {
  return envelopeVersionStore({
    read: (name) => store.getValue(name),
    write: (name, value) => store.put(name, value, valueType),
  });
}

/**
 * How a Secrets Store entry is reached from the Worker rotating it: **read through its binding, written over
 * REST.** Neither half can do the other's job — Cloudflare never serves a value over the API, and a binding
 * is read-only — so a rotation needs both, keyed by the registry name.
 */
export interface StoreEntryIO {
  /** The entry's plaintext through the Worker's binding for `name`, or `undefined` when it is not bound. */
  read(name: string): Promise<string | undefined>;
  /** Replace the entry for `name` with `text`, over the Secrets Store REST API. */
  write(name: string, text: string): Promise<void>;
}

/** The version store over a Secrets Store entry. The entry's plaintext is the encoded envelope, as every reader expects. */
export function secretsStoreVersionStore(io: StoreEntryIO): VersionedSecretStore {
  return envelopeVersionStore({
    read: async (name) => {
      const text = await io.read(name);
      return text === undefined ? undefined : decodeVersionedValue(text);
    },
    write: (name, value) => io.write(name, encodeVersionedValue(value)),
  });
}
