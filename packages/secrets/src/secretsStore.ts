// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { AuditActorType, AuditOutcome } from "@pithy-sh/core/src/audit/auditEvent";
import type { AuditEmit } from "@pithy-sh/core/src/audit/recorder";
import { InternalError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { type SecretsAuditAction, SecretsAuditActions } from "./audit/actions";
import {
  currentValue,
  decodeVersionedValue,
  initialVersionedValue,
  type VersionedValue,
} from "./crypto/versionedValue";
import { resolveBinding, type SecretBinding, type SecretsStoreEnv } from "./env/bindings";
import { SecretInvalidValueError, SecretNotFoundError } from "./error/errors";
import { keyedSecretName } from "./keyspace";
import { type KeyedMemberWrite, type KeyedWriteMode, runKeyedRemove, runKeyedWrite } from "./keyspaceWrite";
import type { KeyedSecretName, SecretName, SecretRegistry, SecretRegistryEntry, SecretValue } from "./registry";
import { RotationTracker } from "./store/rotationTracker";
import { type StoredSecretValue, SystemSecretsStore, unreadableSecret } from "./store/systemSecretsStore";

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
 * **A failure belongs to its secret, not to the batch (#170).** Resolution is eager, so one unset
 * secret used to take the whole accessor down — and the accessor is shared, so an unconfigured OAuth
 * provider in `auth` stopped `payments` reading a webhook key, in a capability that never mentions it.
 * The registry already says which secrets are conditional ("read only when the provider is enabled"),
 * and eager resolution turned every one of them into a boot requirement. So a secret that fails to
 * resolve holds its error instead of throwing it, and the error is raised by the read of *that* secret.
 * Nothing is swallowed: a secret that is genuinely missing still fails loudly, naming itself, at the
 * first read. A secret nobody reads costs nothing, which is what "conditional" meant all along.
 *
 * **A keyspace is the one asymmetry, and it is honest.** A `keyed` entry covers an unbounded set of
 * members whose keys exist only at runtime — one credential per tenant — so nothing is resolved for it
 * up front, and `getKeyed(name, key)` / `getKeyedVersions(name, key)` are async: they fetch exactly the
 * one member asked for, from the encrypted D1 store, in dev and deployed alike (nothing can inject a
 * name that does not exist at build time). Members are never cached — one tenant's credential must not
 * sit in an accessor the next request reuses.
 *
 * **A keyspace is also the one thing this accessor writes.** `putKeyed` / `rotateKeyed` / `deleteKeyed`
 * seal and store one member inline, on the request, because the application that mints a per-tenant
 * credential has to know it is stored before it can hand the other half out (`./keyspaceWrite`). A
 * *named* secret is still written only by the CLI through the manager Workflow, and that stays: an
 * operator-provisioned value has nobody waiting on the response, and the CLI is the only place holding
 * the registry that can validate it before it is written.
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
 * Everything the accessor does to one keyspace member, by its composed `<keyspace>/<key>` name.
 *
 * One seam rather than a read one and a write one, because they are one store and every operation
 * runs the same way: build it now, do exactly one thing, and let it go. A seam at all so the
 * accessor's rules — which name a read composes, what a create refuses, which errors never echo a
 * key — are testable without a D1; {@link d1KeyedIO} is the real one.
 */
export interface KeyedSecretIO {
  /** One member's stored envelope, or `undefined` when nothing is stored under that name. */
  read(storedName: string): Promise<VersionedValue | undefined>;
  /** Seal and store one member; resolves to its current version key once the row is written. */
  write(write: KeyedMemberWrite): Promise<string>;
  /** Remove one member and every version of it. A no-op when it is not stored. */
  remove(storedName: string): Promise<void>;
}

/**
 * The real keyed I/O: the per-environment encrypted D1 store, one member per operation.
 *
 * The store is built per operation rather than once, so it re-resolves the master key — a
 * `SECRETS_ENCRYPTION_KEYS` rotation is picked up instead of being pinned for the life of a cached
 * accessor. A keyspace has no other home: a Secrets Store binding is declared at build time and a
 * member's name is not — which is the argument that has now been made for every `d1` secret (#153).
 */
export function d1KeyedIO(env: SecretsStoreEnv): KeyedSecretIO {
  const deps = async () => ({
    store: await SystemSecretsStore.fromEnv(env),
    tracker: RotationTracker.fromD1(env.SECRETS),
  });
  return {
    read: async (storedName) => (await SystemSecretsStore.fromEnv(env)).getValue(storedName),
    write: async (write) => runKeyedWrite(await deps(), write),
    remove: async (storedName) => runKeyedRemove(await deps(), storedName),
  };
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

/**
 * A caller's value as the string that goes inside the envelope — the inverse of {@link parseValue},
 * and the write side of the same trust boundary.
 *
 * A `json` value is validated against the entry's own schema and re-serialized **from the parsed
 * data**, never from the object handed in: Zod strips what the schema does not declare, so a stray
 * extra property is not sealed in to come back out at a read that trusts the envelope. A `text` value
 * must actually be a string — the types say so, but the one caller this exists for is application code
 * holding a freshly minted credential, and `String(value)` on the wrong thing seals `[object Object]`
 * under a name that will be read as a key.
 *
 * The refusal carries issue paths and codes only, like the read: a Zod issue can echo the value.
 */
function serializeValue(entry: SecretRegistryEntry, name: string, value: unknown): string {
  if (entry.valueType === "text") {
    if (typeof value !== "string") {
      throw new SecretInvalidValueError({
        message: `Secret '${name}' takes a string value.`,
        detail: `text secret '${name}' was handed a ${typeof value}`,
      });
    }
    return value;
  }
  const result = entry.schema.safeParse(value);
  if (!result.success) {
    const summary = result.error.issues.map((i) => `${i.path.join(".") || "<root>"}:${i.code}`).join(", ");
    throw new SecretInvalidValueError({
      message: `Secret '${name}' failed validation.`,
      detail: `json secret '${name}' failed registry validation on write: ${summary}`,
    });
  }
  return JSON.stringify(result.data);
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
 * Who wrote a member, and what records it.
 *
 * **Writing a credential is an administrative act, so it is audited — but the capability cannot audit
 * it alone.** `emit` is the request context's recorder (`c.var.emit`), which lives on the request, not
 * on an accessor cached across them; and the actor is known to the application and to nothing else. An
 * event this capability emitted by itself would say a per-tenant credential was written and be unable
 * to say by whom, which is the one thing worth recording. So the shape and the action codes are the
 * capability's — an adopter does not invent a code for the most sensitive write in the kit — and the
 * emitter and the principal come from the call.
 *
 * Omit it and nothing is recorded. That is a deliberate choice a caller makes, not a default it can
 * fall into unaware: a write that matters is a write with a call site, and the field is one line.
 */
export interface KeyedWriteAudit {
  /** The request context's recorder, `c.var.emit`. Non-fatal by contract, so it cannot break a write. */
  emit: AuditEmit;
  /** What kind of principal is writing — a signed-in operator, a service token, an internal job. */
  actorType: AuditActorType;
  /** That principal's stable id, when there is one. */
  actorId?: string | null;
  /** The session the write belongs to, tying it to the rest of that session's actions. */
  sessionId?: string | null;
  /** The request correlation id, tying the event to one request or trace. */
  requestId?: string | null;
}

/** What a member write settled on. */
export interface KeyedWriteResult {
  /**
   * The member's current version key after the write — `"1"` for a create or a replace, the appended
   * one after a rotation. The pointer `getKeyed` will now resolve, so a caller can record which
   * version of a tenant's credential it just handed out.
   */
  currentVersion: string;
}

/** Options for {@link SecretsAccessor.putKeyed}. */
export interface KeyedPutOptions {
  /**
   * Discard whatever is stored for this key and write the value as a fresh, single-version member.
   *
   * Off by default, and the default is the point. Create-or-replace would make "overwrite this
   * tenant's signing key, losing the one still in use" a typo away, and the loss is silent and total —
   * the old key is gone, so every token already signed with it stops verifying and nothing says why.
   * Adding a key while the old one still works is {@link SecretsAccessor.rotateKeyed}; this is for the
   * case where the stored value must *not* survive, a leaked credential being the whole of it.
   */
  replace?: boolean;
  /** Record the write in the audit trail. */
  audit?: KeyedWriteAudit;
}

/** Options for {@link SecretsAccessor.rotateKeyed} and {@link SecretsAccessor.deleteKeyed}. */
export interface KeyedWriteOptions {
  /** Record the write in the audit trail. */
  audit?: KeyedWriteAudit;
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
  readonly #keyed: KeyedSecretIO | undefined;
  readonly #failures: Record<string, Error>;

  /**
   * `failures` holds the error each unresolved secret raises when *it* is read — see the module note
   * on #170. It is last and optional because almost nothing constructs one: `secretsStore` does, and
   * a test that hands over already-resolved values has no failures to carry.
   */
  constructor(
    registry: R,
    resolved: Record<string, Resolved>,
    keyed?: KeyedSecretIO,
    failures: Record<string, Error> = {},
  ) {
    this.#registry = registry;
    this.#resolved = resolved;
    this.#keyed = keyed;
    this.#failures = failures;
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
   * mid-rotation, when a tenant's retired key must still be honored alongside its new one.
   */
  async getKeyedVersions<K extends KeyedSecretName<R>>(name: K, key: string): Promise<VersionedSecret<R[K]>> {
    const resolved = await this.#loadKeyed(name, key);
    return {
      currentVersion: resolved.currentVersion,
      versions: resolved.versions as Record<string, SecretValue<R[K]>>,
    };
  }

  /**
   * Store one member of a declared keyspace — the credential `key` names — sealed through the same
   * envelope and bound to the same `<keyspace>/<key>` context as every other secret.
   *
   * **Create-only by default.** An existing member is refused with `secrets/already_exists`; pass
   * `{ replace: true }` to discard it. See {@link KeyedPutOptions.replace} for why that is not the
   * default, and {@link rotateKeyed} for adding a key while the old one still verifies.
   *
   * The returned promise resolving is the persistence guarantee — the row is written, sealed under
   * the current master key, before it settles. That is the whole reason this exists rather than a
   * Workflow dispatch: a connect flow can only return a public half once the private half is stored,
   * and "stored, probably, shortly" is a credential the customer discovers is broken later.
   */
  async putKeyed<K extends KeyedSecretName<R>>(
    name: K,
    key: string,
    value: SecretValue<R[K]>,
    options: KeyedPutOptions = {},
  ): Promise<KeyedWriteResult> {
    return await this.#writeKeyed(name, key, value, options.replace ? "replace" : "create", options.audit);
  }

  /**
   * Add a new current value for one member, keeping every prior version valid — a tenant's key
   * rotation, on the request path.
   *
   * This is the write that makes {@link getKeyedVersions} mean something: a verifier mid-rotation has
   * to honor the retired key alongside the new one, and nothing else can produce that state. The
   * keyspace must be declared `rotatable`, which is where that axis stops being forward-looking
   * metadata — a keyspace that says it does not accumulate versions is not quietly made to.
   *
   * **Versions accumulate, and nothing prunes them yet.** Retiring a version after a grace window is
   * the deferred half of value rotation (`crypto/versionedValue`), so every rotation makes the
   * member's envelope larger and every read of it decrypts and parses the lot. That is fine for a
   * credential rotated quarterly and wrong for one rotated hourly. Until pruning lands, a caller with
   * a fast cadence collapses the member with `putKeyed(..., { replace: true })` once the retired key
   * is genuinely dead.
   */
  async rotateKeyed<K extends KeyedSecretName<R>>(
    name: K,
    key: string,
    value: SecretValue<R[K]>,
    options: KeyedWriteOptions = {},
  ): Promise<KeyedWriteResult> {
    return await this.#writeKeyed(name, key, value, "rotate", options.audit);
  }

  /**
   * Remove one member — every version of it, and its rotation history — as one operation.
   *
   * A tenant leaves once. Leaving a version behind because a caller looped and stopped early is the
   * failure this signature exists to make impossible: a member is one row holding one envelope, so
   * there is no partial state to reach.
   *
   * Idempotent, and it never reports whether anything was there. Deleting a member that does not
   * exist is a retry, not an error — and an error that distinguished the two would answer "does this
   * tenant have a credential" to anyone who could call it.
   */
  async deleteKeyed<K extends KeyedSecretName<R>>(
    name: K,
    key: string,
    options: KeyedWriteOptions = {},
  ): Promise<void> {
    // Checked even though nothing here reads the entry: a delete against an undeclared name, or
    // against a named secret, is the same author error it is on a read and answers the same way.
    this.#keyspace(name);
    const io = this.#requireKeyedIO(name);
    const storedName = keyedSecretName(name, key);
    try {
      await io.remove(storedName);
    } catch (error) {
      await this.#auditKeyed(options.audit, SecretsAuditActions.memberRemoved, "failure", name, key, storedName);
      throw error;
    }
    await this.#auditKeyed(options.audit, SecretsAuditActions.memberRemoved, "success", name, key, storedName);
  }

  /**
   * A typed view over a subset of this accessor, restricted to `registry`'s names and sharing the
   * already-resolved values — no re-fetch. Used by the shared per-invocation accessor: the combined
   * registry is resolved once, then each capability gets a precisely-typed accessor over only its own
   * slice. A name in `registry` that this accessor never resolved is simply absent, so a later
   * `get`/`getVersions` fails loudly as `secrets/not_found` rather than returning a silent `undefined`.
   *
   * A held failure travels with its name and no further. That is the whole point of the slice: the
   * view a capability gets carries the errors of its own secrets, and cannot be tripped by a
   * neighbor's unset one.
   *
   * `keyed` defaults to this accessor's own. The shared store passes the current invocation's
   * instead: it hands out views over an accessor cached across requests, and a keyspace read or write
   * is real I/O, which must run through the binding of the request making it — not of whichever
   * request happened to fill the cache.
   */
  subset<R2 extends SecretRegistry>(registry: R2, keyed: KeyedSecretIO | undefined = this.#keyed): SecretsAccessor<R2> {
    const resolved: Record<string, Resolved> = {};
    const failures: Record<string, Error> = {};
    for (const name of Object.keys(registry)) {
      const value = this.#resolved[name];
      if (value) resolved[name] = value;
      const failure = this.#failures[name];
      if (failure) failures[name] = failure;
    }
    return new SecretsAccessor(registry, resolved, keyed, failures);
  }

  /**
   * Resolve one keyspace member. The key is validated and composed by {@link keyedSecretName} — the
   * one place a member name is ever built — so a key can neither escape into a neighboring keyspace
   * nor land on a named entry. A member with no stored value throws instead of resolving `undefined`.
   *
   * Every failure names the keyspace and never the key: `detail` reaches logs verbatim, and the key
   * is caller input identifying one tenant.
   */
  async #loadKeyed(name: string, key: string): Promise<Resolved> {
    const entry = this.#keyspace(name);
    const io = this.#requireKeyedIO(name);
    const stored = await io.read(keyedSecretName(name, key));
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

  /**
   * Seal and store one member. The shared body of `putKeyed` and `rotateKeyed`, because everything
   * except the mode is identical and the ordering is the part that has to be.
   *
   * The order is: prove the keyspace, prove the key, validate the value, *then* touch the store. A
   * traversing key and a value that fails its schema are both refused before anything is written, and
   * neither is audited — nothing was attempted against the store, and a rejected key is unvalidated
   * input that has no business in a trail field that means "tenant".
   *
   * Everything from the store attempt onward is audited with its outcome, refusals included. A connect
   * flow that tried to overwrite a tenant's live signing key and was refused is exactly the line an
   * operator wants to find later.
   *
   * Both callers `return await` this rather than returning it. A guard here refuses before awaiting
   * anything, so the promise is already rejected when it is handed back, and an adopted one does not
   * pick up its handler until the next tick — which workerd reports as an unhandled rejection.
   */
  async #writeKeyed(
    name: string,
    key: string,
    value: unknown,
    mode: KeyedWriteMode,
    audit: KeyedWriteAudit | undefined,
  ): Promise<KeyedWriteResult> {
    const entry = this.#keyspace(name);
    if (mode === "rotate" && !entry.rotatable) {
      throw new InternalError({
        message: `Secret '${name}' does not accumulate versions.`,
        action:
          "Declare the keyspace rotatable, or replace the member with putKeyed(name, key, value, { replace: true }).",
        detail: `rotateKeyed called on keyspace '${name}', which is declared rotatable: false`,
      });
    }
    const io = this.#requireKeyedIO(name);
    const storedName = keyedSecretName(name, key);
    const serialized = serializeValue(entry, name, value);

    const action = mode === "rotate" ? SecretsAuditActions.memberRotated : SecretsAuditActions.memberWritten;
    try {
      const currentVersion = await io.write({
        keyspace: name,
        storedName,
        mode,
        value: serialized,
        valueType: entry.valueType,
        rotatable: entry.rotatable,
      });
      await this.#auditKeyed(audit, action, "success", name, key, storedName, mode);
      return { currentVersion };
    } catch (error) {
      await this.#auditKeyed(audit, action, "failure", name, key, storedName, mode);
      throw error;
    }
  }

  /** The declared keyspace `name` names, or the author error that says why it is not one. */
  #keyspace(name: string): SecretRegistryEntry {
    const entry = this.#registry[name];
    if (!entry) {
      throw new SecretNotFoundError({ detail: `keyspace '${name}' is not declared in this registry` });
    }
    if (!entry.keyed) {
      throw new InternalError({
        message: `Secret '${name}' is not a keyspace.`,
        action: "Read a named secret with get(name), or declare the entry keyed.",
        detail: `a keyspace operation was attempted on named secret '${name}'`,
      });
    }
    return entry;
  }

  /** The keyed I/O this accessor was built with, or the wiring error that says it has none. */
  #requireKeyedIO(name: string): KeyedSecretIO {
    if (!this.#keyed) {
      throw new InternalError({
        message: `Secret '${name}' cannot be reached here.`,
        detail: `keyspace '${name}' used through an accessor built without keyed I/O`,
      });
    }
    return this.#keyed;
  }

  /**
   * Record one member write in the audit trail, when the caller supplied a recorder.
   *
   * The key is the `tenant` dimension — the field that exists so a trail can be read per customer —
   * and it is legitimate there precisely because it has already been validated and composed into a
   * stored name. Nothing about the value is here, and nothing about the value is available to put
   * here: the accessor holds the plaintext for the length of one seal and never in a field this
   * method can reach.
   *
   * `emit` never throws by contract, so a write is never broken by its own audit.
   */
  async #auditKeyed(
    audit: KeyedWriteAudit | undefined,
    action: SecretsAuditAction,
    outcome: AuditOutcome,
    name: string,
    key: string,
    storedName: string,
    mode?: KeyedWriteMode,
  ): Promise<void> {
    if (!audit) return;
    await audit.emit({
      action,
      outcome,
      // A routine per-tenant credential write is routine. A refused one is notable — it means
      // something tried to write over a credential that is presumably in use.
      severity: outcome === "success" ? "info" : "warning",
      actorType: audit.actorType,
      actorId: audit.actorId,
      sessionId: audit.sessionId,
      requestId: audit.requestId,
      resourceType: "secret",
      resourceId: storedName,
      tenant: key,
      metadata: mode ? { keyspace: name, mode } : { keyspace: name },
    });
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
    // The failure this secret's own resolution held. Raised here, at its read, and nowhere else.
    const failure = this.#failures[name];
    if (failure) throw failure;
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
 * from the per-environment store, `cf-secrets-store` entries are read from their bound values. A keyed
 * entry resolves nothing here — it declares a keyspace, not a value — and its members are fetched at
 * the read.
 *
 * **This never rejects because a secret is missing (#170).** A secret that cannot be resolved — no row,
 * no binding, a row that will not decrypt, a value that fails its schema — holds its error, and the read
 * of that secret raises it. A missing secret still fails loudly and still names itself; it just stops
 * taking every other capability's secrets down with it. Reject only on something that is nobody's secret
 * in particular.
 *
 * **The unreadable row is in that list since #384, and was not before.** It threw out of the batch decrypt,
 * so it was held against every `d1` name at once — #170's promise held for a *missing* row and not for an
 * *unreadable* one, which is narrower than the sentence reads and narrower in the direction nobody guesses.
 *
 * Nothing reads `ENVIRONMENT`. A `d1` secret cannot be shadowed by a plaintext binding anywhere, which
 * used to be true only of deployed workers.
 */
export async function secretsStore<R extends SecretRegistry>(
  env: SecretsStoreEnv,
  registry: R,
): Promise<SecretsAccessor<R>> {
  const resolved: Record<string, Resolved> = {};
  const failures: Record<string, Error> = {};
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
    let values: Record<string, StoredSecretValue> = {};
    let storeFailure: Error | undefined;
    try {
      values = await (await SystemSecretsStore.fromEnv(env)).getValues(d1Names);
    } catch (error) {
      // The store itself is unreachable — no `SECRETS` D1, or no master key. That is fatal for every
      // `d1` secret and for none of the others, so it is held against each `d1` name rather than
      // thrown: a `cf-secrets-store` secret in another capability is unaffected and still reads.
      //
      // **This is now the only thing that reaches here, and that is the #384 fix.** A row that would not
      // decrypt used to throw out of `getValues` and land in this `catch`, so one unreadable secret was
      // held against every `d1` name in the registry while the store was fine and every other row opened.
      // Per-row outcomes come back on the value below; what is left here is genuinely nobody's secret in
      // particular.
      storeFailure = held(error);
    }
    for (const name of d1Names) {
      const entry = registry[name];
      if (!entry) continue;
      if (storeFailure) {
        failures[name] = storeFailure;
        continue;
      }
      const value = values[name];
      try {
        // Three facts, three sentences. No row at all is unprovisioned. A row that would not open is
        // `secrets/crypto_failed` against this name and no other — a different remedy, so a different
        // sentence. Anything else resolves.
        if (!value) throw unprovisioned(name, isBound(bindings, name));
        if (value.state === "unreadable") throw unreadableSecret(name);
        resolved[name] = resolveVersioned(entry, name, value.value);
      } catch (error) {
        failures[name] = held(error);
      }
    }
  }

  for (const name of cfNames) {
    const entry = registry[name];
    if (!entry) continue;
    try {
      resolved[name] = resolveInjected(entry, name, await resolveBinding(bindings[name], name));
    } catch (error) {
      failures[name] = held(error);
    }
  }

  return new SecretsAccessor(registry, resolved, d1KeyedIO(env), failures);
}

/**
 * A caught value as the `Error` a later read will re-throw. Anything thrown by a resolver is already a
 * `PithyError`; the wrap is for the impossible case, so a held failure is never a bare string that
 * `throw` would surface without a code. The thrown value is kept as `cause` and never stringified into
 * `detail` — `detail` reaches logs verbatim, and nothing here has proved what that value holds.
 */
function held(error: unknown): Error {
  if (error instanceof Error) return error;
  return new InternalError(
    { message: "Secret resolution failed.", detail: "secret resolution threw a non-error value" },
    { cause: error },
  );
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
