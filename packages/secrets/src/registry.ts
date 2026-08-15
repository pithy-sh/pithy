// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { DevSecretValue } from "@pithy-sh/core/src/capability/devSecret";
import { SecretOrigin, SecretRotation } from "@pithy-sh/core/src/capability/secretOrigin";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { z } from "zod";
import { KEYSPACE_SEPARATOR } from "./keyspace";
import type { ValueRotator } from "./rotation/valueRotator";

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
   * How this secret's value may be minted, when it may be minted at all.
   *
   * Set it when the value is *arbitrary* — a session signing key, a link signing key: any random
   * string works, because nothing outside the project has to agree with it. Leave it off when the
   * value must match something that already exists — an OAuth app's client secret, a Stripe key, a
   * storage credential. A generated value there authenticates against nothing, and hides the real gap
   * behind one that looks filled in.
   *
   * **The name says dev; the property does not (#321).** *Nothing outside the project has to agree with
   * this* is a fact about the value, and it is as true of production as of a laptop: a session signing
   * key is arbitrary in prod for exactly the reason it is arbitrary in dev, because no third party
   * validates it. For four releases only local dev read this field, so provisioning a deployed
   * environment stopped to ask a human to run `pithy secrets create` on values with no human decision in
   * them. Every environment reads it now. Ask {@link isMintableSecret} rather than the field, so the day
   * the name is corrected there is one site to correct.
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
   * **The dev secrets file states the value, not an envelope around it (#323).** It used to state one,
   * and the seeder took it off again on the way to the binding — so `currentVersion` appeared twice for
   * one concept, carrying no information, and two readers in a row reported a correct file as corrupt.
   * The file states the payload its destination receives, for this secret as for every other; a future
   * *value* rotation of the master key is a rotation of the `EncryptionConfig`'s own `versions` map —
   * the axis that key has always rotated on, and the reason `rotatable` stays false.
   *
   * Enforced at define time: a `bootstrap` entry must be `cf-secrets-store` (a D1 row cannot be read
   * before the store that decrypts it is open) and must not be `keyed` (a keyspace has no one value to
   * bind). See {@link defineSecretRegistry}.
   */
  bootstrap?: boolean;
  /**
   * How this value comes to exist — minted by the kit, composable into a command, or a human in
   * somebody else's console. See {@link SecretOrigin}.
   *
   * **Declared with {@link rotation} or not at all**, enforced at define time. An origin alone renders as
   * a whole answer — *obtained from GitHub*, and nothing about what to do when it is ninety days old — and
   * the operator most in need of the second half is the one who reads only the first.
   *
   * **It does not replace {@link devValue} yet, and it may not contradict it.** `origin.kind: "minted"`
   * with `recipe.kind: "random"` is exactly the `devValue` case, and `defineSecretRegistry` refuses either
   * without the other, so the two cannot drift while both exist. When `devValue` goes, {@link
   * isMintableSecret} becomes a read of this field and no caller changes.
   */
  origin?: SecretOrigin;
  /**
   * How this value is replaced. See {@link SecretRotation}.
   *
   * **A separate axis from {@link origin}, because neither follows from the other.** A GitLab token is
   * `obtained` — a human made the first one — and rotates by `provider`, since the API authenticates with
   * the token being replaced and returns its successor. An OAuth client secret is also `obtained` and
   * rotates only by `manual`. One field cannot say both.
   *
   * **It does not derive {@link rotatable}, and must not.** They answer different questions, and two
   * secrets in this repository prove it: `SECRETS_ENCRYPTION_KEYS` is `rotation: "local"` and
   * `rotatable: false`, because it rotates on the `versions` map inside its own `EncryptionConfig` rather
   * than on a second value envelope; `payments-provider-credentials` is `rotatable: true` and rotates only
   * by a human in Stripe's console. `rotatable` is about how a value is *stored* while it changes; this is
   * about who changes it.
   */
  rotation?: SecretRotation;
  /**
   * **The code behind a `provider` rotation.** See {@link ValueRotator}.
   *
   * `rotation` is a tag and crosses into `pithy.manifest.json`; this is a function and cannot. That is the
   * whole reason they are two fields rather than one — #322's constraint, stated where an author meets it.
   * Neither is derivable from the other, so both are declared, and `defineSecretRegistry` refuses a pair
   * that disagrees:
   *
   * - **`provider` may carry one, and only `provider` may.** `local` is rotated by the same
   *   `mintSecretValue` that created the value, and a second producer beside `origin.recipe` is exactly
   *   the drift the origin/rotation checks exist to refuse. `manual` means no API returns the new value,
   *   so a rotator there is a contradiction the declaration already spelled out.
   * - **`provider` is not *required* to carry one**, because an adopter may hold the credentials a
   *   capability's secret rotates against while the capability does not. Turnstile is the case in the kit
   *   today: `rotation.kind: "provider"`, issuer `cloudflare`, and no rotator, because rolling that widget
   *   needs an account token this package must never hold. `pithy secrets rotate` answers that state by
   *   naming it and the two ways out, which beats a define-time refusal that would make declaring the
   *   truth impossible.
   *
   * **Never serialised.** `DeclaredSecret` — the manifest's projection — carries `name`, `origin` and
   * `rotation`, and parses rather than copies, so a function has no route into a JSON document. Held to
   * that by `registry.test.ts` rather than by this sentence.
   */
  rotator?: ValueRotator;
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
 * **May this secret's value be minted?** The one question every creator asks, in every environment.
 *
 * Two kinds of secret, and the difference is the whole of it. A *supplied* secret was issued elsewhere —
 * an OAuth client secret, a payment rail's key — and only the person holding it can provide one; a
 * creator must stop and say so. A *generated* secret is random bytes nobody chooses, and stopping to ask
 * a human to ask a tool to generate them is a round trip and nothing else.
 *
 * The answer is {@link SecretRegistryEntryBase.devValue}, read through here rather than directly: the
 * field is named for the environment that happened to read it first, the property is not, and one
 * predicate is what keeps the two from being confused again. A keyspace is refused a second time — the
 * define-time check already refuses the pair, and this stays true of a registry assembled by hand.
 */
export function isMintableSecret(entry: SecretRegistryEntry): boolean {
  return entry.devValue !== undefined && !entry.keyed;
}

/**
 * Check one entry's `origin` and `rotation` — that each is well-formed, that they agree with each other,
 * and that neither contradicts what the entry already says about itself.
 *
 * **Every rule here exists because the alternative is a client rendering a confident wrong thing.** A
 * declaration is read by `pithy doctor`, by `pithy secrets ls`, and by a management dashboard, none of
 * which can tell a mistake from a fact. So the mistakes are refused where the author is.
 */
function validateSecretDeclaration(name: string, entry: SecretRegistryEntry): void {
  // The tag and the code must agree, and neither is derivable from the other (#322), so both are checked
  // against each other here — where the author is — rather than at a rotation that finds a rotator on a
  // secret nothing was ever going to call one for. See `SecretRegistryEntryBase.rotator`.
  if (entry.rotator !== undefined) {
    if (typeof entry.rotator.roll !== "function") {
      throw new InternalError({ message: `secret registry: entry "${name}" has a rotator with no roll().` });
    }
    if (entry.rotation?.kind !== "provider") {
      throw new InternalError({
        message: `secret registry: entry "${name}" carries a rotator, so its rotation must be provider — ${
          entry.rotation === undefined
            ? "it declares none"
            : entry.rotation.kind === "local"
              ? "a local secret is re-minted from its own recipe, and a second producer is drift"
              : "a manual secret is replaced by a human, and no call returns the new value"
        }.`,
      });
    }
  }
  // Declared together or not at all. See `SecretRegistryEntryBase.origin`.
  if ((entry.origin === undefined) !== (entry.rotation === undefined)) {
    throw new InternalError({
      message: `secret registry: entry "${name}" declares one of origin and rotation — declare both or neither.`,
    });
  }
  if (entry.origin === undefined || entry.rotation === undefined) return;
  const origin = SecretOrigin.safeParse(entry.origin);
  if (!origin.success) {
    throw new InternalError({ message: `secret registry: entry "${name}" has an invalid origin.` });
  }
  const rotation = SecretRotation.safeParse(entry.rotation);
  if (!rotation.success) {
    throw new InternalError({ message: `secret registry: entry "${name}" has an invalid rotation.` });
  }
  // What the kit can make, the kit can make again — and nothing else can be replaced without its issuer.
  // So `minted` and `local` imply each other, and a pair that disagrees is one of the two being wrong.
  const minted = origin.data.kind === "minted";
  if (minted !== (rotation.data.kind === "local")) {
    throw new InternalError({
      message: minted
        ? `secret registry: entry "${name}" is minted, so its rotation is local — the kit can make another.`
        : `secret registry: entry "${name}" is not minted, so its rotation cannot be local — only its issuer can replace it.`,
    });
  }
  // One axis, not two fields that can disagree. `devValue` is the random-mint case and nothing else: the
  // master key is minted too, and no random string is an `EncryptionConfig`.
  const randomlyMinted = minted && origin.data.kind === "minted" && origin.data.recipe.kind === "random";
  if (randomlyMinted !== (entry.devValue !== undefined)) {
    throw new InternalError({
      message: randomlyMinted
        ? `secret registry: entry "${name}" is minted from a random value, so it must declare devValue.`
        : `secret registry: entry "${name}" declares devValue but its origin is not a random mint.`,
    });
  }
  // A structured mint produces a structure. The `random`/`text` half of this is enforced with `devValue`
  // above; this is its mirror, and without it a json entry could claim a mint that cannot satisfy its schema.
  if (origin.data.kind === "minted" && origin.data.recipe.kind !== "random" && entry.valueType !== "json") {
    throw new InternalError({
      message: `secret registry: entry "${name}" mints a structured value, so it must be a json entry.`,
    });
  }
}

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
    validateSecretDeclaration(name, entry);
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
      // A bootstrap secret is what the decoder needs in order to exist, so nothing may invent one: the
      // master key is composed by `initialMasterKeyConfig`, and a random string in its place orphans
      // every secret already encrypted under the real one. Refused here so that every writer of a fresh
      // dev secret — `pithy add`, `adopt`, the provisioners — can state a mintable secret is not
      // bootstrap as a fact rather than as an assumption. See `initialDevSecret`.
      if (entry.bootstrap && entry.devValue !== undefined) {
        throw new InternalError({
          message: `secret registry: bootstrap entry "${name}" must not declare devValue — nothing may mint the value every other secret is read through.`,
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
