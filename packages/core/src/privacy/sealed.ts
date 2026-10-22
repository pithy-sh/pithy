// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { z } from "zod";
import { decryptValue, type EncryptedEnvelope, type EncryptionConfig, encryptValue } from "../crypto/envelope";
import { FIELD_KEYS_BINDING, type FieldKeys, liveVersions, resolveFieldKeys } from "../crypto/fieldKeys";
import { isSqliteJson, type SqliteJsonSchema, sqliteJson } from "../data/codecs";
import { fromZodError, ValidationError } from "../error/pithyError";
import { blindIndexValue } from "./blindIndex";
import {
  type EncryptedFieldLayout,
  type EncryptedIndexOf,
  type EncryptedInner,
  encryptedLayout,
  encryptedSpecOf,
  hasEncryptedFields,
} from "./encrypted";

/**
 * **`sealed()`: the round trip for a table with an encrypted field** (#390).
 *
 * The codecs stay synchronous (`./encrypted`), so AES-GCM happens one step above them, in a seam the repository builds
 * per request from `env` — which is how the key reaches the encode without a module-level schema ever holding one.
 *
 * ```ts
 * const patients = sealed(Patient, { keys: env.PITHY_FIELD_KEYS });
 *
 * const record = await patients.seal(value);   // seal each marked field, then Patient.encode
 * await db.insertInto("patient").values(record).execute();
 *
 * const value = await patients.open(row);      // Patient.parse, then open each marked field
 *
 * const hashes = await patients.match("email", input);   // one per live version
 * await db.selectFrom("patient").where("emailIndex", "in", hashes).selectAll().execute();
 * ```
 *
 * ## What each seal binds
 *
 * The AAD is `pithy/enc/1:<name>:<field path>:<pk>` ({@link fieldContext}): the stable name `encryptedTable()`
 * declared, the field's path, and the row's primary key. A ciphertext moved to another field, row or table does not
 * open. The declared name is not the SQL table name, so renaming a table in a migration leaves every row openable. A
 * column's SQL name is always its key in snake case, so renaming an encrypted column changes its field path. The key
 * is app-assigned and never updated, which is the immutability guarantee. Changing the name, a path (a column rename
 * included) or a key is a re-seal migration through `sealed()`: read with the old schema, write with the new.
 *
 * ## What it refuses, at build
 *
 * A schema with an encrypted field and no `encryptedTable()` declaration, and every problem `encryptedLayout` names:
 * an encrypted field no path of object keys reaches, an indexed field with no index column, an index column naming no
 * indexed field. Each is refused when `sealed()` is called, before any key is read, naming the schema.
 *
 * Every write seals under the key set's current version. Every read opens under whichever version sealed the value,
 * for as long as that version is live.
 */

/** The versioned prefix of every field's AAD. Changing what is bound changes this, so the break is deliberate. */
export const FIELD_CONTEXT_PREFIX = "pithy/enc/1";

/** The AAD one field binds: `pithy/enc/1:<name>:<field path>:<pk>`. */
export function fieldContext(name: string, path: string, pk: string): string {
  return `${FIELD_CONTEXT_PREFIX}:${name}:${path}:${pk}`;
}

/** Depth countdown for {@link Opened}. */
type Prev = [never, 0, 1, 2, 3, 4, 5, 6, 7, 8];

/**
 * The value `open` returns and `seal` takes: the schema's output, with every encrypted field the output of the schema
 * it seals — the plaintext, carrying that schema's privacy brand — instead of an envelope. Read through the presence
 * wrappers, objects, and the kit's JSON columns, to eight levels.
 */
export type Opened<S, D extends number = 8> = [D] extends [never]
  ? z.output<S>
  : [EncryptedInner<S>] extends [never]
    ? S extends z.ZodOptional<infer I>
      ? Opened<I, Prev[D]> | undefined
      : S extends z.ZodNullable<infer I>
        ? Opened<I, Prev[D]> | null
        : S extends z.ZodDefault<infer I>
          ? Exclude<Opened<I, Prev[D]>, undefined>
          : S extends z.ZodReadonly<infer I>
            ? Readonly<Opened<I, Prev[D]>>
            : [SqliteJsonSchema<S>] extends [never]
              ? S extends z.ZodObject<infer Shape>
                ? { [K in keyof z.output<S>]: K extends keyof Shape ? Opened<Shape[K], Prev[D]> : z.output<S>[K] }
                : z.output<S>
              : Opened<SqliteJsonSchema<S>, Prev[D]>
    : z.output<EncryptedInner<S>>;

/** A field through its presence wrappers. */
type Unwrapped<S> =
  S extends z.ZodOptional<infer I>
    ? Unwrapped<I>
    : S extends z.ZodNullable<infer I>
      ? Unwrapped<I>
      : S extends z.ZodDefault<infer I>
        ? Unwrapped<I>
        : S;

/** The top-level fields of a table schema that declare a blind index: what `match` takes. */
export type IndexedField<S> =
  S extends z.ZodObject<infer Shape>
    ? { [K in keyof Shape & string]: [EncryptedIndexOf<Unwrapped<Shape[K]>>] extends [never] ? never : K }[keyof Shape &
        string]
    : never;

/** What {@link sealed} takes. */
export interface SealedOptions {
  /** The field key: `env.PITHY_FIELD_KEYS`, or a resolved key set. Read on the first seal, open or match. */
  keys: FieldKeys | undefined;
}

/** The repository seam over one table with encrypted fields. */
export interface Sealed<S extends z.ZodType> {
  /** The table schema. */
  readonly schema: S;
  /** The schema of the opened value: every encrypted field replaced by the schema it seals. `redact` takes it. */
  readonly opened: z.ZodType<Opened<S>>;
  /** Seal every encrypted field under the current version, write each blind index, then `Schema.encode`. */
  seal(value: Opened<S>): Promise<z.input<S>>;
  /** `Schema.parse`, then open every encrypted field and validate it against the schema it seals. */
  open(row: z.input<S>): Promise<Opened<S>>;
  /** The blind index of `value` for `field` under every live version, newest first: what an `IN (…)` looks for. */
  match(field: IndexedField<S>, value: string): Promise<string[]>;
}

/** How a refusal names a schema: its description, or what it holds. */
function schemaLabel(schema: z.ZodType, paths: readonly string[]): string {
  const description = schema.description;
  if (description) return `The schema "${description}"`;
  return paths.length > 0 ? `The schema holding ${paths.join(", ")}` : "This schema";
}

/** The value at a path, or `undefined` where any step is absent. */
function readPath(value: unknown, segments: readonly string[]): unknown {
  let at: unknown = value;
  for (const segment of segments) {
    if (typeof at !== "object" || at === null) return undefined;
    at = (at as Record<string, unknown>)[segment];
  }
  return at;
}

/**
 * A copy of `value` with `next` at `segments`, copying each object on the way so the caller's value is never
 * written to. A step that is absent stays absent: there is nothing there to seal.
 */
function writePath(value: unknown, segments: readonly string[], next: unknown): unknown {
  const [head, ...rest] = segments;
  if (head === undefined) return next;
  if (typeof value !== "object" || value === null) return value;
  const copy = { ...(value as Record<string, unknown>) };
  copy[head] = rest.length === 0 ? next : writePath(copy[head], rest, next);
  return copy;
}

/** The plaintext a value seals to: its schema's encoded form, as JSON. Refused without echoing the value. */
function plaintextOf(field: EncryptedFieldLayout, value: unknown): string {
  const encoded = field.spec.inner.safeEncode(value);
  if (!encoded.success) {
    throw fromZodError(encoded.error, {
      message: `The encrypted field "${field.path}" does not hold a value its schema accepts.`,
    });
  }
  const json = JSON.stringify(encoded.data);
  if (typeof json !== "string") {
    throw new ValidationError({ message: `The encrypted field "${field.path}" holds a value JSON cannot carry.` });
  }
  return json;
}

/** The opened schema: each encrypted field replaced by the schema it seals, along the paths that reach one. */
function openedSchemaOf(schema: z.ZodType): z.ZodType {
  if (encryptedSpecOf(schema)) {
    // Keep the presence the field was given outside the marker.
    const def = schema._zod.def as unknown as { type: string; innerType?: z.ZodType };
    if (def.innerType && (def.type === "optional" || def.type === "nullable" || def.type === "readonly")) {
      return schema.clone({ ...def, innerType: openedSchemaOf(def.innerType) } as never);
    }
    return (encryptedSpecOf(schema) as { inner: z.ZodType }).inner;
  }
  if (!hasEncryptedFields(schema)) return schema;
  const def = schema._zod.def as unknown as { type: string; innerType?: z.ZodType; out?: z.ZodType };
  if (def.innerType && ["optional", "nullable", "default", "prefault", "readonly"].includes(def.type)) {
    return schema.clone({ ...def, innerType: openedSchemaOf(def.innerType) } as never);
  }
  if (isSqliteJson(schema) && def.out) {
    const meta = schema.meta();
    const column = sqliteJson(openedSchemaOf(def.out));
    return meta ? column.meta(meta) : column;
  }
  if (def.type === "object") {
    const object = schema as z.ZodObject;
    const changed: Record<string, z.ZodType> = {};
    for (const [key, field] of Object.entries(object.shape)) {
      if (hasEncryptedFields(field)) changed[key] = openedSchemaOf(field);
    }
    return object.extend(changed);
  }
  return schema;
}

/**
 * Build the seam for one table, from the request's `env`. Refuses, before any key is read, a schema with an encrypted
 * field and no `encryptedTable()` declaration, and every layout problem. See the module note.
 */
export function sealed<S extends z.ZodType>(schema: S, options: SealedOptions): Sealed<S> {
  const layout = encryptedLayout(schema);
  const paths = layout.fields.map((field) => field.path);
  if (layout.declaration === null) {
    if (layout.fields.length > 0 || hasEncryptedFields(schema)) {
      throw new ValidationError({
        message: `${schemaLabel(schema, paths)} holds an encrypted field and declares no table.`,
        action: "Wrap it in encryptedTable(schema, { name, key }): the name and key are what every sealed field binds.",
      });
    }
    throw new ValidationError({
      message: `${schemaLabel(schema, paths)} holds no encrypted field.`,
      action: "Read and write it with Schema.parse and Schema.encode; sealed() is for a table with an encrypted field.",
    });
  }
  if (layout.problems.length > 0) {
    throw new ValidationError({
      message: `${schemaLabel(schema, paths)} cannot be sealed as declared. ${layout.problems.join(" ")}`,
      action: "Fix the schema's encrypted fields and their blindIndex columns.",
    });
  }
  const { name, key } = layout.declaration;
  let resolved: Promise<EncryptionConfig> | undefined;
  const config = (): Promise<EncryptionConfig> => {
    resolved ??= resolveFieldKeys(options.keys);
    return resolved;
  };
  let opened: z.ZodType | undefined;

  const primaryKey = (value: unknown, doing: string): string => {
    const pk = readPath(value, [key]);
    if (typeof pk !== "string" || pk.length === 0) {
      throw new ValidationError({
        message: `The ${name} row has no ${key} to bind, so it cannot be ${doing}.`,
        action: `Assign ${key} in the app before the insert: every encrypted field binds it.`,
      });
    }
    return pk;
  };

  return {
    schema,
    get opened() {
      opened ??= openedSchemaOf(schema);
      return opened as z.ZodType<Opened<S>>;
    },

    async seal(value) {
      const pk = primaryKey(value, "sealed");
      const keys = await config();
      const current = Number(keys.currentVersion);
      let out: unknown = value;
      for (const field of layout.fields) {
        const plain = readPath(value, field.segments);
        if (plain === undefined || plain === null) {
          if (field.indexField) out = writePath(out, [field.indexField], plain === null ? null : undefined);
          continue;
        }
        const envelope = await encryptValue(keys, fieldContext(name, field.path, pk), plaintextOf(field, plain), {
          keys: FIELD_KEYS_BINDING,
        });
        out = writePath(out, field.segments, envelope);
        if (field.indexField && field.spec.index) {
          if (typeof plain !== "string") {
            throw new ValidationError({
              message: `The encrypted field "${field.path}" has a blind index, so it holds a string.`,
            });
          }
          out = writePath(out, [field.indexField], await blindIndexValue(keys, current, field.spec.index, plain));
        }
      }
      const encoded = schema.safeEncode(out as z.output<S>);
      if (!encoded.success) throw fromZodError(encoded.error);
      return encoded.data;
    },

    async open(row) {
      const parsed = schema.safeParse(row);
      if (!parsed.success) throw fromZodError(parsed.error);
      const pk = primaryKey(parsed.data, "opened");
      const keys = await config();
      let out: unknown = parsed.data;
      for (const field of layout.fields) {
        const envelope = readPath(parsed.data, field.segments) as EncryptedEnvelope | null | undefined;
        if (envelope === undefined || envelope === null) continue;
        const plaintext = await decryptValue(keys, fieldContext(name, field.path, pk), envelope, {
          keys: FIELD_KEYS_BINDING,
        });
        let json: unknown;
        try {
          json = JSON.parse(plaintext);
        } catch {
          throw new ValidationError({
            message: `The encrypted field "${field.path}" opened to something that is not JSON.`,
          });
        }
        const value = field.spec.inner.safeParse(json);
        if (!value.success) throw fromZodError(value.error);
        out = writePath(out, field.segments, value.data);
      }
      return out as Opened<S>;
    },

    async match(field, value) {
      const located = layout.fields.find((one) => one.path === field && one.indexField !== null);
      if (!located?.spec.index) {
        throw new ValidationError({
          message: `"${String(field)}" is not a field of the ${name} table with a blind index.`,
          action: `Declare it encrypted(x, { index: "exact" | "email" }) with a blindIndex("${String(field)}") column.`,
        });
      }
      const keys = await config();
      const normalizer = located.spec.index;
      return Promise.all(liveVersions(keys).map((version) => blindIndexValue(keys, version, normalizer, value)));
    },
  };
}
