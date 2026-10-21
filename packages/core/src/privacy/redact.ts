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
 * absent value discloses nothing.
 *
 * ## Three steps, so it keeps exactly what parse keeps
 *
 * **First, the value as `parse` would keep it**, by the same walk: a strip-mode object drops a key it does not
 * name, a catchall or a loose object keeps one, a pick or an omit is the object it returns, an intersection merges
 * what each side keeps at every depth, and a union keeps what the first option the value parses as keeps.
 * `Redacted<T>` is computed from the schema, so a wider value handed to a narrower schema —
 * `redact(User.pick({ id: true }), user)` — loses the keys the type says are gone. **Then every position the schema
 * marks is found, against that unmasked value**: an intersection by both its sides, and a union by every option
 * the value parses as. Taking only the first would let a looser option — a loose object that keeps the key a
 * stricter option marks — copy that key through. When no option parses, every option marks its own: the
 * conservative reading of a value the schema cannot place. **Last, every marked position is masked, once**, and
 * that step never drops or adds a key, so no shape can lose a field `parse` keeps. Every choice is made before
 * anything is masked: a union tested against `[pii]` where an email, a number or a refinement was would fail its
 * strict option, apply a looser one, and leave raw a field only the strict one marks. **A lazy schema is
 * followed**, so a recursive one is masked at every depth: the walk ends where the value does.
 *
 * **A record's or a map's key is redacted by its key schema**, because a key is stored and logged as surely as a
 * value: a record keyed by a `pii()` email masks each key. Two keys that mask alike are kept apart by a
 * ` #2`, ` #3` suffix, so no entry is lost.
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

/** Whether `value` parses as `schema`. Zod throws, rather than reports, an intersection it cannot merge: a no. */
function parses(schema: z.ZodType, value: unknown): boolean {
  try {
    return schema.safeParse(value).success;
  } catch {
    return false;
  }
}

/** The options of a union the walk applies to `value`: every one it parses as, or all of them when none does. */
function appliedOptions(options: readonly z.ZodType[], value: unknown): readonly z.ZodType[] {
  const matched = options.filter((option) => parses(option, value));
  return matched.length > 0 ? matched : options;
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

/** Whether a schema is `z.never()`, the catchall a strict object refuses an extra key with. */
function isNever(schema: z.ZodType): boolean {
  return defOf(unwrapped(schema)).type === "never";
}

/**
 * Two results of one value merged the way `parse` merges an intersection's sides: an object holds every key either
 * holds, an array of one length merges by position, and anything else is the left side's.
 */
function merged(left: unknown, right: unknown): unknown {
  if (isPlainObject(left) && isPlainObject(right)) {
    const out: Record<string, unknown> = { ...left };
    for (const [key, item] of Object.entries(right)) out[key] = Object.hasOwn(out, key) ? merged(out[key], item) : item;
    return out;
  }
  if (Array.isArray(left) && Array.isArray(right) && left.length === right.length)
    return left.map((item, index) => merged(item, right[index]));
  return left;
}

/**
 * **Step one: the value as `parse` would keep it.** The same walk `parse` does — a strip-mode object drops a key it
 * does not name, a catchall keeps one, an intersection merges what each side keeps, a union keeps what the first
 * option the value parses as keeps — on the app shape, so a codec is not decoded twice. Nothing is masked here, and
 * every container is a copy.
 */
function kept(schema: z.ZodType, value: unknown): unknown {
  if (value === null || value === undefined) return value;
  const node = unwrapped(schema);
  const def = defOf(node);
  switch (def.type) {
    case "object": {
      if (!isPlainObject(value)) return value;
      const shape = (node as z.ZodObject).shape as Record<string, z.ZodType>;
      const catchall = def.catchall && !isNever(def.catchall) ? def.catchall : undefined;
      const out: Record<string, unknown> = {};
      for (const [key, field] of Object.entries(value)) {
        const fieldSchema = Object.hasOwn(shape, key) ? shape[key] : catchall;
        // A key nothing names is dropped, the way parse strips it, and the way a strict object refuses it.
        if (fieldSchema) out[key] = kept(fieldSchema, field);
      }
      return out;
    }
    case "array":
      return Array.isArray(value) && def.element ? value.map((item) => kept(def.element as z.ZodType, item)) : value;
    case "set":
      return value instanceof Set && def.valueType
        ? new Set([...value].map((item) => kept(def.valueType as z.ZodType, item)))
        : value;
    case "tuple": {
      if (!Array.isArray(value)) return value;
      const items = def.items ?? [];
      const rest = def.rest ?? undefined;
      // A position past the tuple's items with no rest is one parse refuses, so it is not kept.
      const length = rest ? value.length : Math.min(value.length, items.length);
      return value.slice(0, length).map((item, index) => kept((items[index] ?? rest) as z.ZodType, item));
    }
    case "record": {
      if (!isPlainObject(value)) return value;
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) out[key] = def.valueType ? kept(def.valueType, item) : item;
      return out;
    }
    case "map": {
      if (!(value instanceof Map)) return value;
      const out = new Map<unknown, unknown>();
      for (const [key, item] of value) out.set(key, def.valueType ? kept(def.valueType, item) : item);
      return out;
    }
    case "union": {
      const options = def.options ?? [];
      const first = options.find((option) => parses(option, value));
      // What parse returns is the first option the value parses as. When none does, every option keeps its own.
      if (first) return kept(first, value);
      return options.map((option) => kept(option, value)).reduce((left, right) => merged(left, right), value);
    }
    case "intersection": {
      const left = def.left ? kept(def.left, value) : value;
      return def.right ? merged(left, kept(def.right, value)) : left;
    }
    case "pipe": {
      const target = pipeTarget(node, def);
      return target ? kept(target, value) : value;
    }
    case "lazy":
      // A lazy schema is how a recursive one is written. Following it here ends, because the value does.
      return def.getter ? kept(def.getter(), value) : value;
    default:
      return value;
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
 * Where the schema marks one value: the class it masks with, and what the schema marks inside it — by property
 * name in an object or a record, and by position in an array, a tuple, a set or a map. A key's own plan masks a
 * record's or a map's key.
 */
interface Plan {
  mask?: string;
  readonly inner: Map<string | number, Plan>;
  readonly keys: Map<string | number, Plan>;
}

const newPlan = (): Plan => ({ inner: new Map(), keys: new Map() });

/** The plan at `at` in `table`, made when it is not there yet. */
function planAt(table: Map<string | number, Plan>, at: string | number): Plan {
  let plan = table.get(at);
  if (!plan) {
    plan = newPlan();
    table.set(at, plan);
  }
  return plan;
}

/**
 * **Step two: where the schema marks the value.** It walks what {@link kept} returned — the value unmasked — and
 * records each marked position in `plan`, masking nothing yet. Every choice it makes is made against that value: a
 * union by every option it parses as, an intersection by both sides. Choosing against a value one side had already
 * masked would test `[pii]` against a refinement, an email or a number, fail the strict option, and apply a looser
 * one that marks less.
 */
function marks(schema: z.ZodType, value: unknown, plan: Plan): void {
  if (value === null || value === undefined) return;
  const marked = privacyOf(schema);
  if (marked !== null) {
    // The first class to mark a position masks it; what is inside a masked value is gone with it.
    plan.mask ??= marked;
    return;
  }

  const node = unwrapped(schema);
  const def = defOf(node);

  switch (def.type) {
    case "object": {
      if (!isPlainObject(value)) return;
      const shape = (node as z.ZodObject).shape as Record<string, z.ZodType>;
      for (const [key, field] of Object.entries(value)) {
        const fieldSchema = Object.hasOwn(shape, key) ? shape[key] : def.catchall;
        // A key this object does not name is another side's, kept by step one for that side to mark.
        if (fieldSchema) marks(fieldSchema, field, planAt(plan.inner, key));
      }
      return;
    }
    case "array":
      if (Array.isArray(value) && def.element)
        for (const [index, item] of value.entries()) marks(def.element, item, planAt(plan.inner, index));
      return;
    case "set":
      if (value instanceof Set && def.valueType)
        for (const [index, item] of [...value].entries()) marks(def.valueType, item, planAt(plan.inner, index));
      return;
    case "tuple": {
      if (!Array.isArray(value)) return;
      const items = def.items ?? [];
      value.forEach((item, index) => {
        const itemSchema = items[index] ?? def.rest ?? undefined;
        if (itemSchema) marks(itemSchema, item, planAt(plan.inner, index));
      });
      return;
    }
    case "record": {
      if (!isPlainObject(value)) return;
      for (const [key, item] of Object.entries(value)) {
        if (def.keyType) marks(def.keyType, key, planAt(plan.keys, key));
        if (def.valueType) marks(def.valueType, item, planAt(plan.inner, key));
      }
      return;
    }
    case "map": {
      if (!(value instanceof Map)) return;
      [...value].forEach(([key, item], index) => {
        if (def.keyType) marks(def.keyType, key, planAt(plan.keys, index));
        if (def.valueType) marks(def.valueType, item, planAt(plan.inner, index));
      });
      return;
    }
    case "union":
      // Every option the value parses as, not the first: a looser object option parses a value by stripping the
      // key a stricter one marks, and marking by it alone would copy that key through.
      for (const option of appliedOptions(def.options ?? [], value)) marks(option, value, plan);
      return;
    case "intersection":
      if (def.left) marks(def.left, value, plan);
      if (def.right) marks(def.right, value, plan);
      return;
    case "pipe": {
      // A codec holds its app side. A plain pipe's output is a transform's when `out` is one, so its input
      // shape is the one that names the fields.
      const target = pipeTarget(node, def);
      if (target) marks(target, value, plan);
      return;
    }
    case "lazy":
      if (def.getter) marks(def.getter(), value, plan);
      return;
    default:
      return;
  }
}

/**
 * **Step three: the plan applied, once.** Every marked position takes its class's mask, every marked key is
 * replaced by its own, and nothing else is touched: no key is dropped or added, so no field `parse` keeps is lost.
 */
function applied(plan: Plan | undefined, value: unknown): unknown {
  if (!plan || value === null || value === undefined) return value;
  if (plan.mask !== undefined) return mask(plan.mask, value);
  if (plan.inner.size === 0 && plan.keys.size === 0) return value;
  if (Array.isArray(value)) return value.map((item, index) => applied(plan.inner.get(index), item));
  if (value instanceof Set) return new Set([...value].map((item, index) => applied(plan.inner.get(index), item)));
  if (value instanceof Map) {
    const out = new Map<unknown, unknown>();
    [...value].forEach(([key, item], index) => {
      const redactedKey = applied(plan.keys.get(index), key);
      const name =
        redactedKey !== key && typeof redactedKey === "string"
          ? distinct(redactedKey, (candidate) => out.has(candidate))
          : redactedKey;
      out.set(name, applied(plan.inner.get(index), item));
    });
    return out;
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const redactedKey = String(applied(plan.keys.get(key), key));
      const name = redactedKey === key ? key : distinct(redactedKey, (candidate) => Object.hasOwn(out, candidate));
      out[name] = applied(plan.inner.get(key), item);
    }
    return out;
  }
  return value;
}

/**
 * The masked view of a value, against the schema it is an instance of. See the module note for exactly what it
 * reads, and why the mask is a placeholder.
 */
export function redact<S extends z.ZodType>(schema: S, value: z.output<S>): Redacted<z.output<S>> {
  const unmasked = kept(schema, value);
  const plan = newPlan();
  marks(schema, unmasked, plan);
  return applied(plan, unmasked) as Redacted<z.output<S>>;
}
