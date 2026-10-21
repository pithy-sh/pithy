// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { z } from "zod";
import { privacyClass } from "./classes";
import { MAX_RECURSION_DEPTH, type Position, rootPosition, TRUNCATED_CLASS } from "./classify";
import type { RedactedOutput } from "./types";

/**
 * **The masked view: safe for a log, an audit record and an error detail** (#132).
 *
 * `redact(User, user)` walks the schema and the value together and returns a copy in which every unmarked field
 * is verbatim and every marked one is its class's mask — `[pii]`, `[phi]`, `[secret]`, a PAN's first six and
 * last four, or whatever an adopter's class says. The result carries no brand, so it compiles into every
 * surface the type gate guards.
 *
 * ## The contract
 *
 * `redact(schema, value)` promises exact results for a stated set of schema shapes and documents everything else. It
 * does not try to defend against every construction Zod allows, because a schema built to dodge it can be built, and
 * following every such construction costs more than it protects. What it covers, it covers perfectly; what it does
 * not, it masks whole and says so.
 *
 * **Redacted exactly.** Every marked field is masked with its class placeholder, every unmarked field is kept as
 * `parse` returned it, nothing is dropped, and `Redacted<T>` is the exact type of the result:
 *
 * 1. Rows and objects: `z.object`, strict, loose or with a catchall, and `pick`, `omit`, `partial` and `extend` of one.
 * 2. Collections: arrays, tuples including rest elements, records with marked keys or values, `Map` and `Set`.
 * 3. Wrappers: `optional`, `nullable`, `default`, `catch`, `readonly`, `brand`.
 * 4. Choices: unions, discriminated unions and intersections. A field is masked when any option or side marks it.
 * 5. The kit's database codecs: `SQLiteDate`, `SQLiteBoolean` and `sqliteJson(schema)`. A JSON column's inner fields
 *    are redacted field by field.
 * 6. Recursion defined once: `z.lazy(() => Node)`, or a getter that returns the same schema object, such as trees
 *    and linked lists.
 * 7. Values copied out of a parsed row into a plain object, array, `Map` or `Set` described by any of the above.
 *
 * **Outside the contract.** Custom transforms and pipes, `preprocess`, codecs other than the kit's own, `z.custom`,
 * `any`, `unknown`, and getters that build a new schema on each read. `redact` does not look inside these. When
 * anything beneath one is marked, the whole value is masked with the strongest class it carries, and `Redacted<T>`
 * types that position `unknown`. When nothing beneath it is marked, it is kept as it is. Recursion past a fixed depth
 * is masked whole. None of this ever throws or leaks a raw marked value.
 *
 * ## The edges, exactly
 *
 * - **A position two classes reach takes the strongest one's placeholder**, never one class's own mask: a PAN's
 *   first six and last four apply only where `pci` is the only class there.
 * - **A key or an element no schema at its position names** — one only an opaque node could have put there — is
 *   masked with the strongest class the position carries, and kept where it carries none. It is never dropped.
 * - **A record's or a map's key is redacted by its key schema**, and so is a set's element. Two that mask alike come
 *   back as `[pii]` and `[pii] #2`, so the copy holds as many entries as the value did. Every key is defined on the
 *   copy, not assigned, so an own `__proto__` key stays a key.
 * - **Recursion past {@link MAX_RECURSION_DEPTH}**: a value that comes round to a position it is already inside more
 *   often than that is masked whole there as `[secret]`, the strongest class, because the walk stops reading.
 * - **A getter Zod has already resolved is a fixed schema.** Zod reads an object's getters once, the first time the
 *   shape is read. A getter that builds a new schema each read is opaque where `redact` meets it first; where `parse`
 *   resolved it first, the schema it settled on is walked like any other, and every mark in it is still masked.
 *
 * ## The placeholder, and why it is not a hash
 *
 * `[pii]` loses correlation: two log lines about one person look unrelated. A keyed per-class hash would keep it,
 * and an email is low-entropy enough to brute-force from an unkeyed one — so the hash would need a secret salt,
 * which would pull `@pithy-sh/secrets` into core. The placeholder is the v1 answer, and correlation is what the
 * unmarked id beside it is for.
 *
 * It reads the app shape — what `Schema.parse(row)` returns — and never mutates its argument. `null` and `undefined`
 * stay as they are, because an absent value discloses nothing.
 */

/** A plain object — not an array, not a `Date`, not a class instance. */
function isPlainObject(value: unknown): value is Record<PropertyKey, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** How a masked position masks a value: its class's own mask, or the placeholder of the strongest class there. */
function masked(at: Position, value: unknown): string {
  const { mask } = at;
  if (mask === undefined) return String(value);
  return (mask.own ? privacyClass(mask.className)?.mask(value) : undefined) ?? `[${mask.className}]`;
}

/** A key or an element no schema at `at` names: masked with the strongest class `at` carries, or kept. */
function unnamed(at: Position, value: unknown): unknown {
  if (value === null || value === undefined) return value;
  const className = at.carried;
  return className === undefined ? value : `[${className}]`;
}

/** `name`, or `name #2`, `name #3` … — the first that `taken` does not hold yet. */
function distinct(name: unknown, taken: { has(key: unknown): boolean }): unknown {
  if (typeof name !== "string" || !taken.has(name)) return name;
  let index = 2;
  while (taken.has(`${name} #${index}`)) index += 1;
  return `${name} #${index}`;
}

/** The positions a value's path is inside, and how many times each: one met again is one more level of recursion. */
type Line = Map<Position, number>;

/** One value at one position. `depth` is how often the path has come round to a position it was already inside. */
function redactAt(at: Position | undefined, owner: Position, value: unknown, depth: number, line: Line): unknown {
  if (at === undefined) return unnamed(owner, value);
  if (value === null || value === undefined) return value;
  if (at.mask) return masked(at, value);
  const again = line.get(at) ?? 0;
  const deeper = again > 0 ? depth + 1 : depth;
  if (deeper > MAX_RECURSION_DEPTH) return `[${TRUNCATED_CLASS}]`;
  line.set(at, again + 1);
  try {
    return redactKind(at, value, deeper, line);
  } finally {
    line.set(at, again);
  }
}

/** A value walked by its kind against the structural nodes at its position. A scalar is kept. */
function redactKind(at: Position, value: unknown, depth: number, line: Line): unknown {
  const { kinds } = at;
  const walk = (child: Position | undefined, item: unknown): unknown => redactAt(child, at, item, depth, line);
  if (Array.isArray(value)) {
    if (!kinds.has("array") && !kinds.has("tuple")) return unnamed(at, value);
    return value.map((item, index) => walk(at.item(index), item));
  }
  if (value instanceof Map) {
    if (!kinds.has("map")) return unnamed(at, value);
    const out = new Map<unknown, unknown>();
    for (const [key, item] of value) out.set(distinct(walk(at.mapKey, key), out), walk(at.mapValue, item));
    return out;
  }
  if (value instanceof Set) {
    if (!kinds.has("set")) return unnamed(at, value);
    const out = new Set<unknown>();
    for (const item of value) out.add(distinct(walk(at.element, item), out));
    return out;
  }
  if (isPlainObject(value)) {
    if (!kinds.has("object") && !kinds.has("record")) return unnamed(at, value);
    return redactObject(at, value, walk);
  }
  // A scalar where only structural nodes are named is one no schema here holds: what a `.catch()` fallback handed back.
  return at.other ? value : unnamed(at, value);
}

/**
 * An object's entries, each value redacted at its key's position and each key at a record's key position. A masked
 * key takes the first name, `[pii]`, `[pii] #2` …, that no kept key and no earlier masked key holds.
 */
function redactObject(
  at: Position,
  value: Record<PropertyKey, unknown>,
  walk: (child: Position | undefined, item: unknown) => unknown,
): Record<PropertyKey, unknown> {
  const keyMasked = at.key?.mask !== undefined;
  const keys = Reflect.ownKeys(value).filter((key) => Object.prototype.propertyIsEnumerable.call(value, key));
  const taken = new Set<unknown>(keyMasked ? [] : keys);
  const out: Record<PropertyKey, unknown> = {};
  for (const key of keys) {
    const name = keyMasked ? (distinct(masked(at.key as Position, key), taken) as string) : key;
    taken.add(name);
    // Defined, not assigned: an own `__proto__` key that parse kept stays a key, and never becomes the prototype.
    Object.defineProperty(out, name, {
      value: walk(at.field(key), value[key]),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

/** The masked view of a value, against the schema it is an instance of. See the module note for the contract. */
export function redact<S extends z.ZodType>(schema: S, value: z.output<S>): RedactedOutput<S> {
  const root = rootPosition(schema);
  return redactAt(root, root, value, 0, new Map()) as RedactedOutput<S>;
}
