// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { z } from "zod";
import { privacyClass } from "./classes";
import {
  carried,
  leafIs,
  MAX_RECURSION_DEPTH,
  type Position,
  type Shape,
  type Site,
  siteOf,
  TRUNCATED_CLASS,
} from "./classify";
import type { RedactedOutput } from "./types";

/**
 * **The masked view: safe for a log, an audit record and an error detail** (#132).
 *
 * `redact(User, user)` walks the schema and the value together and returns a copy in which every unmarked field
 * is verbatim and every marked one is its class's mask — `[pii]`, `[phi]`, `[secret]`, a PAN's first six and
 * last four, or whatever an adopter's class says. The result carries no brand, so it compiles into every
 * surface the type gate guards.
 *
 * ## The rule
 *
 * One coarse rule, the one `classifyPrivacy` lists positions by and `Redacted<T>` types (`./classify` states it in
 * full). **Structural nodes are walked**: objects, arrays, records, tuples, the wrappers that are the same field,
 * unions, intersections and lazies. At a union or an intersection a position is masked when any option or side marks
 * it, so no branch is ever chosen. **Every other node is opaque** — a transform, a pipe, a preprocess, a codec, a
 * `z.custom`, `any`, `unknown`, a set, a map, a promise, a function — and an opaque node with a mark anywhere inside
 * it is masked whole, as `[class]` for the strongest class it carries. One with no mark inside is kept as it is,
 * unless something else at its position marks: a transform or an `unknown` beside a marked object reads or holds the
 * same value, so the position is masked whole. A scalar kind never masks a position by itself, and a coercion is not a
 * scalar.
 *
 * ## What it over-masks, and what it cannot see
 *
 * - **A JSON column with a marked field inside is masked whole.** `sqliteJson(Profile)` is a codec, and a codec's
 *   decode is a function: `{ profile: "[pii]" }`, not `{ profile: { phone: "[pii]", city: "Oslo" } }`. Log the
 *   column's unmarked fields by name, or keep the marked one in a column of its own.
 * - **A transform over a marked input is masked whole**, whatever it returns. So is a set or a map holding a mark,
 *   and a union of a marked object with a transform, an `unknown` or a loose fallback.
 * - **A field only one option marks is masked in every option.** In `z.union([z.object({ e: pii(z.email()) }),
 *   z.object({ e: z.number() })])` a `{ e: 5 }` comes back `{ e: "[pii]" }`.
 * - **A position two classes mark takes the strongest one's placeholder**, never one class's own mask over the other's
 *   value: a `pii` national ID where an option marks `pci` comes back `[pci]`, not as a PAN's first six and last four.
 * - **A key or an element no schema at its position names** — one a `.catch()` fallback put there, or a value whose
 *   kind no node at its position holds, such as the raw input a fallback handed back where an object was named — is
 *   masked with the strongest class the position carries, and kept where it carries none. It is
 *   never dropped. `classifyPrivacy` cannot list it, because the schema does not name it.
 * - **A check is not seen.** A `.refine()` or an `.overwrite()` that writes a marked value elsewhere is not a node,
 *   and neither is what a `.catch()` fallback writes into a field its schema names.
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
 * **The app shape** — what `Schema.parse(row)` returns — not the SQLite row. `null` and `undefined` stay as they are,
 * because an absent value discloses nothing. **A record's key is redacted by its key schema**, because a key is stored
 * and logged as surely as a value, a symbol key as surely as a string one: two keys that mask alike come back as `[pii]` and `[pii] #2`, so the result holds
 * as many entries as the value did, and a masked key never takes the name of one that stayed as it was. Every key is
 * defined on the copy, not assigned, so an own `__proto__` key stays a key and never becomes the copy's prototype.
 *
 * It never mutates its argument, and it never throws on a value that does not match the schema: it masks what it
 * can name and copies the rest. Nor on any schema `parse` accepts, at any size: it reads each schema once, wherever it
 * appears, from the record `classifyPrivacy` lists, so the two agree on every position. The one limit is recursion
 * (`./classify`). A factory-built recursive schema, whose insides would never end, and a value that comes round to a
 * schema it is already inside more than `MAX_RECURSION_DEPTH` times, are cut off there and the position is masked
 * whole as `[secret]`, the strongest class, because what lies past the limit was not read.
 */

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

/** `key`, or `key #2`, `key #3` … — the first that `taken` does not hold yet. */
function distinct(key: string, taken: ReadonlySet<unknown>): string {
  if (!taken.has(key)) return key;
  let index = 2;
  while (taken.has(`${key} #${index}`)) index += 1;
  return `${key} #${index}`;
}

/** A key or an element no schema at `at` names: masked with the strongest class `at` carries, or kept. */
function unnamed(at: Position, value: unknown): unknown {
  if (value === null || value === undefined) return value;
  const className = carried(at);
  return className === undefined ? value : `[${className}]`;
}

/** Whether a scalar kind holds a value of this kind: a string schema a string, a date schema a `Date`. */
function holds(kind: string, value: unknown): boolean {
  switch (kind) {
    case "string":
    case "template_literal":
      return typeof value === "string";
    case "number":
    case "nan":
      return typeof value === "number";
    case "enum":
      return typeof value === "string" || typeof value === "number";
    case "bigint":
    case "boolean":
    case "symbol":
      return typeof value === kind;
    case "date":
      return value instanceof Date;
    case "literal":
      return typeof value !== "object" && typeof value !== "function";
    default:
      return false;
  }
}

/** Whether a scalar at the position holds `value`, so it is kept as that scalar's own. */
function scalarHolds(at: Position, value: unknown): boolean {
  for (const kind of at.scalars) if (holds(kind, value)) return true;
  return false;
}

/**
 * The shapes a value's path is inside, and how many times each: a shape met again is one more level of recursion.
 */
type Line = Map<Shape, number>;

/**
 * Read into `shape` for one level of a value: `recursion` is how many times the path has come round to a shape it was
 * already inside. Past `MAX_RECURSION_DEPTH` the value is masked whole as the strongest class, and read no further.
 */
function within(shape: Shape, recursion: number, line: Line, read: (recursion: number) => unknown): unknown {
  const again = line.get(shape) ?? 0;
  const deeper = again > 0 ? recursion + 1 : recursion;
  if (deeper > MAX_RECURSION_DEPTH) return `[${TRUNCATED_CLASS}]`;
  line.set(shape, again + 1);
  try {
    return read(deeper);
  } finally {
    line.set(shape, again);
  }
}

/** One position: `site` is what every walk reads there, and `value` what is there. */
function redactAt(site: Site | undefined, value: unknown, recursion: number, line: Line): unknown {
  if (value === null || value === undefined || site === undefined) return value;
  const { at, whole, shape } = site;
  if (whole) return whole.placeholder ? `[${whole.className}]` : mask(whole.className, value);
  // A value no structural node at the position matches — an array where only an object is named, a string a
  // `.catch()` handed back — is masked like a key no schema names, unless a scalar there holds it.
  if (Array.isArray(value)) {
    if (!shape?.leaves.some((leaf) => leafIs(leaf, "array", "tuple"))) return unnamed(at, value);
    return within(shape, recursion, line, (deeper) =>
      value.map((item, index) => {
        const element = index < shape.items.length ? shape.items[index] : shape.rest;
        return element === undefined ? unnamed(at, item) : redactAt(element, item, deeper, line);
      }),
    );
  }
  if (isPlainObject(value)) {
    if (!shape?.leaves.some((leaf) => leafIs(leaf, "object", "record"))) return unnamed(at, value);
    return within(shape, recursion, line, (deeper) => redactedObject(at, shape, value, deeper, line));
  }
  return scalarHolds(at, value) ? value : unnamed(at, value);
}

/**
 * An object's entries, each value redacted by the site at its key, and each key by the site a record's keys are read
 * at. A masked key takes the first name, `[pii]`, `[pii] #2` …, that no kept key and no earlier masked key holds.
 * A symbol key is an entry like any other: a record parse keeps one, so the copy does too.
 */
function redactedObject(
  at: Position,
  shape: Shape,
  value: Record<PropertyKey, unknown>,
  recursion: number,
  line: Line,
): Record<PropertyKey, unknown> {
  const keyMasked = shape.key?.whole !== undefined;
  const entries = Reflect.ownKeys(value)
    .filter((key) => Object.prototype.propertyIsEnumerable.call(value, key))
    .map((key): [PropertyKey, unknown] => [key, value[key]]);
  const taken = new Set<unknown>(keyMasked ? [] : entries.map(([key]) => key));
  const out: Record<PropertyKey, unknown> = {};
  for (const [key, item] of entries) {
    const name = keyMasked ? distinct(String(redactAt(shape.key, key, recursion, line)), taken) : key;
    taken.add(name);
    const field = shape.fields.get(key) ?? shape.catchall;
    // Defined, not assigned: an own `__proto__` key that parse kept stays a key, and never becomes the prototype.
    Object.defineProperty(out, name, {
      value: field === undefined ? unnamed(at, item) : redactAt(field, item, recursion, line),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

/**
 * The masked view of a value, against the schema it is an instance of. See the module note for exactly what it
 * reads, what it over-masks, and why the mask is a placeholder.
 */
export function redact<S extends z.ZodType>(schema: S, value: z.output<S>): RedactedOutput<S> {
  return redactAt(siteOf(schema), value, 0, new Map()) as RedactedOutput<S>;
}
