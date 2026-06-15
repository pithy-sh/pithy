import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { z } from "zod";

/**
 * The secret registry is the dispatcher. Each entry declares where a secret lives
 * (`backend`), whether its value is shared across environments (`scope`), how it is
 * fetched (`kind`), and how it is interpreted (`valueType`). The `secretsStore` read
 * seam and the `pithy secrets` CLI both route off these axes — never off hard-coded
 * names. The entry itself is a TypeScript type (not a Zod object) because a `json`
 * entry carries a Zod schema; the discriminant axes below are exported Zod enums so
 * they document themselves and can be validated at the boundary.
 *
 * **One uniform serde.** Every secret is stored the same way — a version→value map
 * (`{ "1": <value> }`) inside one encrypted envelope — regardless of `kind`. `kind`
 * never changes storage; it governs only the fetch shape and rotation eligibility (see
 * `SecretKind`). Storing consistently today is how a future value rotator becomes
 * append-a-version rather than reshape-everything.
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

export const SecretKind = z
  .enum(["simple", "rotatable"])
  .describe(
    "Fetch shape: `simple` returns the current value bare; `rotatable` returns `{ current, valid }` over the value-version map, so a kid-tagged secret (e.g. a signing key) can verify against every still-valid version.",
  );
export type SecretKind = z.output<typeof SecretKind>;

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
  /** Fetch shape — `simple` (bare value) or `rotatable` (`{ current, valid }`). */
  kind: SecretKind;
  /** Optional human note surfaced by the audit (`ls --check`). */
  notes?: string;
}

/** A `text` entry exposes a raw string. */
type TextEntry = { valueType: "text" };
/** A `json` entry is parsed and validated against `schema` before exposure. */
type JsonEntry = { valueType: "json"; schema: z.ZodType };

/** A single registry entry — the cross-product of the base fields and the value-type discriminant. */
export type SecretRegistryEntry = SecretRegistryEntryBase & (TextEntry | JsonEntry);

/** A registry: secret name → entry. The source of truth for backend, scope, kind, and value type. */
export type SecretRegistry = Record<string, SecretRegistryEntry>;

/**
 * The in-memory value type for an entry: a `string` for `text`, the inferred schema
 * type for `json`. Lets `secretsStore.get` return a precisely-typed value per name.
 */
export type SecretValue<E extends SecretRegistryEntry> = E extends { valueType: "json"; schema: infer S }
  ? S extends z.ZodType
    ? z.infer<S>
    : never
  : string;

/** The declared names of a registry — constrains callers to entries that exist. */
export type SecretName<R extends SecretRegistry> = keyof R & string;

/**
 * Author a registry. Validates each entry's discriminant axes and that every `json`
 * entry carries a Zod schema, so a malformed registry fails at define time (attributed
 * to the offending name) rather than deep in a read or a write. A misconfiguration is an
 * author error, so it throws `InternalError` — mirroring `createMigrationRegistry`. The
 * `const` type param preserves the precise entry literals for `SecretValue`/`SecretName`.
 */
export function defineSecretRegistry<const R extends SecretRegistry>(registry: R): R {
  for (const [name, entry] of Object.entries(registry)) {
    if (!name) throw new InternalError({ message: "secret registry: every entry needs a non-empty name." });
    const axes: [string, z.ZodType, unknown][] = [
      ["backend", SecretBackend, entry.backend],
      ["scope", SecretScope, entry.scope],
      ["kind", SecretKind, entry.kind],
      ["valueType", SecretValueType, entry.valueType],
    ];
    for (const [field, schema, value] of axes) {
      if (!schema.safeParse(value).success) {
        throw new InternalError({
          message: `secret registry: entry "${name}" has an invalid ${field} (${String(value)}).`,
        });
      }
    }
    if (entry.valueType === "json" && !(entry.schema instanceof z.ZodType)) {
      throw new InternalError({ message: `secret registry: json entry "${name}" must declare a Zod schema.` });
    }
  }
  return registry;
}
