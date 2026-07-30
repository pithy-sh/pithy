// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import {
  currentValue,
  decodeVersionedValue,
  initialVersionedValue,
  type VersionedValue,
} from "./crypto/versionedValue";
import { resolveBinding, type SecretBinding, type SecretsStoreEnv } from "./env/bindings";
import { SecretInvalidValueError, SecretNotFoundError } from "./error/errors";
import type { SecretName, SecretRegistry, SecretRegistryEntry, SecretValue } from "./registry";
import { ManagedEnvironment } from "./scope";
import { SystemSecretsStore } from "./store/systemSecretsStore";

/**
 * The read seam. `secretsStore(env, registry)` resolves every declared secret locally — no RPC —
 * routing by backend (`d1` decrypts the per-environment row; `cf-secrets-store` reads the bound
 * value) and exposing one uniform API. The call site is identical across environments. Whether the
 * worker is deployed is decided by **one explicit signal — the `ENVIRONMENT` var** (a `ManagedEnvironment`
 * means deployed): in local dev **every** secret resolves from its injected `.dev.vars` string (same shape
 * as stored), so dev needs no `SECRETS` D1 or master key; deployed reads route strictly by backend, so a
 * stray plaintext binding can never shadow a `d1` secret. The accessor's methods are synchronous.
 *
 * `get(name)` returns the current value — what almost every consumer wants. `getVersions(name)`
 * returns the current pointer plus every still-valid version — for the rare verifier that must
 * check a kid against every valid key (e.g. token verification across a signing-key rotation).
 * Both are available for every secret; the shape is not a per-secret switch.
 *
 * The master key never leaves the worker, and resolved plaintext is held in `#private` fields so
 * it cannot leak via `JSON.stringify`, structured logging, or object spread.
 */

/** A secret's resolved versions: the current pointer plus every still-valid version, parsed. */
export interface VersionedSecret<E extends SecretRegistryEntry> {
  /** The version key whose value is current. */
  currentVersion: string;
  /** Every still-valid version: version key → parsed value. */
  versions: Record<string, SecretValue<E>>;
}

/** Internal per-secret resolved shape — values already parsed to their value type. */
interface Resolved {
  current: unknown;
  currentVersion: string;
  versions: Record<string, unknown>;
}

/** Parse a raw stored string into the entry's value type: `text` passes through, `json` is validated. */
function parseValue(entry: SecretRegistryEntry, name: string, raw: string): unknown {
  if (entry.valueType === "text") return raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    // Never echo the payload — it is sensitive credential material.
    throw new SecretInvalidValueError(
      { message: `Secret '${name}' is not valid JSON.`, detail: `json secret '${name}' failed to parse` },
      { cause },
    );
  }
  const result = entry.schema.safeParse(parsed);
  if (!result.success) {
    // Only path + code — never `issue.message`/`received`, which can echo the secret value.
    const summary = result.error.issues.map((i) => `${i.path.join(".") || "<root>"}:${i.code}`).join(", ");
    throw new SecretInvalidValueError({
      message: `Secret '${name}' failed validation.`,
      detail: `json secret '${name}' failed registry validation: ${summary}`,
    });
  }
  return result.data;
}

/** Resolve a decrypted value envelope (a `d1` secret), parsing every version. */
function resolveVersioned(entry: SecretRegistryEntry, name: string, value: VersionedValue): Resolved {
  const versions: Record<string, unknown> = {};
  for (const [version, raw] of Object.entries(value.versions)) versions[version] = parseValue(entry, name, raw);
  return { current: parseValue(entry, name, currentValue(value)), currentVersion: value.currentVersion, versions };
}

/**
 * Decode an injected (non-D1-row) value into the uniform envelope. The canonical (provisioned) value is
 * a JSON-encoded {@link VersionedValue}, so a deployed secret round-trips as `{ currentVersion, versions }`.
 * Local dev `.dev.vars` supplies a bare string instead (wrangler's own `CLOUDFLARE_API_TOKEN`
 * convention), so a raw value that is not a valid envelope is wrapped as a one-version envelope — the
 * same accessor path serves both. A single-version secret is always a one-entry envelope. Used for
 * `cf-secrets-store` bindings and for the local-dev `.dev.vars` form of a `d1` secret alike.
 */
function decodeInjectedValue(raw: string): VersionedValue {
  try {
    return decodeVersionedValue(raw);
  } catch {
    // Not a serialized envelope — a bare `.dev.vars` string. Wrap it as a single version.
    return initialVersionedValue(raw);
  }
}

/** Resolve an injected (`cf-secrets-store` binding or local-dev `d1`) value as the uniform envelope. */
function resolveInjected(entry: SecretRegistryEntry, name: string, raw: string): Resolved {
  return resolveVersioned(entry, name, decodeInjectedValue(raw));
}

/**
 * The resolved, typed accessor. Methods are synchronous — every value was materialized by
 * `secretsStore`. Resolved plaintext lives in `#private` fields, and `toJSON` redacts, so a stray
 * `logger.info({ secrets })` surfaces only the count.
 */
export class SecretsAccessor<R extends SecretRegistry> {
  readonly #registry: R;
  readonly #resolved: Record<string, Resolved>;

  constructor(registry: R, resolved: Record<string, Resolved>) {
    this.#registry = registry;
    this.#resolved = resolved;
  }

  /** The current value of a declared secret. */
  get<K extends SecretName<R>>(name: K): SecretValue<R[K]> {
    return this.#require(name).current as SecretValue<R[K]>;
  }

  /** The current pointer plus every still-valid version of a declared secret. */
  getVersions<K extends SecretName<R>>(name: K): VersionedSecret<R[K]> {
    const resolved = this.#require(name);
    return {
      currentVersion: resolved.currentVersion,
      versions: resolved.versions as Record<string, SecretValue<R[K]>>,
    };
  }

  /**
   * A typed view over a subset of this accessor, restricted to `registry`'s names and sharing the
   * already-resolved values — no re-fetch. Used by the shared per-invocation accessor: the combined
   * registry is resolved once, then each capability gets a precisely-typed accessor over only its own
   * slice. A name in `registry` that this accessor never resolved is simply absent, so a later
   * `get`/`getVersions` fails loudly as `secrets/not_found` rather than returning a silent `undefined`.
   */
  subset<R2 extends SecretRegistry>(registry: R2): SecretsAccessor<R2> {
    const resolved: Record<string, Resolved> = {};
    for (const name of Object.keys(registry)) {
      const value = this.#resolved[name];
      if (value) resolved[name] = value;
    }
    return new SecretsAccessor(registry, resolved);
  }

  #require(name: string): Resolved {
    if (!(name in this.#registry)) {
      throw new SecretNotFoundError({ detail: `secret '${name}' is not declared in this registry` });
    }
    const resolved = this.#resolved[name];
    if (!resolved) {
      throw new SecretNotFoundError({
        message: `Secret '${name}' is declared but not provisioned.`,
        detail: `secret '${name}' declared but absent from the resolved batch`,
      });
    }
    return resolved;
  }

  /** Redacted serialization — never the values. */
  toJSON(): string {
    return `[Secrets declared=${Object.keys(this.#registry).length}]`;
  }
}

/**
 * Resolve every secret declared in `registry` from `env` and return a typed accessor. `d1` entries
 * are decrypted in one batch from the per-environment store; `cf-secrets-store` entries are read
 * from their bound values (or `.dev.vars` strings). A declared secret with no value throws
 * `secrets/not_found` so a missing secret fails loudly, never as a silent `undefined`.
 */
export async function secretsStore<R extends SecretRegistry>(
  env: SecretsStoreEnv,
  registry: R,
): Promise<SecretsAccessor<R>> {
  const resolved: Record<string, Resolved> = {};
  const bindings = env as unknown as Record<string, SecretBinding | string | undefined>;

  // **One explicit signal decides dev vs deployed: `ENVIRONMENT`.** It is stamped into each deployed
  // worker's vars at provision (`staging` | `production`); when it is not a `ManagedEnvironment` (absent,
  // or local dev) the worker is in dev. This is the *only* thing that flips resolution — never the runtime
  // shape of a value — so a stray plaintext binding can never make a deployed `d1` secret read unencrypted.
  const deployedEnv = ManagedEnvironment.safeParse(bindings.ENVIRONMENT);

  if (!deployedEnv.success) {
    // **Local dev is uniform.** Whatever a secret's registry backend, in dev it is injected as a
    // `.dev.vars` string in the same shape it is stored — so every secret resolves through this one seam,
    // and dev needs no `SECRETS` D1, master key, or live Secrets Store.
    for (const name of Object.keys(registry)) {
      const entry = registry[name];
      if (!entry) continue;
      const raw = await resolveBinding(bindings[name], name);
      resolved[name] = resolveInjected(entry, name, raw);
    }
    return new SecretsAccessor(registry, resolved);
  }

  // **Deployed: route strictly by registry backend.** `d1` secrets are ALWAYS decrypted from the
  // per-environment store (no plaintext shadow); `cf-secrets-store` secrets are read from their bindings.
  const d1Names: string[] = [];
  const cfNames: string[] = [];
  for (const name of Object.keys(registry)) {
    if (!registry[name]) continue;
    if (registry[name]?.backend === "cf-secrets-store") cfNames.push(name);
    else d1Names.push(name);
  }

  if (d1Names.length > 0) {
    const store = await SystemSecretsStore.fromEnv(env);
    const values = await store.getValues(d1Names);
    for (const name of d1Names) {
      const entry = registry[name];
      const value = values[name];
      if (!entry) continue;
      if (!value) {
        throw new SecretNotFoundError({
          message: `Secret '${name}' is declared but not provisioned.`,
          detail: `d1 secret '${name}' has no row in the secrets store`,
        });
      }
      resolved[name] = resolveVersioned(entry, name, value);
    }
  }

  for (const name of cfNames) {
    const entry = registry[name];
    if (!entry) continue;
    const raw = await resolveBinding(bindings[name], name);
    resolved[name] = resolveInjected(entry, name, raw);
  }

  return new SecretsAccessor(registry, resolved);
}
