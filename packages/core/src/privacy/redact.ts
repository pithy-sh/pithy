// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { z } from "zod";
import { privacyClass } from "./classes";
import { MAX_RECURSION_DEPTH, type Mask, type Position, rootPosition, TRUNCATED_CLASS } from "./classify";
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
 * following every such construction costs more than it protects. What it covers, it covers perfectly; what it does not,
 * it masks whole and says so.
 *
 * **Redacted exactly.** Every marked field is masked with its class placeholder, every unmarked field is kept as
 * `parse` returned it, nothing is dropped, and `Redacted<T>` is the exact type of the result, save the one position
 * item 6 names:
 *
 * 1. Rows and objects: `z.object`, strict, loose or with a catchall, and `pick`, `omit`, `partial` and `extend` of one.
 * 2. Collections: arrays, tuples including rest elements, records with marked keys or values, `Map` and `Set`.
 * 3. Wrappers: `optional`, `nullable`, `default`, `catch`, `readonly`, `brand`.
 * 4. Choices: unions, discriminated unions and intersections. An option's marks apply where the value has that option's
 *    shape: an object option to an object value, an array option to an array value. A field is masked when any option
 *    or side that applies marks it, and a key no option names is kept.
 * 5. The kit's database codecs: `SQLiteDate`, `SQLiteBoolean` and `sqliteJson(schema)`. A JSON column's inner fields
 *    are redacted field by field.
 * 6. Recursion: `z.lazy(() => Node)` and getters, whether a getter returns one schema or builds a new one each read,
 *    such as trees and linked lists. Walked exactly to a fixed recursion depth. Past it the position is masked whole,
 *    and `Redacted<T>` types it `unknown` from that same depth: one limit, shared by the runtime and the type, however
 *    the recursion is written. A self-referencing `z.lazy` has to be annotated `z.ZodType<T>`, which names no kind, so
 *    `Redacted<T>` types it, and every field that holds it, `unknown`. Write the recursion with a getter and the type
 *    keeps its shape to the limit.
 * 7. Values copied out of a parsed row into a plain object, array, `Map` or `Set` described by any of the above.
 *
 * **Outside the contract.** Custom transforms and pipes, `preprocess`, codecs other than the kit's own (one built the
 * way `sqliteJson` is built included), `z.custom`, `any` and `unknown`. `redact` does not look inside these. When
 * anything beneath one is marked, the whole value is masked with the strongest class it carries, and `Redacted<T>`
 * types that position `unknown`. When nothing beneath it is marked, it is kept as it is, including when it is a union
 * option beside a marked one. A recursion beneath it that reaches the item 6 depth limit counts as possibly marked, so
 * that value is masked whole and typed `unknown`. None of this ever throws or leaks a raw marked value.
 *
 * ## The edges, exactly
 *
 * - **A position two classes reach takes the strongest one's placeholder**, never one class's own mask: a PAN's
 *   first six and last four apply only where `pci` is the only class there.
 * - **An option's marks apply where the value has that option's shape.** An object option's apply to an object
 *   value, an array option's to an array value, and a marked string option's to a string: beside
 *   `z.array(z.string())` an array is walked, and beside `z.number()` a number is kept. A mark reached through no
 *   option applies to every value. A key or an element no option names is kept, and so is a value of a kind no
 *   option names, such as an array a `z.unknown()` beside an object option let through. A record's string key is a
 *   string whatever its schema says, a number key's included, so a key schema that marks any shape but a symbol masks
 *   every string key; a symbol key is masked only by a marked symbol option.
 * - **A record's or a map's key is redacted by its key schema**, and so is a set's element. Two that mask alike come
 *   back as `[pii]` and `[pii] #2`, so the copy holds as many entries as the value did. Only a masked one is ever
 *   numbered: a kept one stays as it is, even one that reads `[pii]`, and a masked one takes the first name no kept
 *   one holds. Every key is defined on the copy, not assigned, so an own `__proto__` key stays a key.
 * - **The one recursion limit is {@link MAX_RECURSION_DEPTH} levels of nesting**: every object, array, tuple, record,
 *   map and set a position sits inside counts one. A position deeper than that is masked whole as `[secret]`, the
 *   strongest class, and `Redacted<T>` types it `unknown` from the same depth. Nothing tells one recursion from
 *   another, so a lazy, a getter that returns one schema and one that builds a new schema each read all end at the
 *   same level, and the result is a function of the schema and the value alone. The walk keeps its own stack, so a
 *   deep value never overflows the call stack. A recursion beneath an opaque node that reaches the limit masks that
 *   node's value whole as `[secret]` too, and a lazy that builds a new choice each read ends at the limit the same
 *   way: every lazy nested in another counts one. A union of many lazies, none inside another, counts one.
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

/** How a mask masks a value: its class's own mask, or the placeholder of the strongest class there. */
function masked(mask: Mask, value: unknown): string {
  return (mask.own ? privacyClass(mask.className)?.mask(value) : undefined) ?? `[${mask.className}]`;
}

/** `name`, or `name #2`, `name #3` … — the first that `taken` does not hold yet. */
function distinct(name: unknown, taken: { has(key: unknown): boolean }): unknown {
  if (typeof name !== "string" || !taken.has(name)) return name;
  let index = 2;
  while (taken.has(`${name} #${index}`)) index += 1;
  return `${name} #${index}`;
}

/** A child's result, and whether it is a mask: only a masked key or element is ever renamed. */
type Result = { value: unknown; masked: boolean };

/**
 * Keys or elements, each kept or masked, made distinct: every kept one first, as it is, then each masked one at the
 * first name, `[pii]`, `[pii] #2` …, that no kept one and no earlier masked one holds. In the value's order.
 */
function distinctAll(results: readonly Result[]): unknown[] {
  const taken = new Set<unknown>(results.filter((result) => !result.masked).map((result) => result.value));
  return results.map((result) => {
    if (!result.masked) return result.value;
    const name = distinct(result.value, taken);
    taken.add(name);
    return name;
  });
}

/**
 * One step of the walk. `visit` redacts one value at one position, `depth` levels of nesting down, and hands the
 * result to `put`; `after` runs once every step above it on the stack is done, to fill a map or a set in order. The
 * walk keeps its own stack rather than the call stack, so a deep value never overflows it.
 */
type Step = { visit: unknown; at: Position | undefined; depth: number; put: Put } | { after: () => void };

/** Where a result goes, and whether it is a mask. */
type Put = (result: unknown, masked: boolean) => void;

/** How a child is handed to the walk: its position, its value, and where its result goes. */
type Walk = (child: Position | undefined, item: unknown, put: Put) => void;

/** The walk: every value at its position, depth first and in order. */
function walkValue(root: Position, value: unknown): unknown {
  let result: unknown;
  const steps: Step[] = [
    {
      visit: value,
      at: root,
      depth: 0,
      put: (out) => {
        result = out;
      },
    },
  ];
  for (let step = steps.pop(); step; step = steps.pop()) {
    if ("after" in step) step.after();
    else redactAt(step, steps);
  }
  return result;
}

/**
 * One value at one position. A position nested deeper than {@link MAX_RECURSION_DEPTH} is masked whole as
 * {@link TRUNCATED_CLASS}, however the recursion that reached it is written. A key or an element no schema names is
 * kept: an option's marks apply only where the value has that option's shape.
 */
function redactAt(step: Extract<Step, { visit: unknown }>, steps: Step[]): void {
  const { at, depth, visit: value, put } = step;
  if (value === null || value === undefined) put(value, false);
  else if (depth > MAX_RECURSION_DEPTH) put(`[${TRUNCATED_CLASS}]`, true);
  else if (at === undefined) put(value, false);
  else {
    // A mark applies to a value of the shape of the option it was reached through, and to no other.
    const mask = at.maskFor(value);
    if (mask) {
      put(masked(mask, value), true);
      return;
    }
    const below: Step[] = [];
    put(
      redactKind(at, value, below, (child, item, out) => {
        below.push({ visit: item, at: child, depth: depth + 1, put: out });
      }),
      false,
    );
    // Popped last to first: what is below runs in order.
    steps.push(...below.reverse());
  }
}

/**
 * A value walked by its kind against the structural nodes at its position, as the copy its children are put into.
 * A value of a kind no node here names, and a scalar, is kept. Each child is a step in `below`, in order.
 */
function redactKind(at: Position, value: unknown, below: Step[], walk: Walk): unknown {
  const { kinds } = at;
  if (Array.isArray(value)) {
    if (!kinds.has("array") && !kinds.has("tuple")) return value;
    // `map`, so a hole stays a hole, as it did in the value.
    const out = value.map(() => undefined) as unknown[];
    value.forEach((item, index) => {
      walk(at.item(index), item, (result) => {
        out[index] = result;
      });
    });
    return out;
  }
  if (value instanceof Map) {
    if (!kinds.has("map")) return value;
    const out = new Map<unknown, unknown>();
    const keys: Result[] = [];
    const items: unknown[] = [];
    for (const [key, item] of value) {
      const index = items.push(undefined) - 1;
      keys.push({ value: undefined, masked: false });
      walk(at.mapKey, key, (result, isMask) => {
        keys[index] = { value: result, masked: isMask };
      });
      walk(at.mapValue, item, (result) => {
        items[index] = result;
      });
    }
    below.push({
      after: () => {
        distinctAll(keys).forEach((key, index) => {
          out.set(key, items[index]);
        });
      },
    });
    return out;
  }
  if (value instanceof Set) {
    if (!kinds.has("set")) return value;
    const out = new Set<unknown>();
    const items: Result[] = [];
    for (const item of value) {
      const index = items.push({ value: undefined, masked: false }) - 1;
      walk(at.element, item, (result, isMask) => {
        items[index] = { value: result, masked: isMask };
      });
    }
    below.push({
      after: () => {
        for (const item of distinctAll(items)) out.add(item);
      },
    });
    return out;
  }
  if (isPlainObject(value) && (kinds.has("object") || kinds.has("record"))) return redactObject(at, value, walk);
  return value;
}

/**
 * An object's entries, each value redacted at its key's position and each key at a record's key position: a string
 * key by every mark there but a symbol's, since it is a string whatever its schema says, and a symbol key by a
 * symbol's alone. A masked key takes the first name, `[pii]`, `[pii] #2` …, that no kept key and no earlier masked
 * key holds. Each value is put in when its step runs, and the steps run in key order, so the copy keeps the value's.
 */
function redactObject(at: Position, value: Record<PropertyKey, unknown>, walk: Walk): Record<PropertyKey, unknown> {
  const keyAt = at.key;
  const keys = Reflect.ownKeys(value).filter((key) => Object.prototype.propertyIsEnumerable.call(value, key));
  const names = distinctAll(
    keys.map((key): Result => {
      const mask = typeof key === "symbol" ? keyAt?.maskFor(key) : keyAt?.nameMask;
      return mask ? { value: masked(mask, key), masked: true } : { value: key, masked: false };
    }),
  ) as PropertyKey[];
  const out: Record<PropertyKey, unknown> = {};
  keys.forEach((key, index) => {
    const name = names[index] as PropertyKey;
    // Defined, not assigned: an own `__proto__` key that parse kept stays a key, and never becomes the prototype.
    walk(at.field(key), value[key], (result) => {
      Object.defineProperty(out, name, { value: result, enumerable: true, writable: true, configurable: true });
    });
  });
  return out;
}

/** The masked view of a value, against the schema it is an instance of. See the module note for the contract. */
export function redact<S extends z.ZodType>(schema: S, value: z.output<S>): RedactedOutput<S> {
  const root = rootPosition(schema);
  return walkValue(root, value) as RedactedOutput<S>;
}
