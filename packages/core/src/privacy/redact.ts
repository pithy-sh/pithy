// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { z } from "zod";
import { privacyClass, strongestPrivacyClass } from "./classes";
import { carriedClasses, classifyPrivacy, privacyOf, runsHere } from "./classify";
import type { RedactedOutput } from "./types";

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
 * ## It fails closed
 *
 * **A position is masked when any branch of the schema that reaches it marks it**: any option of a union or a
 * discriminated union, either side of an intersection, and either side of a pipe, a codec or a transform. It never
 * chooses a branch by testing the value against a schema. That test is what leaked before: the value `redact` holds
 * is the app shape, and `safeParse` runs a codec's or a transform's wire side, so the option that marks a field
 * refuses it and a looser one is applied in its place. Walking every branch needs no guess, and it is the same walk
 * `classifyPrivacy` does, so the two agree on every position the schema decides.
 *
 * **A function over a mark it could read is masked whole.** What
 * `z.object({ email: pii(z.email()) }).transform(toAccount)` returns says nothing about where the email went — a class
 * instance, a renamed field, a copy under a second key — so the position is masked whole with the strongest class the
 * function could read (`secret`, `phi`, `pci`, an adopter's class, then `pii`), as its placeholder. A function is a
 * transform, a preprocess, a `z.custom` or a `z.instanceof`, a `.catch()`, a codec's decode, and every check that can
 * rewrite the value: `.refine()`, `.superRefine()`, `.check()`, `.overwrite()`. It counts wherever it runs at the
 * position — at a pipe's tail or in its middle, behind a lazy or a wrapper, in any option of a union, on either side of
 * an intersection — and a mark it could read is one at or below the position in any branch, except one that sits only
 * after every function there: `z.preprocess(coerce, Profile)` hands `Profile` its value, and `Profile` says where each
 * mark is. A codec's wire side comes before its decode, so a codec whose wire side marks is masked whole; only the
 * kit's own codecs (`./trusted`) are walked, `sqliteJson(Profile)` among them. `classifyPrivacy` reads the same rule
 * (`runsHere`, `carriedClasses`) and lists the position. `Redacted<T>` types it as a `string`, except where only a
 * check runs: a check is not in the type, so there the type says less than `redact` does. A function over an unmarked
 * input, and a refine on an unmarked field, are walked like any other branch.
 *
 * **A class instance or a date where a branch with a mark inside reaches it is masked whole** too, because no schema
 * kind walks into one: in `z.union([z.object({ e: pii(z.email()) }), z.date()])` a `Date` comes back as `[pii]`. This is
 * the one over-masking `classifyPrivacy` cannot list, because it depends on the value.
 *
 * **It may mask a field only some branches mark.** In `z.union([z.object({ e: pii(z.email()) }), z.object({ e:
 * z.number() })])` a `{ e: 5 }` comes back `{ e: "[pii]" }`. That over-masking is the price of never guessing, it is
 * what `classifyPrivacy` already reports for the schema, and `Redacted<T>` types the field as a `string` in every
 * member.
 *
 * **It keeps every key and element any branch keeps, so nothing `parse` keeps is dropped.** A key no branch names
 * — not a field, not a catchall, not a loose object, a record or a transform's opaque output — is one `parse`
 * strips under every branch, and it is dropped here too: `redact(User.pick({ id: true }), user)` returns `{ id }`.
 * Every other key comes back, masked where any branch marks it and verbatim where none does.
 *
 * **A lazy schema is followed**, so a recursive one is masked at every depth: the walk ends where the value does.
 *
 * **A record's or a map's key is redacted by its key schema**, because a key is stored and logged as surely as a
 * value: a record keyed by a `pii()` email masks each key. A masked key never takes the name of a key that stayed
 * as it was, nor of another masked key: two keys that mask alike come back as `[pii]` and `[pii] #2`, so the
 * result holds as many entries as the value did. A set's masked elements are numbered apart the same way, so it keeps
 * every element, and a map's object key is redacted field by field. Every key is defined on the copy, not assigned, so
 * an own `__proto__` key that parse kept under an `unknown` stays a key and never becomes the copy's prototype.
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

/** A schema with its wrappers stepped through. */
function unwrapped(schema: z.ZodType): z.ZodType {
  let node = schema;
  for (let def = defOf(node); WRAPPERS.has(def.type) && def.innerType; def = defOf(node)) node = def.innerType;
  return node;
}

/** Whether a schema is `z.never()`, the catchall a strict object refuses an extra key with. */
function isNever(schema: z.ZodType): boolean {
  return defOf(unwrapped(schema)).type === "never";
}

/** `key`, or `key #2`, `key #3` … — the first that `taken` does not hold yet. */
function distinct(key: string, taken: (candidate: string) => boolean): string {
  if (!taken(key)) return key;
  let index = 2;
  while (taken(`${key} #${index}`)) index += 1;
  return `${key} #${index}`;
}

/**
 * What every branch that reaches one position of the value says about it, merged: the class it masks with, which of
 * an object's keys any branch keeps, how many of an array's elements, and what is marked inside — by property name
 * in an object or a record, by position in an array, a tuple, a set or a map. A key's own plan masks a record's or a
 * map's key.
 */
interface Plan {
  mask?: string;
  /** Whether `mask` masks the position whole because what is there is opaque, so it takes the class's placeholder. */
  whole?: boolean;
  /** Whether some object schema reached this position, so a key no branch names is one parse strips. */
  objects: boolean;
  /** Whether some branch keeps every key here: a loose object, a catchall, a record, a transform, an `unknown`. */
  keepsAll: boolean;
  /** The keys some object branch names. */
  readonly named: Set<string>;
  /** The most elements an array, a set or a tuple branch keeps; `undefined` when none reached this position. */
  elements?: number;
  readonly inner: Map<string | number, Plan>;
  readonly keys: Map<string | number, Plan>;
  /** The schemas already walked at this position, so a lazy that reaches itself, or a shared branch, is walked once. */
  readonly seen: Set<z.ZodType>;
  /** Whether a function runs on the value here, in any branch that reaches it. */
  runs: boolean;
  /** The classes such a function could read, from every branch that reaches here. */
  readonly carried: Set<string>;
}

const newPlan = (): Plan => ({
  objects: false,
  keepsAll: false,
  named: new Set(),
  inner: new Map(),
  keys: new Map(),
  seen: new Set(),
  runs: false,
  carried: new Set(),
});

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
 * A value no schema kind walks into: a class instance, a `Date`, an `Error` — any object that is not a plain object,
 * an array, a map or a set.
 */
function isOpaqueValue(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !isPlainObject(value) &&
    !Array.isArray(value) &&
    !(value instanceof Map) &&
    !(value instanceof Set)
  );
}

/** Mask a position whole with the strongest class `schema` carries anywhere; `false` when it carries none. */
function maskedWhole(schema: z.ZodType, plan: Plan): boolean {
  const strongest = strongestPrivacyClass(classifyPrivacy(schema).map((field) => field.class));
  if (strongest === undefined) return false;
  if (plan.mask === undefined) {
    plan.mask = strongest;
    plan.whole = true;
  }
  return true;
}

/** Schemas whose output is opaque to this walk: they keep whatever object the value is, every key of it. */
const KEEPS_ALL: ReadonlySet<string> = new Set(["transform", "any", "unknown", "custom"]);

/**
 * Step into a position from its parent, or at the root: record whether a function runs on the value here, and the
 * classes it could read, then walk it. Every branch that reaches the position adds to both, so a function in one
 * branch is held to a mark in another.
 */
function enter(schema: z.ZodType, value: unknown, plan: Plan): void {
  if (runsHere(schema)) plan.runs = true;
  for (const className of carriedClasses(schema)) plan.carried.add(className);
  walk(schema, value, plan);
}

/**
 * Where a function runs over a mark it could read, and no branch marks the position itself, the position is masked
 * whole with the strongest class that function could read: what it returned says nothing about where the mark went.
 */
function settle(plan: Plan): void {
  if (plan.mask !== undefined || !plan.runs) return;
  const strongest = strongestPrivacyClass([...plan.carried]);
  if (strongest === undefined) return;
  plan.mask = strongest;
  plan.whole = true;
}

/**
 * **Step one: what every branch says about the value.** It walks the schema and the value together, records each
 * marked position and each kept key in `plan`, and masks nothing yet. At a union, an intersection and a pipe it walks
 * every option and both sides, against the same value, so no branch is chosen and none is tested.
 */
function walk(schema: z.ZodType, value: unknown, plan: Plan): void {
  if (value === null || value === undefined || plan.seen.has(schema)) return;
  plan.seen.add(schema);
  const marked = privacyOf(schema);
  if (marked !== null) {
    // The first class to mark a position masks it; what is inside a masked value is gone with it.
    plan.mask ??= marked;
    return;
  }
  // A class instance or a date where a branch with a mark inside reached it: what the mark became is not readable.
  if (isOpaqueValue(value) && maskedWhole(schema, plan)) return;

  const node = unwrapped(schema);
  const def = defOf(node);

  switch (def.type) {
    case "object": {
      if (!isPlainObject(value)) return;
      plan.objects = true;
      const shape = (node as z.ZodObject).shape as Record<string, z.ZodType>;
      const catchall = def.catchall && !isNever(def.catchall) ? def.catchall : undefined;
      if (catchall) plan.keepsAll = true;
      for (const [key, field] of Object.entries(value)) {
        const fieldSchema = Object.hasOwn(shape, key) ? shape[key] : catchall;
        if (!fieldSchema) continue;
        plan.named.add(key);
        enter(fieldSchema, field, planAt(plan.inner, key));
      }
      return;
    }
    case "array":
      if (!Array.isArray(value) || !def.element) return;
      plan.elements = Number.POSITIVE_INFINITY;
      for (const [index, item] of value.entries()) enter(def.element, item, planAt(plan.inner, index));
      return;
    case "set":
      if (!(value instanceof Set) || !def.valueType) return;
      plan.elements = Number.POSITIVE_INFINITY;
      for (const [index, item] of [...value].entries()) enter(def.valueType, item, planAt(plan.inner, index));
      return;
    case "tuple": {
      if (!Array.isArray(value)) return;
      const items = def.items ?? [];
      const rest = def.rest ?? undefined;
      // A position past a tuple's items with no rest is one parse refuses; another branch may still keep it.
      plan.elements = Math.max(plan.elements ?? 0, rest ? Number.POSITIVE_INFINITY : items.length);
      value.forEach((item, index) => {
        const itemSchema = items[index] ?? rest;
        if (itemSchema) enter(itemSchema, item, planAt(plan.inner, index));
      });
      return;
    }
    case "record": {
      if (!isPlainObject(value)) return;
      plan.keepsAll = true;
      for (const [key, item] of Object.entries(value)) {
        if (def.keyType) enter(def.keyType, key, planAt(plan.keys, key));
        if (def.valueType) enter(def.valueType, item, planAt(plan.inner, key));
      }
      return;
    }
    case "map": {
      if (!(value instanceof Map)) return;
      [...value].forEach(([key, item], index) => {
        if (def.keyType) enter(def.keyType, key, planAt(plan.keys, index));
        if (def.valueType) enter(def.valueType, item, planAt(plan.inner, index));
      });
      return;
    }
    case "union":
      // Every option, a discriminated union's included: the one parse took cannot be read back off the app value.
      for (const option of def.options ?? []) walk(option, value, plan);
      return;
    case "intersection":
      if (def.left) walk(def.left, value, plan);
      if (def.right) walk(def.right, value, plan);
      return;
    case "pipe":
      // Both sides: a codec's wire side and its app side, a plain pipe's input and its output, a transform's input. A
      // function on either side is what `enter` already counted for this position.
      if (def.in) walk(def.in, value, plan);
      if (def.out) walk(def.out, value, plan);
      return;
    case "lazy":
      if (def.getter) walk(def.getter(), value, plan);
      return;
    default:
      if (KEEPS_ALL.has(def.type)) plan.keepsAll = true;
      return;
  }
}

/** A key, redacted by its plan — masked, or a map's object key redacted field by field — and whether it was masked. */
function redactedKey(plan: Plan | undefined, key: unknown): { key: unknown; masked: boolean } {
  return { key: applied(plan, key), masked: plan?.mask !== undefined && key !== null && key !== undefined };
}

/**
 * The entries of a record or a map with their keys redacted. A key that stays as it was keeps its name; a masked one
 * takes the first name, `[pii]`, `[pii] #2` …, that no unmasked key and no earlier masked key holds, so every entry
 * survives.
 */
function redactedEntries<K>(entries: readonly (readonly [K, unknown, Plan | undefined])[]): [unknown, unknown][] {
  const keys = entries.map(([key, , plan]) => redactedKey(plan, key));
  const taken = new Set<unknown>(keys.filter((key) => !key.masked).map((key) => key.key));
  return keys.map((each, index) => {
    if (!each.masked) return [each.key, entries[index]?.[1]];
    const name = distinct(String(each.key), (candidate) => taken.has(candidate));
    taken.add(name);
    return [name, entries[index]?.[1]];
  });
}

/**
 * **Step two: the plan applied, once.** Every marked position takes its class's mask, every marked key is replaced by
 * its own, a key or an element no branch keeps is dropped, and nothing else is touched.
 */
function applied(plan: Plan | undefined, value: unknown): unknown {
  if (!plan || value === null || value === undefined) return value;
  settle(plan);
  if (plan.mask !== undefined) return plan.whole ? `[${plan.mask}]` : mask(plan.mask, value);
  const limit = plan.elements ?? Number.POSITIVE_INFINITY;
  if (Array.isArray(value))
    return value.slice(0, Math.min(value.length, limit)).map((item, index) => applied(plan.inner.get(index), item));
  if (value instanceof Set) {
    // Masked elements alike would merge into one; each takes a name no kept element and no earlier masked one holds.
    const items = [...value].map((item, index) => {
      const at = plan.inner.get(index);
      return { item: applied(at, item), masked: at?.mask !== undefined && item !== null && item !== undefined };
    });
    const taken = new Set<unknown>(items.filter((each) => !each.masked).map((each) => each.item));
    return new Set(
      items.map((each) => {
        if (!each.masked) return each.item;
        const name = distinct(String(each.item), (candidate) => taken.has(candidate));
        taken.add(name);
        return name;
      }),
    );
  }
  if (value instanceof Map) {
    const entries = [...value].map(([key, item], index) => [key, item, plan.keys.get(index)] as const);
    const named = redactedEntries(entries);
    return new Map(named.map(([key, item], index) => [key, applied(plan.inner.get(index), item)]));
  }
  if (isPlainObject(value)) {
    // A key no branch names is one parse strips under every branch; when no object branch reached here, none did.
    const kept = Object.entries(value).filter(([key]) => !plan.objects || plan.keepsAll || plan.named.has(key));
    const entries = kept.map(([key, item]) => [key, item, plan.keys.get(key)] as const);
    // Defined, not assigned: an own `__proto__` key that parse kept stays a key, and never becomes the prototype.
    const out: Record<string, unknown> = {};
    redactedEntries(entries).forEach(([name, item], index) => {
      Object.defineProperty(out, String(name), {
        value: applied(plan.inner.get(entries[index]?.[0] as string), item),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    });
    return out;
  }
  return value;
}

/**
 * The masked view of a value, against the schema it is an instance of. See the module note for exactly what it
 * reads, why it fails closed, and why the mask is a placeholder.
 */
export function redact<S extends z.ZodType>(schema: S, value: z.output<S>): RedactedOutput<S> {
  const plan = newPlan();
  enter(schema, value, plan);
  return applied(plan, value) as RedactedOutput<S>;
}
