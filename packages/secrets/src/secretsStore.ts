// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { InternalError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import {
  currentValue,
  decodeVersionedValue,
  initialVersionedValue,
  type VersionedValue,
} from "./crypto/versionedValue";
import { resolveBinding, type SecretBinding, type SecretsStoreEnv } from "./env/bindings";
import { SecretInvalidValueError, SecretNotFoundError } from "./error/errors";
import { keyedSecretName } from "./keyspace";
import type { KeyedSecretName, SecretName, SecretRegistry, SecretRegistryEntry, SecretValue } from "./registry";
import { SystemSecretsStore } from "./store/systemSecretsStore";

/**
 * The read seam. `secretsStore(env, registry)` resolves every declared secret locally — no RPC —
 * routing by backend (`d1` decrypts the per-environment row; `cf-secrets-store` reads the bound value)
 * and exposing one uniform API. The accessor's named methods are synchronous.
 *
 * **One path, every environment (#153).** There is no dev branch. `ENVIRONMENT` decides nothing here;
 * the environment is already expressed by which `SECRETS` D1 and which master key the worker is bound
 * to, so routing on it as well was a second answer to a question the bindings had already settled. It
 * had two costs. A `d1` secret resolved from a plaintext binding in dev, which is a shape production
 * never sees — so `pithy secrets rotate --env dev` exercised a code path only staging ran, and a
 * multi-version secret silently collapsed to one. And it made `.dev.vars` carry application secrets
 * under kebab registry names, in wrangler's `UPPER_SNAKE` env-binding file, teaching every adopter that
 * one of the two conventions was a mistake. Dev now reads the row `pithy dev` seeded, and `.dev.vars`
 * goes back to being what wrangler says it is.
 *
 * The cost is stated plainly: **a worker with any `d1` secret needs its `SECRETS` D1 and a master key in
 * dev too.** `pithy add secrets` mints both, and a project composing a capability that declares a `d1`
 * secret already had to.
 *
 * `get(name)` returns the current value — what almost every consumer wants. `getVersions(name)`
 * returns the current pointer plus every still-valid version — for the rare verifier that must
 * check a kid against every valid key (e.g. token verification across a signing-key rotation).
 * Both are available for every secret; the shape is not a per-secret switch.
 *
 * **A keyspace is the one asymmetry, and it is honest.** A `keyed` entry covers an unbounded set of
 * members whose keys exist only at runtime — one credential per tenant — so nothing is resolved for it
 * up front, and `getKeyed(name, key)` / `getKeyedVersions(name, key)` are async: they fetch exactly the
 * one member asked for, from the encrypted D1 store, in dev and deployed alike (nothing can inject a
 * name that does not exist at build time). Members are never cached — one tenant's credential must not
 * sit in an accessor the next request reuses.
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

/**
 * Fetches one keyspace member's stored envelope by its composed `<keyspace>/<key>` name, or
 * `undefined` when nothing is stored under it — which the accessor turns into `secrets/not_found`.
 * A seam, so the accessor's rules are testable without a D1; {@link d1KeyedSource} is the real one.
 */
export type KeyedSecretSource = (storedName: string) => Promise<VersionedValue | undefined>;

/**
 * The real keyed source: the per-environment encrypted D1 store, one member per read.
 *
 * The store is built per read rather than once, so it re-resolves the master key — a
 * `SECRETS_ENCRYPTION_KEYS` rotation is picked up instead of being pinned for the life of a cached
 * accessor. A keyspace has no other home: a Secrets Store binding is declared at build time and a
 * member's name is not — which is the argument that has now been made for every `d1` secret (#153).
 */
export function d1KeyedSource(env: SecretsStoreEnv): KeyedSecretSource {
  return async (storedName) => (await SystemSecretsStore.fromEnv(env)).getValue(storedName);
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
 * Decode a **`cf-secrets-store`** binding's value into the uniform envelope. The canonical (provisioned)
 * value is a JSON-encoded {@link VersionedValue}, so a value pithy wrote round-trips as
 * `{ currentVersion, versions }`; anything else is wrapped as a one-version envelope, and the same
 * accessor path serves both.
 *
 * **The wrap is permanent, and it is not leniency left over from #149.** A Secrets Store entry has no
 * envelope to find and never will: `pithy token mint` writes a raw token through `putSecret`, and an
 * entry set by hand in the dashboard or by `wrangler secrets-store secret create` is a plain string too.
 * Refusing one would refuse the two ways the platform's own tooling writes a secret.
 *
 * It is no longer reachable with a `d1` entry. A `d1` secret's stored shape is always an envelope and
 * always comes from the row — in dev exactly as deployed since #153 — so there is nothing left here to
 * reinterpret it as. See {@link secretsStore}'s `unprovisioned`, which is where a `d1` secret handed a
 * binding instead of a row is now answered.
 */
function decodeInjectedValue(raw: string): VersionedValue {
  try {
    return decodeVersionedValue(raw);
  } catch {
    // Not a serialized envelope — a raw Secrets Store entry. Wrap it as a single version.
    return initialVersionedValue(raw);
  }
}

/** Resolve a `cf-secrets-store` binding's value as the uniform envelope. */
function resolveInjected(entry: SecretRegistryEntry, name: string, raw: string): Resolved {
  return resolveVersioned(entry, name, decodeInjectedValue(raw));
}

/**
 * The resolved, typed accessor. The named methods are synchronous — every value was materialized by
 * `secretsStore`; the keyed ones are not, because a keyspace member is fetched at the read. Resolved
 * plaintext lives in `#private` fields, and `toJSON` redacts, so a stray `logger.info({ secrets })`
 * surfaces only the count.
 */
export class SecretsAccessor<R extends SecretRegistry> {
  readonly #registry: R;
  readonly #resolved: Record<string, Resolved>;
  readonly #keyedSource: KeyedSecretSource | undefined;

  constructor(registry: R, resolved: Record<string, Resolved>, keyedSource?: KeyedSecretSource) {
    this.#registry = registry;
    this.#resolved = resolved;
    this.#keyedSource = keyedSource;
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
   * The current value of one member of a declared keyspace — the credential `key` names. Async
   * because it is fetched now: a keyspace is unbounded, so nothing was resolved for it up front.
   */
  async getKeyed<K extends KeyedSecretName<R>>(name: K, key: string): Promise<SecretValue<R[K]>> {
    return (await this.#loadKeyed(name, key)).current as SecretValue<R[K]>;
  }

  /**
   * The current pointer plus every still-valid version of one keyspace member — what a verifier needs
   * mid-rotation, when a tenant's retired key must still be honoured alongside its new one.
   */
  async getKeyedVersions<K extends KeyedSecretName<R>>(name: K, key: string): Promise<VersionedSecret<R[K]>> {
    const resolved = await this.#loadKeyed(name, key);
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
   *
   * `keyedSource` defaults to this accessor's own. The shared store passes the current invocation's
   * instead: it hands out views over an accessor cached across requests, and a keyspace read is real
   * I/O, which must run through the binding of the request making it — not of whichever request
   * happened to fill the cache.
   */
  subset<R2 extends SecretRegistry>(
    registry: R2,
    keyedSource: KeyedSecretSource | undefined = this.#keyedSource,
  ): SecretsAccessor<R2> {
    const resolved: Record<string, Resolved> = {};
    for (const name of Object.keys(registry)) {
      const value = this.#resolved[name];
      if (value) resolved[name] = value;
    }
    return new SecretsAccessor(registry, resolved, keyedSource);
  }

  /**
   * Resolve one keyspace member. The key is validated and composed by {@link keyedSecretName} — the
   * one place a member name is ever built — so a key can neither escape into a neighbouring keyspace
   * nor land on a named entry. A member with no stored value throws instead of resolving `undefined`.
   *
   * Every failure names the keyspace and never the key: `detail` reaches logs verbatim, and the key
   * is caller input identifying one tenant.
   */
  async #loadKeyed(name: string, key: string): Promise<Resolved> {
    const entry = this.#registry[name];
    if (!entry) {
      throw new SecretNotFoundError({ detail: `keyspace '${name}' is not declared in this registry` });
    }
    if (!entry.keyed) {
      throw new InternalError({
        message: `Secret '${name}' is not a keyspace.`,
        action: "Read a named secret with get(name), or declare the entry keyed.",
        detail: `getKeyed called on named secret '${name}'`,
      });
    }
    if (!this.#keyedSource) {
      throw new InternalError({
        message: `Secret '${name}' cannot be read here.`,
        detail: `keyspace '${name}' read from an accessor built without a keyed source`,
      });
    }
    const stored = await this.#keyedSource(keyedSecretName(name, key));
    if (!stored) {
      throw new SecretNotFoundError({
        message: `Secret '${name}' has no value for that key.`,
        detail: `keyspace '${name}': no member stored under the requested key`,
      });
    }
    // Parsed against the keyspace's name, not the member's, so a malformed member says which keyspace
    // it belongs to without putting a tenant identifier in the log.
    return resolveVersioned(entry, name, stored);
  }

  #require(name: string): Resolved {
    if (!(name in this.#registry)) {
      throw new SecretNotFoundError({ detail: `secret '${name}' is not declared in this registry` });
    }
    if (this.#registry[name]?.keyed) {
      throw new InternalError({
        message: `Secret '${name}' is a keyspace, not a single value.`,
        action: "Read one member with getKeyed(name, key).",
        detail: `get called on keyspace '${name}'`,
      });
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
 * Resolve every secret declared in `registry` from `env` and return a typed accessor. **Routing is by
 * registry backend and nothing else**, in every environment: `d1` entries are decrypted in one batch
 * from the per-environment store, `cf-secrets-store` entries are read from their bound values. A
 * declared secret with no value throws so a missing secret fails loudly, never as a silent `undefined`.
 * A keyed entry resolves nothing here — it declares a keyspace, not a value — and its members are
 * fetched at the read.
 *
 * Nothing reads `ENVIRONMENT`. A `d1` secret cannot be shadowed by a plaintext binding anywhere, which
 * used to be true only of deployed workers.
 */
export async function secretsStore<R extends SecretRegistry>(
  env: SecretsStoreEnv,
  registry: R,
): Promise<SecretsAccessor<R>> {
  const resolved: Record<string, Resolved> = {};
  const bindings = env as unknown as Record<string, SecretBinding | string | undefined>;

  const d1Names: string[] = [];
  const cfNames: string[] = [];
  for (const name of Object.keys(registry)) {
    const entry = registry[name];
    // Keyspaces are skipped: batching one would mean decrypting every tenant's credential to serve a
    // request that wants one, which is the shape this entry type exists to avoid.
    if (!entry || entry.keyed) continue;
    if (entry.backend === "cf-secrets-store") cfNames.push(name);
    else d1Names.push(name);
  }

  if (d1Names.length > 0) {
    const store = await SystemSecretsStore.fromEnv(env);
    const values = await store.getValues(d1Names);
    for (const name of d1Names) {
      const entry = registry[name];
      const value = values[name];
      if (!entry) continue;
      if (!value) throw unprovisioned(name, isBound(bindings, name));
      resolved[name] = resolveVersioned(entry, name, value);
    }
  }

  for (const name of cfNames) {
    const entry = registry[name];
    if (!entry) continue;
    const raw = await resolveBinding(bindings[name], name);
    resolved[name] = resolveInjected(entry, name, raw);
  }

  return new SecretsAccessor(registry, resolved, d1KeyedSource(env));
}

/**
 * Whether a binding of this name is present and carries something — the one question a `d1` secret with
 * no row has to ask before it says what is wrong.
 *
 * `Object.hasOwn`, never `in`: `env` is an ordinary object, so `in` finds `constructor` and `toString`
 * on the prototype and would report a binding for a secret a capability chose to name either one.
 */
function isBound(bindings: Record<string, SecretBinding | string | undefined>, name: string): boolean {
  if (!Object.hasOwn(bindings, name)) return false;
  const value = bindings[name];
  if (typeof value === "string") return value !== "";
  return typeof value?.get === "function";
}

/**
 * What a declared `d1` secret with no row is told — and it is two different sentences, because it is two
 * different mistakes.
 *
 * With no binding it is the plain case: nothing has provisioned it. With a binding of the same name it
 * is the #153 case, and the binding is the reason the reader is confused rather than a place to fall
 * back to. Dev used to resolve exactly that string, so this is the one shape an upgrade produces: an
 * adopter's pre-#149 `.dev.vars` line, or a Workers-runtime test injecting a `d1` value as a bare
 * string. Reading it would put back the asymmetry this change removed; saying nothing about it would
 * answer "not provisioned" about a value sitting right there. So it is named, with the fix.
 *
 * `validation/invalid_input` rather than `secrets/not_found`: the store is not missing a value, the
 * caller supplied one in a place it is never read from. Never echoes the value.
 */
function unprovisioned(name: string, bound: boolean): Error {
  if (!bound) {
    return new SecretNotFoundError({
      message: `Secret '${name}' is declared but not provisioned.`,
      detail: `d1 secret '${name}' has no row in the secrets store`,
    });
  }
  return new ValidationError({
    message: `Secret '${name}' is bound as a plain value, and a d1 secret is never read from a binding.`,
    action: `Put '${name}' in the dev secrets file and run pithy seed. Deployed environments get it from pithy secrets create.`,
    detail: `d1 secret '${name}' has no row in the secrets store, and a binding of the same name was ignored`,
  });
}
