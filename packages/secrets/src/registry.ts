// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { DevSecretValue } from "@pithy-sh/core/src/capability/devSecret";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { z } from "zod";
import { KEYSPACE_SEPARATOR } from "./keyspace";

/**
 * The secret registry is the dispatcher. Each entry declares where a secret lives
 * (`backend`), whether its value is shared across environments (`scope`), whether a future
 * value-rotator may manage it (`rotatable`), and how it is interpreted (`valueType`). The
 * `secretsStore` read seam and the `pithy secrets` CLI both route off these axes — never off
 * hard-coded names. The entry itself is a TypeScript type (not a Zod object) because a `json`
 * entry carries a Zod schema; the enum axes below are exported Zod enums so they document
 * themselves and can be validated at the boundary.
 *
 * **One uniform serde.** Every secret is stored the same way — a `{ currentVersion, versions }`
 * value envelope inside one AES-256-GCM envelope — and read through one uniform API
 * (`get` / `getVersions`). `rotatable` never changes storage or the fetch shape; it is
 * forward-looking metadata: may a value-rotator (a deferred feature) manage this secret, and so
 * accumulate multiple still-valid versions. Storing consistently today is how adding that rotator
 * becomes append-a-version rather than reshape-everything.
 */

export const SecretBackend = z
  .enum(["d1", "cf-secrets-store"])
  .describe(
    "Where a secret physically lives: `d1` is an encrypted row in the per-environment secrets D1; `cf-secrets-store` is a native Cloudflare Secrets Store entry bound into the worker.",
  );
export type SecretBackend = z.output<typeof SecretBackend>;

export const SecretScope = z
  .enum(["environment", "global"])
  .describe(
    "Whether a secret's value differs per environment (`environment`) or is identical everywhere (`global`). Drives whether a CLI write targets one environment or fans out to all of them.",
  );
export type SecretScope = z.output<typeof SecretScope>;

export const SecretValueType = z
  .enum(["text", "json"])
  .describe(
    "How a decrypted value is interpreted: `text` is a raw string; `json` is parsed and validated against the entry's Zod schema before it is exposed.",
  );
export type SecretValueType = z.output<typeof SecretValueType>;

/** Fields shared by every registry entry, regardless of value type. */
interface SecretRegistryEntryBase {
  /** Storage backend — drives how the value is read and written. */
  backend: SecretBackend;
  /** Whether the value is shared across environments or differs per environment. */
  scope: SecretScope;
  /**
   * Whether a future value-rotator may manage this secret (and so it may carry multiple
   * still-valid versions). Forward-looking metadata only — storage and the read API are the
   * same either way. Value rotation itself is deferred.
   */
  rotatable: boolean;
  /**
   * How often this secret is expected to be rotated, in days. Absent means no expectation, and then
   * nothing may call it overdue.
   *
   * **This is why "overdue" is a fact rather than a client's guess.** An age is a number; whether that
   * age is late is a policy, and the policy belongs beside the secret it is about. Ninety days is
   * unremarkable for a session signing key and a long time for a payment processor's live key. Without
   * this, every management client picks its own threshold, they disagree, and the one an owner happens
   * to be looking at decides whether they are told.
   *
   * **It is independent of {@link rotatable}, deliberately.** `rotatable` says what automation may do;
   * this says what the *organisation* expects, whoever performs it. A `rotatable: false` third-party
   * key — a Stripe key, an OAuth client secret — is exactly the case where no tooling will ever help
   * and a stated expectation is the only thing that surfaces the drift. Refusing this field on a
   * non-rotatable secret would silence the secrets that most need saying.
   *
   * Measured from the newest successful rotation, or from when the secret was first written when there
   * has never been one. See `admin/status.ts`.
   */
  rotateEveryDays?: number;
  /**
   * How this secret's **dev** value may be minted, when it may be minted at all.
   *
   * Set it when the value is *arbitrary* — a session signing key, a link signing key: any random
   * string works, because nothing outside the project has to agree with it. Leave it off when the
   * value must match something that already exists — an OAuth app's client secret, a Stripe key, a
   * storage credential. A generated value there authenticates against nothing, and hides the real gap
   * behind one that looks filled in.
   *
   * The declaration lives here, with the capability that owns the secret, so `pithy add` never carries
   * a list of names that drifts as capabilities are added. It is mirrored into the capability's
   * `pithy.manifest.json` as `devSecrets` — the CLI wires a capability without executing it — and the
   * capability's own tests assert the two agree.
   */
  devValue?: DevSecretValue;
  /**
   * Whether this secret is read **straight from its binding**, by code that runs before the store it
   * would otherwise be decoded through exists.
   *
   * **Read this before deleting it as a special case for one secret.** It has exactly one member today —
   * `SECRETS_ENCRYPTION_KEYS` — and that is not the same thing as being a special case. It describes an
   * asymmetry that **already exists in production and predates this axis**: `ensureMasterKey` has always
   * written the master key into the Secrets Store as a bare `EncryptionConfig`, and
   * `resolveEncryptionConfig` has always parsed its binding directly. Nothing was changed to make that
   * true; this only writes it down where the code that materialises a value can see it.
   *
   * **Why it cannot be otherwise.** Every other secret is stored — in the Secrets Store, in a D1 row, and
   * in a `.dev.vars` line — as an encoded `{ currentVersion, versions }` envelope, and read back through
   * {@link decodeVersionedValue}. The master key is what that decoder's *decryption* needs in order to
   * exist: it is resolved first, before any secret can be read at all, so it cannot arrive in a form
   * whose reading depends on it. Its binding therefore carries the value, and a `bootstrap` secret's
   * materialised value is its **current version's value** rather than the envelope.
   *
   * **What deleting it would cost.** Making the master key uniform means changing what
   * `resolveEncryptionConfig` accepts and rewriting the stored value in every already-provisioned
   * environment — a data migration of the one value that, botched, makes every other secret unreadable
   * with no error naming the cause. Weigh that before treating this field as tidying.
   *
   * The file still states a full envelope for it, like every other secret, and a future *value* rotation
   * of the master key is a rotation of the `EncryptionConfig`'s own `versions` map — the axis that key
   * has always rotated on, and the reason `rotatable` stays false.
   *
   * Enforced at define time: a `bootstrap` entry must be `cf-secrets-store` (a D1 row cannot be read
   * before the store that decrypts it is open) and must not be `keyed` (a keyspace has no one value to
   * bind). See {@link defineSecretRegistry}.
   */
  bootstrap?: boolean;
  /** Optional human note surfaced by the audit (`ls --check`). */
  notes?: string;
}

/** A `text` entry exposes a raw string. */
type TextEntry = { valueType: "text" };
/** A `json` entry is parsed and validated against `schema` before exposure. */
type JsonEntry = { valueType: "json"; schema: z.ZodType };

/** A named entry — one secret, one value, its name declared here. The default, and the common case. */
type NamedEntry = { keyed?: false };
/**
 * A keyed entry declares a **keyspace** instead of a name: the same backend, scope and schema applied
 * to an unbounded set of members whose keys exist only at runtime — one signing key per customer
 * connection, one credential per tenant. Read a member with `getKeyed(name, key)`; `get(name)` is
 * refused, because a keyspace has no single value.
 *
 * `d1` and `environment` are enforced, not conventional. A Cloudflare Secrets Store binding is
 * declared in `wrangler.jsonc` at build time, so a name that does not exist then can never have one;
 * and a member is written to one environment's store by the app itself, so `global` would promise a
 * fan-out that no CLI write performs. See `./keyspace` for how a member is named.
 */
type KeyedEntry = { keyed: true };

/** A single registry entry — the cross-product of the base fields, the value-type discriminant, and named vs keyed. */
export type SecretRegistryEntry = SecretRegistryEntryBase & (TextEntry | JsonEntry) & (NamedEntry | KeyedEntry);

/** A registry: secret name (or keyspace) → entry. The source of truth for backend, scope, rotatability, and value type. */
export type SecretRegistry = Record<string, SecretRegistryEntry>;

/**
 * The in-memory value type for an entry: a `string` for `text`, the inferred schema type for
 * `json`. `get(name)` returns this; `getVersions(name)` returns a map of it per version.
 */
export type SecretValue<E extends SecretRegistryEntry> = E extends { valueType: "json"; schema: infer S }
  ? S extends z.ZodType
    ? z.infer<S>
    : never
  : string;

/**
 * The declared **named** secrets of a registry — constrains callers to entries that exist and that
 * have one value. A keyed entry is excluded on purpose: `get("CONNECTION_SIGNING_KEY")` is a
 * question with no answer, and the type says so before the accessor has to.
 */
export type SecretName<R extends SecretRegistry> = {
  [K in keyof R]: R[K] extends { keyed: true } ? never : K;
}[keyof R] &
  string;

/** The declared **keyspaces** of a registry — the only names `getKeyed` accepts. */
export type KeyedSecretName<R extends SecretRegistry> = {
  [K in keyof R]: R[K] extends { keyed: true } ? K : never;
}[keyof R] &
  string;

/**
 * Author a registry. Validates each entry's enum axes, that `rotatable` is a boolean, and that
 * every `json` entry carries a Zod schema, so a malformed registry fails at define time
 * (attributed to the offending name) rather than deep in a read or a write. A misconfiguration is
 * an author error, so it throws `InternalError` — mirroring `createMigrationRegistry`. The `const`
 * type param preserves the precise entry literals for `SecretValue`/`SecretName`.
 */
export function defineSecretRegistry<const R extends SecretRegistry>(registry: R): R {
  for (const [name, entry] of Object.entries(registry)) {
    if (!name) throw new InternalError({ message: "secret registry: every entry needs a non-empty name." });
    // A name carrying the separator would be indistinguishable from a keyspace member, so one
    // registry entry could shadow another tenant's stored credential. Refused at define time.
    if (name.includes(KEYSPACE_SEPARATOR)) {
      throw new InternalError({
        message: `secret registry: entry "${name}" must not contain '${KEYSPACE_SEPARATOR}' — it separates a keyspace from a member key.`,
      });
    }
    const axes: [string, z.ZodType, unknown][] = [
      ["backend", SecretBackend, entry.backend],
      ["scope", SecretScope, entry.scope],
      ["valueType", SecretValueType, entry.valueType],
    ];
    for (const [field, schema, value] of axes) {
      if (!schema.safeParse(value).success) {
        throw new InternalError({
          message: `secret registry: entry "${name}" has an invalid ${field} (${String(value)}).`,
        });
      }
    }
    if (typeof entry.rotatable !== "boolean") {
      throw new InternalError({ message: `secret registry: entry "${name}" must declare rotatable as a boolean.` });
    }
    if (entry.rotateEveryDays !== undefined) {
      // A cadence that is not a whole number of days, or is zero or negative, would make every read of
      // this secret's status permanently overdue — a warning nobody can clear and everybody learns to
      // ignore. Caught at define time, where the author is.
      if (!Number.isInteger(entry.rotateEveryDays) || entry.rotateEveryDays < 1) {
        throw new InternalError({
          message: `secret registry: entry "${name}" must declare rotateEveryDays as a whole number of days, at least 1.`,
        });
      }
    }
    if (entry.valueType === "json" && !(entry.schema instanceof z.ZodType)) {
      throw new InternalError({ message: `secret registry: json entry "${name}" must declare a Zod schema.` });
    }
    if (entry.devValue !== undefined) {
      if (!DevSecretValue.safeParse(entry.devValue).success) {
        throw new InternalError({
          message: `secret registry: entry "${name}" has an invalid devValue (${String(entry.devValue)}).`,
        });
      }
      // A minted value is a random string, so only a `text` entry can hold one: a `json` entry's shape
      // is the schema's, and nothing can invent a credential that satisfies it.
      if (entry.valueType !== "text") {
        throw new InternalError({
          message: `secret registry: entry "${name}" declares devValue but is not a text entry — a random value cannot satisfy a json schema.`,
        });
      }
      // A keyspace has no single value to mint, and its members do not exist until runtime.
      if (entry.keyed) {
        throw new InternalError({
          message: `secret registry: keyed entry "${name}" must not declare devValue — a keyspace has no one value.`,
        });
      }
    }
    if (entry.bootstrap !== undefined) {
      if (typeof entry.bootstrap !== "boolean") {
        throw new InternalError({
          message: `secret registry: entry "${name}" must declare bootstrap as a boolean.`,
        });
      }
      // A bootstrap secret is one a Worker reads from a binding before the store exists, so the D1 store
      // is not a place it can come from. Caught here, where the author is, rather than at a read that
      // finds a row nothing will ever look at.
      if (entry.bootstrap && entry.backend !== "cf-secrets-store") {
        throw new InternalError({
          message: `secret registry: bootstrap entry "${name}" must use the cf-secrets-store backend — it is read from its binding, before any store is open.`,
        });
      }
      if (entry.bootstrap && entry.keyed) {
        throw new InternalError({
          message: `secret registry: keyed entry "${name}" must not declare bootstrap — a keyspace has no one value to bind.`,
        });
      }
    }
    if (entry.keyed !== undefined && typeof entry.keyed !== "boolean") {
      throw new InternalError({ message: `secret registry: entry "${name}" must declare keyed as a boolean.` });
    }
    if (entry.keyed) {
      // Both axes are load-bearing for a keyspace — see `KeyedEntry`. Caught here, where the author
      // is, rather than at a read that finds nothing and cannot say why.
      if (entry.backend !== "d1") {
        throw new InternalError({
          message: `secret registry: keyed entry "${name}" must use the d1 backend — a Secrets Store binding is declared at build time, and its members are not.`,
        });
      }
      if (entry.scope !== "environment") {
        throw new InternalError({
          message: `secret registry: keyed entry "${name}" must be environment-scoped — its members are written to one environment's store.`,
        });
      }
    }
  }
  return registry;
}
