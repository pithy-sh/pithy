// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { privacyClass } from "./classes";
import { privacyOf } from "./classify";
import type { Redacted } from "./types";

/**
 * **The masked view: safe for a log, an audit record and an error detail** (#132).
 *
 * `redact(User, user)` walks the schema and the value together and returns a copy in which every unmarked field
 * is verbatim and every marked one is its class's mask — `[pii]`, `[phi]`, `[secret]`, a PAN's first six and
 * last four, or whatever an adopter's class says. The result carries no brand, so it compiles into every
 * surface the type gate guards.
 *
 * ## The placeholder, and why it is not a hash
 *
 * `[pii]` loses correlation: two log lines about one person look unrelated. A keyed per-class hash would keep it,
 * and an email is low-entropy enough to brute-force from an unkeyed one — so the hash would need a secret salt,
 * which would pull `@pithy-sh/secrets` into core. The placeholder is the v1 answer, and correlation is what the
 * unmarked id beside it is for.
 *
 * ## What it reads
 *
 * **The app shape** — what `Schema.parse(row)` returns — not the SQLite row. A codec field marked as a whole is
 * masked whole; a JSON column is walked on its parsed side. `null` and `undefined` stay as they are, because an
 * absent value discloses nothing. A key the schema does not name is kept as it was: the schema is the only
 * thing that can say a field is private, and a parsed object holds no such key anyway.
 *
 * **A union** is redacted by the first option the value parses as. When none does, every option's markers are
 * applied, so a key any option marks is masked — the conservative reading of a value the schema cannot place.
 *
 * It never mutates its argument, and it never throws on a value that does not match the schema: it masks what it
 * can name and copies the rest.
 */

/** A Zod schema's internal definition, as much of it as this walk reads. */
interface Def {
  type: string;
  innerType?: z.ZodType;
  element?: z.ZodType;
  options?: z.ZodType[];
  left?: z.ZodType;
  right?: z.ZodType;
  items?: z.ZodType[];
  rest?: z.ZodType | null;
  valueType?: z.ZodType;
  in?: z.ZodType;
  out?: z.ZodType;
}

/** The definition behind a schema. */
function defOf(schema: z.ZodType): Def {
  return (schema as unknown as { def: Def }).def;
}

/** Wrappers that are the same field as what they wrap. */
const WRAPPERS: ReadonlySet<string> = new Set([
  "optional",
  "nullable",
  "default",
  "prefault",
  "readonly",
  "catch",
  "nonoptional",
]);

/** A plain object — not an array, not a `Date`, not a class instance. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** The mask for a class, or the `[name]` placeholder for a class nothing registered. */
function mask(className: string, value: unknown): string {
  return privacyClass(className)?.mask(value) ?? `[${className}]`;
}

/** Redact one value against one schema node. */
function redactValue(schema: z.ZodType, value: unknown): unknown {
  if (value === null || value === undefined) return value;
  const marked = privacyOf(schema);
  if (marked !== null) return mask(marked, value);

  let node: z.ZodType = schema;
  for (let def = defOf(node); WRAPPERS.has(def.type) && def.innerType; def = defOf(node)) node = def.innerType;
  const def = defOf(node);

  switch (def.type) {
    case "object": {
      if (!isPlainObject(value)) return value;
      const shape = (node as z.ZodObject).shape as Record<string, z.ZodType>;
      const out: Record<string, unknown> = {};
      for (const [key, field] of Object.entries(value)) {
        const fieldSchema = shape[key];
        out[key] = fieldSchema ? redactValue(fieldSchema, field) : field;
      }
      return out;
    }
    case "array":
      return Array.isArray(value) && def.element
        ? value.map((item) => redactValue(def.element as z.ZodType, item))
        : value;
    case "set":
      return value instanceof Set && def.valueType
        ? new Set([...value].map((item) => redactValue(def.valueType as z.ZodType, item)))
        : value;
    case "tuple": {
      if (!Array.isArray(value)) return value;
      const items = def.items ?? [];
      return value.map((item, index) => {
        const itemSchema = items[index] ?? def.rest ?? undefined;
        return itemSchema ? redactValue(itemSchema, item) : item;
      });
    }
    case "record": {
      if (!isPlainObject(value) || !def.valueType) return value;
      const valueType = def.valueType;
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(valueType, item)]));
    }
    case "map":
      return value instanceof Map && def.valueType
        ? new Map([...value].map(([key, item]) => [key, redactValue(def.valueType as z.ZodType, item)]))
        : value;
    case "union": {
      const options = def.options ?? [];
      const matched = options.find((option) => option.safeParse(value).success);
      if (matched) return redactValue(matched, value);
      return options.reduce<unknown>((current, option) => redactValue(option, current), value);
    }
    case "intersection": {
      const left = def.left ? redactValue(def.left, value) : value;
      return def.right ? redactValue(def.right, left) : left;
    }
    case "pipe": {
      // A codec holds its app side. A plain pipe's output is a transform's when `out` is one, so its input
      // shape is the one that names the fields.
      if (node instanceof z.ZodCodec) return def.out ? redactValue(def.out, value) : value;
      const target = def.out && defOf(def.out).type !== "transform" ? def.out : def.in;
      return target ? redactValue(target, value) : value;
    }
    default:
      return value;
  }
}

/**
 * The masked view of a value, against the schema it is an instance of. See the module note for exactly what it
 * reads, and why the mask is a placeholder.
 */
export function redact<S extends z.ZodType>(schema: S, value: z.output<S>): Redacted<z.output<S>> {
  return redactValue(schema, value) as Redacted<z.output<S>>;
}
