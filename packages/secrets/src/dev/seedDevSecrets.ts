// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { bindingValue } from "../bindingValue";
import type { VersionedValue } from "../crypto/versionedValue";
import { mintSecretValue } from "../mintValue";
import type { SecretRegistry, SecretRegistryEntry, SecretValueType } from "../registry";
import { DEV_SECRETS_FILE, type DevSecretEnvelope, type DevSecretsFile, initialDevSecret } from "./devSecretsFile";

/**
 * Seed a project's local dev secrets from the dev secrets file, with the **registry** deciding each
 * secret's destination. The file states values; it never states where one goes. The registry already
 * knows `backend`, so there is one source of truth and the two cannot disagree.
 *
 *   `d1`               → an encrypted row in the local `SECRETS` D1, under the dev master key, in
 *                        exactly the shape a provisioned secret has.
 *   `cf-secrets-store` → returned as a `.dev.vars` line. There is no local Secrets Store, and the
 *                        binding is the only place a worker can read it from in dev.
 *
 * **Nothing here writes a file.** `.dev.vars` belongs to the CLI, which owns file modes, the shared
 * symlink, and not clobbering an adopter's hand-written lines. This returns what should be written —
 * the same rule the loader follows for reading.
 *
 * **Idempotent, and it does not rotate.** A secret already stored with the value the file states is
 * left untouched (no re-encrypt, no `updatedAt` churn); a secret the file has changed is written
 * through, because the file is the source of truth for dev. A secret already *in the file* is never
 * minted again — a fresh session key invalidates every live session, and a fresh link key breaks
 * every link already in an inbox.
 */

/**
 * The store seam — the two operations seeding needs from the per-environment encrypted D1 store.
 * `SystemSecretsStore` satisfies it structurally, so the CLI passes the real one and tests pass an
 * in-memory double without a D1.
 */
export interface DevSecretsStore {
  /** The stored envelope for one secret, or `undefined` when nothing is stored under that name. */
  getValue(name: string): Promise<VersionedValue | undefined>;
  /** Encrypt and upsert one secret's envelope under the master key. */
  put(name: string, value: VersionedValue, valueType: SecretValueType): Promise<void>;
}

/** What {@link seedDevSecrets} needs: the loaded file, the project's registry, and the local store. */
export interface SeedDevSecretsInput {
  /** The parsed dev secrets file, as `loadDevSecrets` returns it. */
  file: DevSecretsFile;
  /** The project's combined secret registry — the authority on backend, value type, and schema. */
  registry: SecretRegistry;
  /** The local `SECRETS` D1 store, for `d1`-backed secrets. */
  store: DevSecretsStore;
  /** The absolute path to name in errors. Defaults to the file's bare name — see {@link DEV_SECRETS_FILE}. */
  path?: string;
}

/** What one seed run did, and what the CLI must write. Every list is sorted, so a run is reproducible. */
export interface DevSecretsSeedResult {
  /** `d1` secrets written to the store this run — new, or changed in the file. */
  seeded: readonly string[];
  /** `d1` secrets already stored with the value the file states. Left untouched. */
  unchanged: readonly string[];
  /** `cf-secrets-store` secrets, as the `.dev.vars` lines the CLI should write. Never a file write here. */
  devVars: Readonly<Record<string, string>>;
  /** Values minted this run, for the CLI to write back into the dev secrets file as version-1 envelopes. */
  minted: DevSecretsFile;
  /** Declared secrets with no value and nothing honest to mint — the CLI names them and says where they come from. */
  missing: readonly string[];
  /** Names in the file that no capability declares. Reported, not fatal: a removed capability must not brick dev. */
  undeclared: readonly string[];
}

/**
 * Seed every declared secret. Throws `validation/invalid_input` — naming the secret, never echoing
 * its value — when the file and the registry disagree about a value's shape.
 */
export async function seedDevSecrets(input: SeedDevSecretsInput): Promise<DevSecretsSeedResult> {
  const { file, registry, store } = input;
  const path = input.path ?? DEV_SECRETS_FILE;

  const seeded: string[] = [];
  const unchanged: string[] = [];
  const missing: string[] = [];
  const devVars: Record<string, string> = {};
  // Every mint happens here, before a single store write, so a caller that wants to persist the file
  // first can do exactly that: mint, write, then seed with the values already on disk. The CLI does.
  const minted = mintMissingDevSecrets(file, registry);

  for (const name of Object.keys(registry).sort()) {
    const entry = registry[name];
    if (!entry) continue;
    // A keyspace declares an unbounded set of members whose keys exist only at runtime. It has no one
    // value to seed, and the app writes its members itself — so it is neither seeded nor missing.
    if (entry.keyed) {
      if (file[name]) throw keyedSecretRefusal(name, path);
      continue;
    }

    // Present-in-the-file always wins, whatever is stored and whatever was minted above.
    const envelope = file[name] ?? minted[name];
    if (!envelope) {
      missing.push(name);
      continue;
    }

    const value = storedSecretValue(entry, name, envelope, path);

    if (entry.backend === "cf-secrets-store") {
      devVars[name] = bindingValue(entry, value);
      continue;
    }

    const stored = await store.getValue(name);
    if (stored && sameEnvelope(stored, value)) {
      unchanged.push(name);
      continue;
    }
    await store.put(name, value, entry.valueType);
    seeded.push(name);
  }

  // `Object.hasOwn`, not `in`: `in` walks the prototype chain, so a stale `toString` left in the file
  // read as declared by every capability and was never reported.
  const undeclared = Object.keys(file)
    .filter((name) => !Object.hasOwn(registry, name))
    .sort();

  return { seeded, unchanged, devVars, minted, missing, undeclared };
}

/**
 * The refusal a keyspace given a single value in the dev secrets file earns.
 *
 * **A function rather than a `throw` written inline, because `pithy doctor` has to be able to say this
 * without running a seed (#325).** Doctor's promise is that a green report means the next `pithy seed`
 * works, and it kept that promise for every *stated* value by judging through {@link storedSecretValue} —
 * but a keyspace never reached that call in either command, so the one input the seeder hard-fails on was
 * the one input doctor passed. A second wording of the same rule is how the promise stops being true
 * without anybody noticing; there is one wording, and it lives here beside the throw.
 */
export function keyedSecretRefusal(name: string, path: string): ValidationError {
  return new ValidationError({
    message: `Secret '${name}' in ${path} is a keyspace, not a single value.`,
    action: "Remove it. Its members are written by the app at runtime, one per key.",
    detail: `dev secrets file '${path}': keyed entry '${name}' given a value`,
  });
}

/**
 * Every `cf-secrets-store` secret the file states, as the `.dev.vars` lines a Worker reads them from.
 *
 * **The one materialisation, so the seeder's report and the generated file cannot disagree.** Dev has no
 * Secrets Store, so a binding is the only place one of these can come from — and since the generator
 * builds each Worker's `.dev.vars` from the dev secrets file directly (#179), the generator and the
 * seeder are two callers of this rather than two copies of it.
 *
 * A secret with no value in the file is simply absent, exactly as a Worker with no binding is: this
 * answers what *can* be materialised, and {@link seedDevSecrets} is what reports the rest as missing.
 */
export function devVarsForRegistry(
  file: DevSecretsFile,
  registry: SecretRegistry,
  path: string = DEV_SECRETS_FILE,
): Record<string, string> {
  const devVars: Record<string, string> = {};
  for (const name of Object.keys(registry).sort()) {
    const entry = registry[name];
    if (!entry || entry.keyed || entry.backend !== "cf-secrets-store") continue;
    const envelope = file[name];
    if (!envelope) continue;
    devVars[name] = bindingValue(entry, storedSecretValue(entry, name, envelope, path));
  }
  return devVars;
}

/**
 * Every secret the registry says may be minted and the file does not already carry, minted — and
 * **nothing written anywhere**. The one place that decides what a mint is, so `seedDevSecrets` and a
 * caller that needs the values before seeding cannot drift into two rules.
 *
 * That ordering is the point of exporting it. The CLI mints, persists the dev secrets file, then
 * seeds: a store write that lands before the file does leaves a row no file explains, and the next
 * run mints a different value and overwrites it — a session secret that changes on every `pithy dev`
 * for as long as the file write keeps failing.
 *
 * A keyspace is skipped: its members exist only at runtime, so there is no one value to mint. A secret
 * with no `devValue` is skipped too — nothing here invents a value something outside the project has
 * to agree with.
 */
export function mintMissingDevSecrets(file: DevSecretsFile, registry: SecretRegistry): DevSecretsFile {
  const minted: DevSecretsFile = {};
  for (const name of Object.keys(registry).sort()) {
    const entry = registry[name];
    if (!entry || entry.keyed || !entry.devValue) continue;
    if (Object.hasOwn(file, name)) continue;
    minted[name] = initialDevSecret(mintSecretValue(entry.devValue));
  }
  return minted;
}

/**
 * Convert one file envelope into the envelope the store holds: every version validated against the
 * registry entry and reduced to the string form a stored secret has. A `text` version must be a
 * string — a number or an object there is a hand-edit slip, not a value. A `json` version is parsed
 * by the entry's schema and re-serialized canonically, which is exactly what the read seam expects to
 * find and what `validateSecretValue` produces for a CLI write.
 *
 * Errors carry only the secret name, the version key, and Zod `path:code` pairs. Never `issue.message`
 * or `received`, either of which can echo credential material into a terminal or a log.
 */
export function storedSecretValue(
  entry: SecretRegistryEntry,
  name: string,
  envelope: DevSecretEnvelope,
  path: string = DEV_SECRETS_FILE,
): VersionedValue {
  const versions: Record<string, string> = {};
  for (const [version, value] of Object.entries(envelope.versions)) {
    versions[version] = storedVersion(entry, name, version, value, path);
  }
  return { currentVersion: envelope.currentVersion, versions };
}

/** One version's value, in the string form the store holds. */
function storedVersion(
  entry: SecretRegistryEntry,
  name: string,
  version: string,
  value: unknown,
  path: string,
): string {
  if (entry.valueType === "text") {
    if (typeof value !== "string") {
      throw new ValidationError({
        message: `Secret '${name}' in ${path} has a version '${version}' that is not a string.`,
        action: `'${name}' is a text secret. Quote the value.`,
        detail: `dev secrets file '${path}': text secret '${name}' version '${version}' is ${typeof value}`,
      });
    }
    return value;
  }

  const result = entry.schema.safeParse(value);
  if (!result.success) {
    const summary = result.error.issues.map((i) => `${i.path.join(".") || "<root>"}:${i.code}`).join(", ");
    throw new ValidationError({
      message: `Secret '${name}' in ${path} failed validation at version '${version}'.`,
      action: `Match the shape ${name} declares. The capability that owns it defines the schema.`,
      detail: `dev secrets file '${path}': json secret '${name}' version '${version}' failed registry validation: ${summary}`,
    });
  }
  return JSON.stringify(result.data);
}

/**
 * Whether the stored envelope already is the one the file states. A match skips the write entirely:
 * re-encrypting an unchanged value would churn `updatedAt` and the ciphertext on every `pithy dev`,
 * which is the difference between idempotent and merely convergent.
 *
 * Compared version by version rather than on the serialized form, because key order in `versions` is
 * whatever the file happened to list — reordering two lines is not a value change, and treating it as
 * one would rewrite the row for nothing.
 */
function sameEnvelope(stored: VersionedValue, next: VersionedValue): boolean {
  if (stored.currentVersion !== next.currentVersion) return false;
  const keys = Object.keys(next.versions);
  if (Object.keys(stored.versions).length !== keys.length) return false;
  return keys.every((version) => stored.versions[version] === next.versions[version]);
}
