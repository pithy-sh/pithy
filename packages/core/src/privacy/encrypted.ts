// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { CamelCasePlugin } from "kysely";
import { z } from "zod";
import { EncryptedEnvelope } from "../crypto/envelope";
import { isSqliteJson, type SqliteJson, sqliteJson } from "../data/codecs";
import { ValidationError } from "../error/pithyError";
import { PRIVACY_META_KEY, rankPrivacyClasses } from "./classes";
import { classifyPrivacy } from "./classify";

/**
 * **A field says how it rests, beside what it is** (#390).
 *
 * #132 gave a field a privacy class: a claim about what the field **is**, which changes no stored column. This is the
 * other half of the sentence, the claim about how it is **stored**. `phi()` says a diagnosis is health data;
 * `encrypted()` says it rests in D1 as an AES-256-GCM envelope rather than as plaintext. Either may be marked alone,
 * and the two compose: the inventory reports both, so *which of your PHI fields are encrypted at rest?* is a
 * derivation, not a second list.
 *
 * ```ts
 * export const Patient = encryptedTable(
 *   z.object({
 *     id: z.string().describe("The patient's stable id, assigned by the app before the insert."),
 *     diagnosis: encrypted(phi(z.string().describe("The recorded condition."))),
 *     email: encrypted(pii(z.string().describe("Where we write.")), { index: "email" }),
 *     emailIndex: blindIndex("email"),
 *   }),
 *   { name: "patient", key: "id" },
 * );
 * ```
 *
 * ## The codec is synchronous, and the cryptography is one step above it
 *
 * An encrypted field's schema is `sqliteJson(EncryptedEnvelope)`: its stored side is the envelope as a JSON string,
 * its parsed side the envelope object. `Patient.parse(row)` therefore hands back envelopes, and `Patient.encode` takes
 * them, so CLAUDE.md §Data layer's round-trip rule stands unchanged. AES-GCM is asynchronous and needs a key, which a
 * module-level schema must never hold, so it happens in the repository seam `sealed()` builds per request
 * (`./sealed`). **Forgetting the seam cannot write plaintext**: a plain `Patient.encode` handed a string where the
 * codec expects an envelope fails validation.
 *
 * ## It keeps the class it was handed
 *
 * The marker copies every class marked inside the schema it wraps onto itself, in its `meta` and in its output type's
 * brand. So an encrypted `phi` field is still listed as `phi`, still masked by `redact`, and still refused by the log
 * gate — as an envelope after a parse, and as the value itself once `sealed().open` has decrypted it, because the
 * opened value is the wrapped schema's own output, brand and all.
 *
 * ## Presence is outside it
 *
 * `encrypted(x).optional()` and `encrypted(x).nullable()` are the optional field. A null stays SQL `NULL` rather than
 * being sealed, so `IS NULL` still works, and that is a leak the docs name: whether a field holds anything is visible.
 * The schema handed to the marker is the value that is sealed, so a wrapper that admits `null` or `undefined` there is
 * refused, rather than sealing the word `null`.
 */

/** The `meta` key an encrypted field carries: `{ index }`, the normalizer its blind index uses, or `null`. */
export const ENCRYPTED_META_KEY = "encrypted";

/** The `meta` key a blind-index column carries: `{ field }`, the encrypted field it indexes. */
export const BLIND_INDEX_META_KEY = "blindIndex";

/** The `meta` key `encryptedTable()` writes on the table's schema: `{ name, key }`. */
export const ENCRYPTED_TABLE_META_KEY = "encryptedTable";

/**
 * **The normalizers a blind index may use, by name, and only these.** A name rather than a function, because the
 * rotator re-indexes inside the manager Worker, which runs no adopter code: it has to be able to compute the same
 * hash from the name alone. A normalizer the kit adds later is one more name here.
 */
export const BLIND_INDEX_NORMALIZERS = ["exact", "email"] as const;

/** One of the kit's blind-index normalizers. */
export type BlindIndexNormalizer = (typeof BLIND_INDEX_NORMALIZERS)[number];

/** The normalizer names as a schema, for a stamp or a response that carries one. */
export const BlindIndexNormalizerName = z
  .enum(BLIND_INDEX_NORMALIZERS)
  .describe(
    "How a blind index normalizes a value before hashing it: `exact` hashes it as written, `email` applies NFC, trims and lowercases.",
  );

/** Whether a string names one of the kit's normalizers. */
export function isBlindIndexNormalizer(name: unknown): name is BlindIndexNormalizer {
  return typeof name === "string" && (BLIND_INDEX_NORMALIZERS as readonly string[]).includes(name);
}

/**
 * Normalize a value the way its blind index does. `exact` is the value as written; `email` is Unicode NFC, trimmed,
 * lowercased — so `Ada@Example.com ` and `ada@example.com` find one row.
 */
export function normalizeForIndex(normalizer: BlindIndexNormalizer, value: string): string {
  switch (normalizer) {
    case "exact":
      return value;
    case "email":
      return value.normalize("NFC").trim().toLowerCase();
  }
}

/** Options for {@link encrypted}. */
export interface EncryptedOptions<N extends BlindIndexNormalizer | undefined = undefined> {
  /**
   * Give the field a blind index, normalized by this name: `exact` or `email`. The table then declares a sibling
   * `blindIndex("<field>")` column, and `sealed().match` finds a row by it.
   */
  index?: N;
}

/** The type-level carrier of the schema an encrypted field seals. A type only: no value carries it. */
declare const encryptedInner: unique symbol;

/** The type-level carrier of an encrypted field's blind-index normalizer. A type only. */
declare const encryptedIndex: unique symbol;

/** Depth countdown for {@link PrivacyBrandsWithin}. */
type Prev = [never, 0, 1, 2, 3, 4, 5, 6];

/** Values whose structure is not data, so the brand walk does not enter them. */
type NotData = Date | RegExp | ((...args: never[]) => unknown) | PromiseLike<unknown>;

/** The privacy brand keys on `T` itself. Distributes. */
type OwnPrivacyBrands<T> = T extends { readonly [z.core.$brand]: infer M }
  ? Extract<keyof M, `privacy:${string}`>
  : never;

/**
 * Every privacy brand key anywhere in `T`, to six levels of object or array: the classes an encrypted field carries
 * onto its envelope, so the envelope is branded exactly as its contents were.
 */
export type PrivacyBrandsWithin<T, D extends number = 6> = [D] extends [never]
  ? never
  : T extends NotData
    ? never
    :
        | OwnPrivacyBrands<T>
        | (T extends readonly (infer E)[]
            ? PrivacyBrandsWithin<E, Prev[D]>
            : T extends object
              ? { [K in keyof T]-?: PrivacyBrandsWithin<T[K], Prev[D]> }[keyof T]
              : never);

/** The envelope schema an encrypted field parses to, carrying the brands of what it seals. */
export type BrandedEnvelope<I extends z.ZodType> = z.core.$ZodBranded<
  typeof EncryptedEnvelope,
  PrivacyBrandsWithin<z.output<I>>,
  "out"
>;

/**
 * What `encrypted(schema)` returns: the kit's JSON column over the envelope, carrying the schema it seals and the
 * normalizer of its blind index, if any, at the type level.
 */
export type Encrypted<I extends z.ZodType, N extends BlindIndexNormalizer | undefined = undefined> = SqliteJson<
  BrandedEnvelope<I>
> & {
  readonly [encryptedInner]: I;
  readonly [encryptedIndex]: N;
};

/** The schema an encrypted field seals, read off its type. `never` for any other schema. */
export type EncryptedInner<S> = S extends { readonly [encryptedInner]: infer I } ? I : never;

/** The blind-index normalizer an encrypted field declared, read off its type. `never` without one. */
export type EncryptedIndexOf<S> = S extends { readonly [encryptedIndex]: infer N extends BlindIndexNormalizer }
  ? N
  : never;

/** What the runtime knows about one encrypted field: the schema it seals and its index's normalizer. */
export interface EncryptedSpec {
  /** The schema the plaintext is validated against, before a seal and after an open. */
  readonly inner: z.ZodType;
  /** The blind-index normalizer, or `null` for a field with no index. */
  readonly index: BlindIndexNormalizer | null;
}

/**
 * Every encrypted field's spec, by the definition its schema object shares with each clone. `.describe()` and
 * `.meta()` clone a schema onto the same definition, and a privacy marker over the field is a `.meta()`, so a
 * described, marked or re-described encrypted field is found here exactly as the original is.
 */
const specs = new WeakMap<object, EncryptedSpec>();

/** A schema's definition object, the key {@link specs} is held under. */
function defOf(schema: z.ZodType): { type: string; innerType?: z.ZodType } & Record<string, unknown> {
  return schema._zod.def as unknown as { type: string; innerType?: z.ZodType } & Record<string, unknown>;
}

/** The wrappers that are the same field as what they wrap: presence, a default, and `readonly`. */
const PRESENCE: ReadonlySet<string> = new Set(["optional", "nullable", "default", "prefault", "readonly"]);

/** A schema with its presence wrappers peeled off, and whether any of them admits `null` or `undefined`. */
export function unwrapPresence(schema: z.ZodType): { node: z.ZodType; absent: boolean } {
  let node = schema;
  let absent = false;
  for (let def = defOf(node); PRESENCE.has(def.type) && def.innerType; def = defOf(node)) {
    if (def.type === "optional" || def.type === "nullable") absent = true;
    node = def.innerType;
  }
  return { node, absent };
}

/** The spec of an encrypted field, read through its presence wrappers, or `undefined` for any other schema. */
export function encryptedSpecOf(schema: z.ZodType): EncryptedSpec | undefined {
  return specs.get(unwrapPresence(schema).node._zod.def);
}

/**
 * Mark a field encrypted at rest. It rests in its own column as an AES-256-GCM envelope sealed by `sealed()`, and
 * `{ index }` gives it a blind index for equality lookups. See the module note for the whole contract.
 *
 * Refused at module load, where the mistake is cheapest: a schema that admits `null` or `undefined` (put presence
 * outside: `encrypted(x).optional()`), a schema that is already encrypted, and a normalizer that is not the kit's.
 */
export function encrypted<I extends z.ZodType, const N extends BlindIndexNormalizer | undefined = undefined>(
  schema: I,
  options: EncryptedOptions<N> = {},
): Encrypted<I, N> {
  const def = defOf(schema);
  if (def.type === "optional" || def.type === "nullable" || def.type === "default" || def.type === "prefault") {
    throw new ValidationError({
      message: "An encrypted field seals a value, and this schema admits none.",
      action:
        "Put presence outside the marker: encrypted(x).optional() or encrypted(x).nullable(), never encrypted(x.optional()).",
    });
  }
  if (encryptedSpecOf(schema)) {
    throw new ValidationError({
      message: "This field is already encrypted.",
      action: "Mark it encrypted() once.",
    });
  }
  const index = options.index ?? null;
  if (index !== null && !isBlindIndexNormalizer(index)) {
    throw new ValidationError({
      message: `"${String(index)}" is not one of the kit's blind-index normalizers.`,
      action: `Name one of ${BLIND_INDEX_NORMALIZERS.join(", ")}. A normalizer is a name, so the rotator can re-index without running adopter code.`,
    });
  }
  // The classes the sealed value carries, wherever they sit inside it: the envelope stands for all of it.
  const classes = rankPrivacyClasses(classifyPrivacy(schema).map((field) => field.class));
  const {
    [PRIVACY_META_KEY]: _ownClasses,
    [ENCRYPTED_META_KEY]: _ownMarker,
    ...rest
  } = (schema.meta() ?? {}) as Record<string, unknown>;
  const meta: Record<string, unknown> = { ...rest, [ENCRYPTED_META_KEY]: { index } };
  if (classes.length === 1) meta[PRIVACY_META_KEY] = classes[0];
  else if (classes.length > 1) meta[PRIVACY_META_KEY] = classes;
  const field = sqliteJson(EncryptedEnvelope).meta(meta);
  specs.set(field._zod.def, { inner: schema, index });
  return field as unknown as Encrypted<I, N>;
}

/** The value a blind-index column holds: `<version>:<hmac>`, the HMAC-SHA256 as unpadded base64url. */
export const BLIND_INDEX_VALUE = /^\d+:[A-Za-z0-9_-]{43}$/;

/**
 * A blind-index column for the encrypted field `field`: a keyed hash of its normalized value, stored as
 * `<version>:<hmac>`, so `WHERE emailIndex IN (…)` finds a row without decrypting anything. `sealed()` writes it on
 * every seal and `sealed().match` computes what to look for. Add `.nullable()` when the field it indexes is optional:
 * an absent value has no index.
 *
 * **It leaks equality, and that is the trade.** Two rows with the same normalized value have the same index. Ordering,
 * ranges, prefixes and `LIKE` do not come back at all.
 */
export function blindIndex(field: string) {
  return z
    .string()
    .regex(BLIND_INDEX_VALUE, "A blind index is `<version>:<hmac>`.")
    .meta({
      description: `The blind index of \`${field}\`: a keyed hash of its normalized value, for equality lookups.`,
      [BLIND_INDEX_META_KEY]: { field },
    });
}

/** The encrypted field a blind-index column indexes, read through its presence wrappers, or `undefined`. */
export function blindIndexOf(schema: z.ZodType): string | undefined {
  for (let node: z.ZodType | undefined = schema; node; ) {
    const value = (node.meta() as Record<string, unknown> | undefined)?.[BLIND_INDEX_META_KEY];
    if (typeof value === "object" && value !== null && typeof (value as { field?: unknown }).field === "string") {
      return (value as { field: string }).field;
    }
    const def = defOf(node);
    node = PRESENCE.has(def.type) ? def.innerType : undefined;
  }
  return undefined;
}

/** What `encryptedTable()` records: the table's stable name and its primary-key column. */
export interface EncryptedTableDeclaration {
  /** The name the AAD binds: stable, never the SQL table name, so a rename does not orphan a row. */
  readonly name: string;
  /** The primary-key field, app-assigned and never updated. */
  readonly key: string;
}

/** A declared name: a lowercase identifier with dashes or underscores, and never a `:`, which separates the AAD. */
const DECLARED_NAME = /^[a-z][a-z0-9_-]*$/;

/** The shape of an object schema, or `undefined` for any other schema. */
function shapeOf(schema: z.ZodType): Record<string, z.ZodType> | undefined {
  const def = defOf(schema);
  return def.type === "object" ? ((def as unknown as { shape: Record<string, z.ZodType> }).shape ?? {}) : undefined;
}

/**
 * Declare a table's identity on its schema: the stable `name` its AAD binds, and the primary-key field `key` whose
 * value each row binds. `sealed()` and the deploy stamp both read it from here, so what the app seals with and what
 * the rotator re-seals with cannot disagree.
 *
 * **The key is app-assigned, before the insert**, because a seal binds its value. So it is a text id — the house rule
 * for a security-sensitive entity anyway — and an integer key, which SQLite assigns at the insert, is refused.
 */
export function encryptedTable<S extends z.ZodType>(schema: S, declaration: EncryptedTableDeclaration): S {
  const shape = shapeOf(schema);
  if (shape === undefined) {
    throw new ValidationError({
      message: "encryptedTable() declares a table, and this schema is not an object.",
      action: "Pass the table's z.object(...) schema.",
    });
  }
  if (!DECLARED_NAME.test(declaration.name)) {
    throw new ValidationError({
      message: `"${declaration.name}" is not a table name an encrypted field can bind.`,
      action:
        "Name it with a lowercase identifier — letters, digits, dashes and underscores, never a colon. It is bound into every ciphertext, so choose one you will keep.",
    });
  }
  const keyField = shape[declaration.key];
  if (keyField === undefined) {
    throw new ValidationError({
      message: `The ${declaration.name} table declares "${declaration.key}" as its key, and has no such field.`,
      action: "Name the primary-key field of this schema.",
    });
  }
  if (encryptedSpecOf(keyField)) {
    throw new ValidationError({
      message: `The ${declaration.name} table's key, "${declaration.key}", is encrypted.`,
      action: "Leave the primary key in the clear: every sealed field binds its value.",
    });
  }
  const { node, absent } = unwrapPresence(keyField);
  const type = defOf(node).type;
  if (type === "number" || type === "int" || type === "bigint") {
    throw new ValidationError({
      message: `The ${declaration.name} table's key, "${declaration.key}", is an integer, which SQLite assigns at the insert.`,
      action:
        "Use a text id the app assigns before the insert, such as a UUID: every sealed field binds the key's value, so it must exist before the seal.",
    });
  }
  if (type !== "string" || absent) {
    throw new ValidationError({
      message: `The ${declaration.name} table's key, "${declaration.key}", is not a required text id.`,
      action: "Use a required z.string() id the app assigns before the insert, such as a UUID.",
    });
  }
  return schema.meta({
    ...(schema.meta() ?? {}),
    [ENCRYPTED_TABLE_META_KEY]: { name: declaration.name, key: declaration.key },
  }) as S;
}

/** What `encryptedTable()` recorded on a schema, or `null` where nothing was declared. */
export function encryptedTableOf(schema: z.ZodType): EncryptedTableDeclaration | null {
  const value = (schema.meta() as Record<string, unknown> | undefined)?.[ENCRYPTED_TABLE_META_KEY];
  if (typeof value !== "object" || value === null) return null;
  const { name, key } = value as { name?: unknown; key?: unknown };
  return typeof name === "string" && typeof key === "string" ? { name, key } : null;
}

/** `camelCase` → `snake_case`, exactly as `CamelCasePlugin` converts an identifier: it is the plugin's own rule. */
class Conversions extends CamelCasePlugin {
  toSnake(identifier: string): string {
    return this.snakeCase(identifier);
  }
}
const conversions = new Conversions();

/** The SQL name a camelCase identifier is written under, as the kit's `createDatabase` writes it. */
export function sqlIdentifier(identifier: string): string {
  return conversions.toSnake(identifier);
}

/** One encrypted field of a table, located. */
export interface EncryptedFieldLayout {
  /** The field path the AAD binds: `diagnosis`, or `profile.phone` for a field inside a JSON column. */
  readonly path: string;
  /** The path's segments: the column's field name first, then each key inside its JSON. */
  readonly segments: readonly string[];
  /** The field's spec. */
  readonly spec: EncryptedSpec;
  /** The blind-index column's field name, when the field is indexed. */
  readonly indexField: string | null;
}

/** What {@link encryptedLayout} found in one schema. */
export interface EncryptedLayout {
  /** The `encryptedTable()` declaration, or `null`. */
  readonly declaration: EncryptedTableDeclaration | null;
  /** Every encrypted field reached by a path of object keys. */
  readonly fields: readonly EncryptedFieldLayout[];
  /** Every reason the table cannot be sealed or rotated as declared, in one sentence each. Empty when it can. */
  readonly problems: readonly string[];
}

/** A key the AAD can bind and a JSON path can name: an identifier, never a `:` or a `.`. */
const FIELD_KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Whether a definition slot holds a schema. */
function isSchema(value: unknown): value is z.ZodType {
  return typeof value === "object" && value !== null && "_zod" in value;
}

/** Every schema a node holds, without running a getter: where a search for a misplaced field reads through. */
function childrenOf(schema: z.ZodType): z.ZodType[] {
  const def = defOf(schema);
  const found: z.ZodType[] = [];
  const shape = shapeOf(schema);
  if (shape) found.push(...Object.values(shape));
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(def))) {
    if (key === "checks" || key === "getter" || key === "shape" || !("value" in descriptor)) continue;
    const slot: unknown = descriptor.value;
    if (isSchema(slot)) found.push(slot);
    else if (Array.isArray(slot)) for (const each of slot) if (isSchema(each)) found.push(each);
  }
  return found;
}

/** Whether an encrypted field sits anywhere beneath a schema, on any side of any node. */
function holdsEncrypted(schema: z.ZodType, seen = new Set<z.ZodType>()): boolean {
  if (seen.has(schema)) return false;
  seen.add(schema);
  if (encryptedSpecOf(schema)) return true;
  return childrenOf(schema).some((child) => holdsEncrypted(child, seen));
}

/**
 * Locate every encrypted field in a table schema, and say what keeps it from being sealed or rotated.
 *
 * A field is reached by a path of object keys: a column, or a key inside a `sqliteJson` object column, at any depth of
 * objects. That path is what the AAD binds and what the rotator's `json_extract` names. An encrypted field anywhere
 * else — inside an array, a record, a union, a transform — has no such path, so it is a problem rather than a field.
 * So is a blind index on a field inside a JSON column (an index is a sibling column), an index column naming no
 * indexed field, an indexed field with no index column, and a key no JSON path can name.
 */
export function encryptedLayout(schema: z.ZodType): EncryptedLayout {
  const declaration = encryptedTableOf(schema);
  const fields: EncryptedFieldLayout[] = [];
  const problems: string[] = [];
  const top = shapeOf(schema) ?? {};

  const indexColumns = new Map<string, string>();
  for (const [key, field] of Object.entries(top)) {
    const indexes = blindIndexOf(field);
    if (indexes !== undefined) indexColumns.set(indexes, key);
  }

  const visit = (node: z.ZodType, segments: string[]): void => {
    const spec = encryptedSpecOf(node);
    const path = segments.join(".");
    if (spec) {
      const bad = segments.find((segment) => !FIELD_KEY.test(segment));
      if (bad !== undefined) {
        problems.push(`The encrypted field at "${path}" has a key, "${bad}", that no JSON path can name.`);
        return;
      }
      let indexField: string | null = null;
      if (spec.index !== null) {
        if (segments.length > 1) {
          problems.push(
            `The encrypted field "${path}" declares a blind index inside a JSON column. An index is a sibling column, so index a top-level field.`,
          );
        } else {
          indexField = indexColumns.get(path) ?? null;
          if (indexField === null) {
            problems.push(
              `The encrypted field "${path}" declares a blind index and the table has no blindIndex("${path}") column.`,
            );
          }
        }
      }
      fields.push({ path, segments: [...segments], spec, indexField });
      return;
    }
    const { node: inner } = unwrapPresence(node);
    const nested = isSqliteJson(inner) ? (defOf(inner) as unknown as { out: z.ZodType }).out : inner;
    const shape = shapeOf(unwrapPresence(nested).node);
    if (shape) {
      for (const [key, child] of Object.entries(shape)) visit(child, [...segments, key]);
      return;
    }
    if (holdsEncrypted(nested)) {
      problems.push(
        `An encrypted field sits under "${path}" where no path of object keys reaches it, so it can be neither bound nor rotated. Encrypt the whole value, or move the field into an object.`,
      );
    }
  };
  for (const [key, field] of Object.entries(top)) visit(field, [key]);

  const indexed = new Set(fields.filter((field) => field.spec.index !== null).map((field) => field.path));
  for (const [named, column] of indexColumns) {
    if (!indexed.has(named)) {
      problems.push(`The column "${column}" is blindIndex("${named}"), and "${named}" is no indexed encrypted field.`);
    }
  }
  return { declaration, fields, problems };
}

/** Whether a schema holds an encrypted field anywhere: what makes it need `encryptedTable()` and `sealed()`. */
export function hasEncryptedFields(schema: z.ZodType): boolean {
  return holdsEncrypted(schema);
}
