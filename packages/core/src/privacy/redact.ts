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
 * absent value discloses nothing. A key the schema does not name is redacted by the object's catchall when it
 * has one, and otherwise **dropped**, the way `parse` strips it: `Redacted<T>` is computed from the schema, so a
 * wider value handed to a narrower schema — `redact(User.pick({ id: true }), user)` — would otherwise keep a
 * marked key raw behind a type that says it is gone. An intersection's sides each keep the keys the other names,
 * and a union's options the keys any applied option names, so a key is dropped only when nothing names it. **A
 * lazy schema is followed**, so a recursive one is masked at every depth: the walk ends where the value does.
 *
 * **A record's or a map's key is redacted by its key schema**, because a key is stored and logged as surely as a
 * value: a record keyed by a `pii()` email masks each key. Two keys that mask alike are kept apart by a
 * ` #2`, ` #3` suffix, so no entry is lost.
 *
 * **A union** is redacted by every option the value parses as, one after another, so a key any of them marks is
 * masked. Taking only the first would let a looser object option — one that parses by stripping the key a
 * stricter option marks — copy that key through. When no option parses, every option's markers are applied: the
 * conservative reading of a value the schema cannot place.
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
  keyType?: z.ZodType;
  valueType?: z.ZodType;
  catchall?: z.ZodType;
  getter?: () => z.ZodType;
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

/** Keys an enclosing intersection or union names, which an object must not drop: a set, or `"any"` for all. */
type Kept = ReadonlySet<string> | "any";

/** No key kept beyond what the object names itself. */
const NONE: Kept = new Set();

/** Every key either list keeps. */
function both(a: Kept, b: Kept): Kept {
  return a === "any" || b === "any" ? "any" : new Set([...a, ...b]);
}

/** A schema with its wrappers stepped through. */
function unwrapped(schema: z.ZodType): z.ZodType {
  let node = schema;
  for (let def = defOf(node); WRAPPERS.has(def.type) && def.innerType; def = defOf(node)) node = def.innerType;
  return node;
}

/** The side of a pipe that names the value's fields: a codec's app side, or a plain pipe's input before a transform. */
function pipeTarget(node: z.ZodType, def: Def): z.ZodType | undefined {
  if (node instanceof z.ZodCodec) return def.out;
  return def.out && defOf(def.out).type !== "transform" ? def.out : def.in;
}

/**
 * The object keys a schema names, read the way {@link redactValue} reads it: `"any"` when a catchall, a record or
 * a node it cannot see into could hold any key. `seen` ends a lazy that resolves to itself.
 */
function namedKeys(schema: z.ZodType, seen: Set<z.ZodType> = new Set()): Kept {
  const node = unwrapped(schema);
  if (privacyOf(schema) !== null || seen.has(node)) return NONE;
  seen.add(node);
  const def = defOf(node);
  switch (def.type) {
    case "object":
      return def.catchall ? "any" : new Set(Object.keys((node as z.ZodObject).shape));
    case "record":
      return "any";
    case "union":
      return (def.options ?? []).reduce<Kept>((kept, option) => both(kept, namedKeys(option, seen)), NONE);
    case "intersection":
      return both(def.left ? namedKeys(def.left, seen) : NONE, def.right ? namedKeys(def.right, seen) : NONE);
    case "pipe": {
      const target = pipeTarget(node, def);
      return target ? namedKeys(target, seen) : NONE;
    }
    case "lazy":
      return def.getter ? namedKeys(def.getter(), seen) : NONE;
    default:
      return NONE;
  }
}

/** `key`, or `key #2`, `key #3` … — the first that `taken` does not hold yet. */
function distinct(key: string, taken: (candidate: string) => boolean): string {
  if (!taken(key)) return key;
  let index = 2;
  while (taken(`${key} #${index}`)) index += 1;
  return `${key} #${index}`;
}

/**
 * Redact one value against one schema node. `kept` is the keys an enclosing intersection or union names, which an
 * object node copies for the other side to redact rather than dropping.
 */
function redactValue(schema: z.ZodType, value: unknown, kept: Kept = NONE): unknown {
  if (value === null || value === undefined) return value;
  const marked = privacyOf(schema);
  if (marked !== null) return mask(marked, value);

  const node = unwrapped(schema);
  const def = defOf(node);

  switch (def.type) {
    case "object": {
      if (!isPlainObject(value)) return value;
      const shape = (node as z.ZodObject).shape as Record<string, z.ZodType>;
      const out: Record<string, unknown> = {};
      for (const [key, field] of Object.entries(value)) {
        const fieldSchema = Object.hasOwn(shape, key) ? shape[key] : def.catchall;
        if (fieldSchema) out[key] = redactValue(fieldSchema, field);
        // A key nothing names is dropped, the way parse strips it. One an enclosing side names is that side's.
        else if (kept === "any" || kept.has(key)) out[key] = field;
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
      if (!isPlainObject(value)) return value;
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        const redactedKey = def.keyType ? String(redactValue(def.keyType, key)) : key;
        const name = redactedKey === key ? key : distinct(redactedKey, (candidate) => Object.hasOwn(out, candidate));
        out[name] = def.valueType ? redactValue(def.valueType, item) : item;
      }
      return out;
    }
    case "map": {
      if (!(value instanceof Map)) return value;
      const out = new Map<unknown, unknown>();
      for (const [key, item] of value) {
        const redactedKey = def.keyType ? redactValue(def.keyType, key) : key;
        const name =
          redactedKey !== key && typeof redactedKey === "string"
            ? distinct(redactedKey, (candidate) => out.has(candidate))
            : redactedKey;
        out.set(name, def.valueType ? redactValue(def.valueType, item) : item);
      }
      return out;
    }
    case "union": {
      // Every option the value parses as, not the first: a looser object option parses a value by stripping the
      // key a stricter one marks, and redacting by it alone would copy that key through.
      const options = def.options ?? [];
      const matched = options.filter((option) => option.safeParse(value).success);
      const applied = matched.length > 0 ? matched : options;
      // Each applied option keeps the keys the others name, so only a key no applied option names is dropped.
      const named = both(
        kept,
        applied.reduce<Kept>((all, option) => both(all, namedKeys(option)), NONE),
      );
      return applied.reduce<unknown>((current, option) => redactValue(option, current, named), value);
    }
    case "intersection": {
      // Each side keeps the keys the other names: the other side is what redacts them.
      const leftKeys = def.left ? namedKeys(def.left) : NONE;
      const rightKeys = def.right ? namedKeys(def.right) : NONE;
      const left = def.left ? redactValue(def.left, value, both(kept, rightKeys)) : value;
      return def.right ? redactValue(def.right, left, both(kept, leftKeys)) : left;
    }
    case "pipe": {
      // A codec holds its app side. A plain pipe's output is a transform's when `out` is one, so its input
      // shape is the one that names the fields.
      const target = pipeTarget(node, def);
      return target ? redactValue(target, value, kept) : value;
    }
    case "lazy":
      // A lazy schema is how a recursive one is written. Following it here ends, because the value does.
      return def.getter ? redactValue(def.getter(), value, kept) : value;
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
