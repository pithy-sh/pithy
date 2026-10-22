// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { z } from "zod";
import { isSqliteJson, SQLiteBoolean, SQLiteDate } from "../data/codecs";
import { ownPrivacyClasses, privacyClasses, rankPrivacyClasses, strongestPrivacyClass } from "./classes";

/**
 * **Reading a privacy marker off a schema, and every marker off a schema tree** (#132).
 *
 * The marker is `meta({ privacy })` on the schema a marker was handed. {@link privacyOf} reads it through the
 * wrappers that are the same field — `pii(z.string()).optional()` is `pii` — and {@link classifyPrivacy} names
 * each position of a schema that `redact` masks.
 *
 * ## The redaction contract
 *
 * `redact`, `classifyPrivacy` and `Redacted<T>` all read the one record this module builds for a position, so they
 * agree on every one. The contract they keep is stated on #132 and in `docs/PRIVACY.md`:
 *
 * - **Walked exactly**: objects (strict, loose, catchall, and `pick`, `omit`, `partial`, `extend` of one), arrays,
 *   tuples and their rest, records, `Map` and `Set`; the wrappers `optional`, `nullable`, `default`, `catch` with a
 *   constant value, `readonly` and a brand; unions, discriminated unions and intersections, where an option's marks apply where
 *   the value has that option's shape — a marked string option to a string, never to an array or a number beside
 *   it — and a mark reached through no option applies to every value; the kit's `SQLiteDate`, `SQLiteBoolean` and
 *   `sqliteJson(schema)`, read through to the schema they decode to; and recursion, a `z.lazy` or a getter, to the
 *   one limit below.
 * - **Everything else is opaque**: a transform, a pipe, a preprocess, any other codec, `z.custom`, `any`, `unknown`,
 *   and an `.overwrite()` or a `.catch()` with a fallback function over a structure, which make a new value.
 *   Nothing inside one is walked. With a mark anywhere beneath it, its position is masked whole with the strongest
 *   class it carries; with none, it is kept, a union option beside a marked one included.
 * - **A mark on a container masks it whole**, and the container carries every class marked inside it as well as its
 *   own: `pii(z.object({ token: secret(z.string()) }))` is listed `pii` and `secret`, and masked `[secret]`.
 * - **Recursion is bounded once**, at {@link MAX_RECURSION_DEPTH} levels of nesting: a position deeper than that is
 *   masked whole as {@link TRUNCATED_MASK}, whatever the recursion is written with. It is a safety cutoff rather than a
 *   privacy class, so `classifyPrivacy` does not list it and `hasPrivacy` does not see it. A path that reaches it ends
 *   alone: every other path is still read, so a class beside a recursion is found whatever the field order, and a
 *   position masked whole for a class it carries is masked with that class, cut off below or not. The cutoff is a flag
 *   beside the classes, never instead of them. Nothing here tells one kind of recursion from another, so every answer
 *   is a function of the schema and the value alone.
 * - **`classifyPrivacy` reads at most {@link MAX_CLASSIFIED_POSITIONS} distinct positions**, level by level,
 *   shallowest first. A position is read once wherever it sits, so a schema reused in many fields costs one. `redact`
 *   walks a value, which is finite; a list walks the schema, and one that builds two new schemas at every level has
 *   more positions than any list can hold. Such a schema is read whole down to the level the budget runs out on, and
 *   each new position left, none of them above that level, is listed with every class registered, each with
 *   `truncated`: nothing below it was read, so any class may be marked there, and the list never says less than the
 *   schema marks. It is one of four places the list says more than `redact` masks, beside the classes a cut assumes,
 *   a reference's own path and an intersection that narrows. Every other read that runs out of
 *   {@link MAX_SEARCHED_SCHEMAS} — the search beneath a marked container or an opaque node, and the read of a level of
 *   lazies — assumes every class past it the same way, each class it did not find listed `truncated`, and `redact`
 *   masks that value with the strongest. A position the walk cannot read at all, nested deeper than the stack can
 *   follow, is listed with every class, each `truncated`: nothing here throws.
 * - **`classifyPrivacy` writes out at most {@link MAX_LISTED_PATHS} paths.** A schema reused in two fields at every
 *   level has a path per field per level, two to the depth; past the cap a position met again is listed at its own
 *   path once per class marked beneath it, with `sameAs` the path it was first written out under: `redact` masks the
 *   paths below it, not that path itself. Time and memory are linear in the schemas a tree holds, never in its paths,
 *   and every class is still listed. So is the read of one position, whose choices may wrap one schema on every side.
 * - **An intersection is not narrowed.** Where one side narrows a field so it can never hold the type the other side
 *   marks, `classifyPrivacy` may still list that field: the inventory can list more than `redact` masks, and never
 *   less. `z.intersection(z.object({ b: z.number() }), z.object({ b: z.union([pii(z.string()), z.number()]) }))`
 *   lists `b` as `pii`, and `redact` keeps a `b` of `3`.
 *
 * ## What a path looks like
 *
 * Object keys join with `.`, an array or set element is `[]`, a tuple position is `[i]`, a record's or a map's value
 * and an object's catchall are `*`, and a record's or a map's key is `<key>`: `address.line1`, `devices[].token`,
 * `pair[1]`, `notes.*`, `byEmail.<key>`. A marked root is the empty path. A position masked whole is listed once per
 * class it carries, and nothing below it is.
 */

/** One marked path in a schema, and its class. The per-field record the inventory is built from. */
export interface PrivacyField {
  /** Where in the value the field sits: `email`, `address.line1`, `devices[].token`, or `""` for the root. */
  path: string;
  /** The class it was marked with. */
  class: string;
  /**
   * Set where the class is assumed rather than found: a position left once the walk had read
   * {@link MAX_CLASSIFIED_POSITIONS} distinct positions, level by level; a read beneath a position that ran out of
   * {@link MAX_SEARCHED_SCHEMAS}; or a schema the walk could not read at all, nested deeper than the stack. Each lists
   * {@link unreadClasses}. Absent everywhere the schema was read to the end. A position past
   * {@link MAX_RECURSION_DEPTH} is not listed at all: it is cut off, not classified.
   */
  truncated?: true;
  /**
   * Set on a reference: the path this field's position was first listed under. Once the walk has written out
   * {@link MAX_LISTED_PATHS} paths, a position it meets again is listed once per class marked beneath it, with the path
   * it was first written out under, rather than once per path below it. The paths below `sameAs` are the paths below
   * this one.
   */
  sameAs?: string;
}

/**
 * **The one recursion limit**, shared by `redact`, `classifyPrivacy` and `Redacted<T>` (`./types` reads this constant's
 * type). Depth is counted in levels of nesting: every object, array, tuple, record, map and set a position sits inside.
 * A position deeper than this is masked whole as {@link TRUNCATED_MASK} and typed `unknown`, however the recursion
 * is written: a `z.lazy`, a getter that returns one schema, or one that builds a new schema each read. No schema
 * written out by hand nests this deep, so only a recursion reaches it. A search for a mark beneath an opaque node or a
 * marked container ends a path at the same depth, counting each lazy too, and reads every other path; so does the one
 * `Redacted<T>` makes. So does a read of the shapes a choice can have, and of the schemas that reach one position,
 * each counting the lazies nested above a schema:
 * a lazy that builds a new choice each read never meets a schema twice. A union of many lazies, none inside another,
 * counts one.
 */
export const MAX_RECURSION_DEPTH = 256;

/**
 * How many distinct positions {@link classifyPrivacy} reads, level by level, before it lists each new one left with
 * {@link unreadClasses}. A position is read once wherever it sits, so a schema reused in a thousand fields costs one.
 * Far past any schema written out, and past any recursion defined once, which is listed once; only one that builds two
 * new schemas at every level reaches it, and then only below the levels it read whole.
 */
export const MAX_CLASSIFIED_POSITIONS = 10_000;

/**
 * How many schemas one read of a position, or one search beneath a node for a mark, opens before each path left ends
 * as cut off. Opening a node is what may build a schema — a lazy's target, an object's shape read through its getters
 * — so it is what is counted. Both reads go shallowest first and check the budget between levels, never inside one:
 * a level begun is read whole, however wide, so a union of any width is read to its end, and a level past the budget
 * is still read for its marks. A read of the shapes a choice can have, which goes depth first, counts only the lazies
 * nested in another, so a union of lazies side by side costs it none, and pays again what a schema it met before cost,
 * so every answer is a function of the schema and the value alone, whatever was read first. Far past any schema
 * written out, and past any recursion that builds one new schema at each level; only one that builds two new ones at
 * every level reaches it, and then only below the levels it read whole. A class found is kept, past it or not, and
 * past it every class is assumed: nothing there was read, so any of them may be marked, and the list never says less.
 * The searches beneath the lazies one read of a position cuts off share one such budget between them.
 */
export const MAX_SEARCHED_SCHEMAS = 10_000;

/**
 * How many paths {@link walkPrivacy} writes out before a position it met already is listed by reference. A schema
 * reused in two fields at every level of thirty has thirty-one schemas and a billion paths, so a list of every path
 * cannot be built; past this many, each new position is still read and written out once, and each one met again is
 * listed at its own path with every class beneath it and `sameAs` the path it was written out under. So the list is
 * linear in the schemas a tree holds. Far past any table written out: a book of 22 groups of 22 contacts of 22
 * addresses is written out whole.
 */
export const MAX_LISTED_PATHS = 50_000;

/**
 * What `redact` puts where it stops: a value nested past {@link MAX_RECURSION_DEPTH}, and an opaque value over a
 * recursion that reaches it. A safety cutoff rather than a privacy class, so no list names it.
 */
export const TRUNCATED_MASK = "[truncated]";

/**
 * The classes {@link classifyPrivacy} lists for a position it did not read once {@link MAX_CLASSIFIED_POSITIONS} ran
 * out: every class registered, strongest first, because nothing there was read and any of them may be marked below
 * it. So the list never says less than the schema marks, and `hasPrivacy` answers yes for each. A search that runs out
 * of {@link MAX_SEARCHED_SCHEMAS} assumes them too, so `redact` masks that value with the strongest; a schema the walk
 * cannot read at all is listed with them.
 */
export function unreadClasses(): string[] {
  return rankPrivacyClasses(privacyClasses().map((each) => each.name));
}

/** A Zod schema's internal definition, as much of it as the walk reads. */
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
  shape?: Record<PropertyKey, z.ZodType>;
  out?: z.ZodType;
  catchValue?: unknown;
  checks?: readonly unknown[];
}

function defOf(schema: z.ZodType): Def {
  return (schema as unknown as { _zod: { def: Def } })._zod.def;
}

function isSchema(value: unknown): value is z.ZodType {
  return typeof value === "object" && value !== null && "_zod" in value;
}

/** The wrappers that are the same position as what they wrap. A brand is a type, and no node at all. */
const WRAPPERS: ReadonlySet<string> = new Set([
  "optional",
  "nullable",
  "default",
  "prefault",
  "catch",
  "readonly",
  "nonoptional",
]);

/** The kinds a value is walked into. */
const STRUCTURAL: ReadonlySet<string> = new Set(["object", "array", "tuple", "record", "map", "set"]);

/** The tag Zod puts on the function it wraps a constant `.catch()` value in. */
const CONSTANT_CATCH = "~constantCatch";

/**
 * Whether a node hands back a value its own code made rather than the one it read: a `.catch()` with a fallback
 * function, or an `.overwrite()`. A constant fallback is a value, and is walked as the wrapper it is.
 */
function makesValue(def: Def): boolean {
  if (def.type === "catch") {
    const fallback = def.catchValue as { [CONSTANT_CATCH]?: unknown } | undefined;
    if (typeof fallback !== "function" || fallback[CONSTANT_CATCH] !== true) return true;
  }
  return (def.checks ?? []).some(
    (check) => (check as { _zod?: { def?: { check?: unknown } } })._zod?.def?.check === "overwrite",
  );
}

/** The value a constant `.catch()` hands back, or `undefined` for any other node. */
function constantFallback(def: Def): { value: unknown } | undefined {
  if (def.type !== "catch" || makesValue(def)) return undefined;
  try {
    return { value: (def.catchValue as () => unknown)() };
  } catch {
    return undefined;
  }
}

/**
 * The shapes a value can have, as far as a choice is concerned: what `typeof` says, with an object told apart by what
 * it is. An option's marks apply to a value of a shape the option names, and to no other.
 */
export type ValueKind =
  | "string"
  | "number"
  | "bigint"
  | "boolean"
  | "symbol"
  | "function"
  | "date"
  | "object"
  | "array"
  | "map"
  | "set";

/** The shapes a value is walked into. */
const STRUCTURE: readonly ValueKind[] = ["object", "array", "map", "set"];

/** Whether a value of one of `kinds` could be walked into. */
function holdsStructure(kinds: ReadonlySet<ValueKind>): boolean {
  return STRUCTURE.some((kind) => kinds.has(kind));
}

/**
 * A node's shapes, as a choice reads them: every shape for one that {@link makesValue} over a structure, as its own
 * code may hand back anything. A scalar's is still its own: what it makes is the scalar a mark masks or keeps.
 */
function widened(def: Def, kinds: ReadonlySet<ValueKind>): ReadonlySet<ValueKind> {
  return holdsStructure(kinds) && makesValue(def) ? EVERY_KIND : kinds;
}

/** Every {@link ValueKind}, in the order a mask lists them. */
const VALUE_KINDS: readonly ValueKind[] = [
  "string",
  "number",
  "bigint",
  "boolean",
  "symbol",
  "function",
  "date",
  "object",
  "array",
  "map",
  "set",
];

const EVERY_KIND: ReadonlySet<ValueKind> = new Set(VALUE_KINDS);
const NO_KIND: ReadonlySet<ValueKind> = new Set();

/** The shape of a value, or `undefined` for `null` and `undefined`, which are kept wherever they are. */
export function kindOfValue(value: unknown): ValueKind | undefined {
  const type = typeof value;
  if (type === "undefined" || value === null) return undefined;
  if (type !== "object") return type as Exclude<typeof type, "undefined" | "object">;
  if (Array.isArray(value)) return "array";
  if (value instanceof Map) return "map";
  if (value instanceof Set) return "set";
  return value instanceof Date ? "date" : "object";
}

/** The prototype a value of each kind has where it is what its schema parses: a plain object's, a `Date`'s … */
const TYPICAL: Partial<Record<ValueKind, object>> = {
  object: Object.prototype,
  array: Array.prototype,
  map: Map.prototype,
  set: Set.prototype,
  date: Date.prototype,
};

/**
 * Whether a value of `kind` is one its schema parses: a plain object, an `Array.prototype` array, a `Map`, a `Set` or
 * a `Date` of its own prototype, never a subclass or a class instance. A scalar and a function always are.
 */
function isTypical(value: object, kind: ValueKind): boolean {
  const typical = TYPICAL[kind];
  if (typical === undefined) return true;
  const prototype = Object.getPrototypeOf(value);
  return prototype === typical || (kind === "object" && prototype === null);
}

/** The one shape each kind of schema produces. A record is an object, and a tuple an array. */
const SCHEMA_KINDS: Readonly<Record<string, ValueKind>> = {
  string: "string",
  template_literal: "string",
  number: "number",
  nan: "number",
  bigint: "bigint",
  boolean: "boolean",
  symbol: "symbol",
  function: "function",
  date: "date",
  object: "object",
  record: "object",
  array: "array",
  tuple: "array",
  map: "map",
  set: "set",
};

/**
 * The kinds a scalar, a literal, an enum or a node that holds no value names, or `undefined` for an opaque node, which
 * takes a value of any kind and prototype: a transform, a pipe, `z.custom`, `any`, `unknown`, or one that makes its
 * own value.
 */
function scalarKinds(node: z.ZodType): ReadonlySet<ValueKind> | undefined {
  const def = defOf(node);
  if (makesValue(def)) return undefined;
  const one = SCHEMA_KINDS[def.type];
  if (one !== undefined) return new Set([one]);
  if (NO_VALUE.has(def.type)) return NO_KIND;
  if (def.type !== "literal" && def.type !== "enum") return undefined;
  const values = (node as unknown as { _zod: { values?: ReadonlySet<unknown> } })._zod.values;
  return values ? new Set([...values].flatMap((value) => [kindOfValue(value)].filter(isKind))) : undefined;
}

/** The kinds of schema that hold no value a mask could apply to. */
const NO_VALUE: ReadonlySet<string> = new Set(["null", "undefined", "void", "never"]);

/**
 * A schema's shapes, read to its end, how many lazies deep the read went below it, and the lazies it resolved: `top` on
 * its own level, `deep` nested in another below it.
 */
interface KindsFound {
  readonly kinds: ReadonlySet<ValueKind>;
  readonly reach: number;
  readonly top: number;
  readonly deep: number;
}

const kindsRead = new WeakMap<z.ZodType, KindsFound>();

/** A schema on the path of a read of {@link kindsOf}: where on the path it sits, and which time it was put there. */
interface OnPath {
  readonly index: number;
  readonly stamp: number;
}

/**
 * A schema read inside a cycle that comes round to a schema above it: its answer, and the schema on the path that cycle
 * comes round to, as it was put there. The answer holds while that schema is still on the path, put there that time.
 */
interface WithinCycle {
  readonly found: KindsFound;
  readonly anchor: z.ZodType;
  readonly stamp: number;
}

/**
 * One read of {@link kindsOf}: whether it ran past the limit or out of its budget, how deep it went, the schemas on the
 * path, the shallowest place on the path a cycle below came round to, every lazy it resolved, how many of those sat on
 * each level, and the answers of the schemas it read inside a cycle.
 */
interface KindsRead {
  stopped: boolean;
  deepest: number;
  low: number;
  resolved: number;
  stamps: number;
  onLevel: Map<number, number>;
  path: Map<z.ZodType, OnPath>;
  stack: z.ZodType[];
  within: Map<z.ZodType, WithinCycle>;
}

/** What a read of {@link kindsOf} has spent of {@link MAX_SEARCHED_SCHEMAS}: every lazy it resolved inside another. */
function spent(read: KindsRead): number {
  return read.resolved - (read.onLevel.get(0) ?? 0);
}

/**
 * The shapes a schema's output can have: read through its wrappers, the options of a union, the sides of an
 * intersection, a lazy and the kit's codecs, every option to the end. Every shape for anything opaque, whose output
 * nothing here reads, and for a read that meets a path more than {@link MAX_RECURSION_DEPTH} lazies long: a lazy that
 * builds a new choice each read never meets a schema twice, and every shape is the answer that masks the most. Depth
 * first, and the first path that runs out ends the read, so a lazy that builds two new choices at every level is
 * linear. Each read has its own budget, and a lazy costs it one only inside another lazy, so a union of lazies of any
 * width, none inside another, costs none. A schema read to its end is remembered with how deep it went and what it
 * cost, and a read that meets it again pays that cost, so a choice reused in many places is read once and the answer
 * is the same whichever read came first. A schema whose cycles all come round to itself or below is remembered for
 * every read; one inside a cycle that comes round above it is remembered while that schema is still on the path, so a
 * choice reused inside a cycle is read once too. What the read spent is added to `cost`, the read of the position that
 * asked.
 */
function kindsOf(schema: z.ZodType, cost: { spent: number }): ReadonlySet<ValueKind> {
  const read: KindsRead = {
    stopped: false,
    deepest: 0,
    low: Number.POSITIVE_INFINITY,
    resolved: 0,
    stamps: 0,
    onLevel: new Map(),
    path: new Map(),
    stack: [],
    within: new Map(),
  };
  const found = readKinds(schema, 0, read);
  cost.spent += spent(read);
  return read.stopped ? EVERY_KIND : found;
}

/** A schema's answer met again, `depth` lazies down: it would go as deep below as it did before, and cost as much. */
function replay(known: KindsFound, depth: number, read: KindsRead): ReadonlySet<ValueKind> {
  const cost = known.deep + (depth > 0 ? known.top : 0);
  if (depth + known.reach > MAX_RECURSION_DEPTH || spent(read) + cost > MAX_SEARCHED_SCHEMAS) read.stopped = true;
  read.deepest = Math.max(read.deepest, depth + known.reach);
  read.resolved += known.top + known.deep;
  read.onLevel.set(depth, (read.onLevel.get(depth) ?? 0) + known.top);
  return read.stopped ? EVERY_KIND : known.kinds;
}

/** One step of {@link kindsOf}, `depth` lazies down. */
function readKinds(schema: z.ZodType, depth: number, read: KindsRead): ReadonlySet<ValueKind> {
  if (read.stopped) return EVERY_KIND;
  if (depth > MAX_RECURSION_DEPTH) {
    read.stopped = true;
    return EVERY_KIND;
  }
  read.deepest = Math.max(read.deepest, depth);
  const known = kindsRead.get(schema);
  if (known) return replay(known, depth, read);
  const def = defOf(schema);
  const one = SCHEMA_KINDS[def.type];
  if (one !== undefined) return widened(def, new Set([one]));
  if (NO_VALUE.has(def.type)) return NO_KIND;
  if (def.type === "literal" || def.type === "enum") {
    const values = (schema as unknown as { _zod: { values?: ReadonlySet<unknown> } })._zod.values;
    return values ? new Set([...values].flatMap((value) => [kindOfValue(value)].filter(isKind))) : EVERY_KIND;
  }
  // A lazy that only ever resolves to itself holds nothing parse could return: every shape, so nothing is missed.
  const onPath = read.path.get(schema);
  if (onPath) {
    read.low = Math.min(read.low, onPath.index);
    return EVERY_KIND;
  }
  // Read inside a cycle before, and the schema that cycle comes round to is still on the path, put there that time.
  const cycled = read.within.get(schema);
  const anchor = cycled && read.path.get(cycled.anchor);
  if (cycled && anchor?.stamp === cycled.stamp) {
    read.low = Math.min(read.low, anchor.index);
    return replay(cycled.found, depth, read);
  }
  const { deepest, low, resolved } = read;
  const onLevel = read.onLevel.get(depth) ?? 0;
  const index = read.stack.length;
  read.stamps += 1;
  read.deepest = depth;
  read.low = Number.POSITIVE_INFINITY;
  read.path.set(schema, { index, stamp: read.stamps });
  read.stack.push(schema);
  let found: ReadonlySet<ValueKind>;
  try {
    found = widened(def, readStep(schema, def, depth, read));
  } finally {
    read.path.delete(schema);
    read.stack.pop();
  }
  const reach = read.deepest - depth;
  const below = read.low;
  read.deepest = Math.max(deepest, read.deepest);
  read.low = Math.min(low, below);
  if (!read.stopped) {
    const top = (read.onLevel.get(depth) ?? 0) - onLevel;
    const answer: KindsFound = { kinds: found, reach, top, deep: read.resolved - resolved - top };
    // Every cycle below came round to this schema or below it: the answer is the schema's, whatever reached it.
    if (below >= index) kindsRead.set(schema, answer);
    else {
      // A cycle came round above it: the answer holds while the schema it came round to is on the path.
      const to = read.stack[below] as z.ZodType;
      read.within.set(schema, { found: answer, anchor: to, stamp: (read.path.get(to) as OnPath).stamp });
    }
  }
  return found;
}

/** {@link readKinds} for a node that holds other schemas. */
function readStep(schema: z.ZodType, def: Def, depth: number, read: KindsRead): ReadonlySet<ValueKind> {
  if (WRAPPERS.has(def.type) && def.innerType) return readKinds(def.innerType, depth, read);
  if (def.type === "union" && def.options) {
    const joined = new Set<ValueKind>();
    for (const option of def.options) {
      for (const kind of readKinds(option, depth, read)) joined.add(kind);
      // Every shape already, or a path that ran out: the options left can add none.
      if (joined.size === EVERY_KIND.size || read.stopped) break;
    }
    return joined;
  }
  if (def.type === "intersection" && def.left && def.right) {
    const left = readKinds(def.left, depth, read);
    if (left.size === 0) return NO_KIND;
    const right = readKinds(def.right, depth, read);
    return new Set([...left].filter((kind) => right.has(kind)));
  }
  if (def.type === "lazy") {
    // Out of budget, the answer is every shape: the one that masks the most. A lazy inside no other costs nothing.
    if (depth > 0 && spent(read) >= MAX_SEARCHED_SCHEMAS) {
      read.stopped = true;
      return EVERY_KIND;
    }
    read.resolved += 1;
    read.onLevel.set(depth, (read.onLevel.get(depth) ?? 0) + 1);
    const inner = lazyInner(schema);
    return inner ? readKinds(inner, depth + 1, read) : EVERY_KIND;
  }
  const codec = kitCodecOutput(schema);
  return codec ? readKinds(codec, depth, read) : EVERY_KIND;
}

function isKind(kind: ValueKind | undefined): kind is ValueKind {
  return kind !== undefined;
}

/**
 * The class a field was marked with, read through its wrappers — `pii(z.string()).optional()` is `pii` — or
 * `null` when nothing along the chain carries one. A field marked twice, `pii(secret(x))`, is its strongest class.
 * It never throws: a schema whose metadata cannot be read, cloned by `.describe()` or `.meta()` more times than Zod
 * can read it back through, may carry any class, so it answers the strongest of {@link unreadClasses}.
 */
export function privacyOf(schema: z.ZodType): string | null {
  try {
    for (let node: z.ZodType | undefined = schema; node; ) {
      const found = strongestPrivacyClass(ownPrivacyClasses(node));
      if (found !== undefined) return found;
      const def = defOf(node);
      node = WRAPPERS.has(def.type) ? def.innerType : undefined;
    }
  } catch {
    return strongestPrivacyClass(unreadClasses()) ?? null;
  }
  return null;
}

/** The schema one of the kit's three codecs decodes to, or `undefined` for any other node. */
function kitCodecOutput(schema: z.ZodType): z.ZodType | undefined {
  const def = defOf(schema);
  if (def.type !== "pipe") return undefined;
  const kit = def === defOf(SQLiteDate) || def === defOf(SQLiteBoolean) || isSqliteJson(schema);
  return kit ? def.out : undefined;
}

/** What a lazy stands for: Zod's own cached target, the schema `parse` ran. Never its getter called again. */
function lazyInner(schema: z.ZodType): z.ZodType | undefined {
  const inner = (schema as unknown as { _zod: { innerType?: unknown } })._zod.innerType;
  return isSchema(inner) ? inner : undefined;
}

/** An object's fields, read through the shape Zod freezes on first read, so every walk sees the schemas `parse` does. */
function shapeOf(schema: z.ZodType): Record<PropertyKey, z.ZodType> {
  return defOf(schema).shape ?? {};
}

/** Every schema a node holds, whatever its kind: what a search for a mark reads through. */
function children(schema: z.ZodType): z.ZodType[] {
  const def = defOf(schema);
  if (def.type === "lazy") {
    const inner = lazyInner(schema);
    return inner ? [inner] : [];
  }
  const found: z.ZodType[] = def.type === "object" ? Object.values(shapeOf(schema)).filter(isSchema) : [];
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(def))) {
    // A check is not a node, and an accessor — a default's value, a shape — is never run here: it may be the
    // adopter's own function. A lazy's getter is read above, through its cache, and an object's shape through Zod's.
    if (key === "checks" || key === "getter" || !("value" in descriptor)) continue;
    const slot: unknown = descriptor.value;
    if (isSchema(slot)) found.push(slot);
    else if (Array.isArray(slot)) found.push(...slot.filter(isSchema));
  }
  return found;
}

/** What a search found beneath a schema. */
interface Search {
  /** Every class it found marked. */
  readonly classes: ReadonlySet<string>;
  /** Whether a path ended at the recursion limit, or at the budget. */
  readonly truncated: boolean;
  /** Whether a path ended at {@link MAX_SEARCHED_SCHEMAS}: what lies past it was never read, so any class may. */
  readonly unread: boolean;
  /** How many schemas it opened: what a read that asks for many searches pays for each, met before or not. */
  readonly opened: number;
}

const searched = new WeakMap<z.ZodType, Search>();

/**
 * Every class marked anywhere beneath a schema, on every side of every node. Level by level, each level in the order
 * the schema declares it, and each schema once. A path more than {@link MAX_RECURSION_DEPTH} levels long, counting
 * each lazy and each structural node, ends there and marks the search `truncated`; every other path is still read, so
 * a class beside a recursion is found whatever the field order. Shallowest first, and the budget is checked between
 * levels, never inside one: a level begun is read whole, however wide, so a union of any width is read to its end.
 * Once {@link MAX_SEARCHED_SCHEMAS} schemas have been opened, the next level is still read for its marks, nothing on
 * it is opened, and each path it would have opened ends `truncated` and `unread`: what lies past it was never read,
 * so every class is assumed there. That keeps a schema that builds two new ones at every level bounded, the levels
 * above the one the budget runs out on are read whole, and the search never says less than the schema marks.
 */
function search(schema: z.ZodType): Search {
  const known = searched.get(schema);
  if (known) return known;
  const classes = new Set<string>();
  let truncated = false;
  let unread = false;
  let opened = 0;
  const seen = new Set<z.ZodType>();
  let level: z.ZodType[] = [schema];
  for (let depth = 0; level.length > 0; depth += 1) {
    const next: z.ZodType[] = [];
    // Checked once a level, so width never cuts a level short: only how many levels a schema builds can.
    const open = opened < MAX_SEARCHED_SCHEMAS;
    // Reversed, so the classes come out in the order the schema declares them.
    const stack = [...level].reverse();
    for (let node = stack.pop(); node; node = stack.pop()) {
      if (seen.has(node)) continue;
      seen.add(node);
      // A mark does not end the search: a container marked whole carries every class marked inside it too.
      for (const own of ownPrivacyClasses(node)) classes.add(own);
      const def = defOf(node);
      if (def.type !== "lazy" && !STRUCTURAL.has(def.type)) {
        stack.push(...children(node).reverse());
        continue;
      }
      // Past the limit or the budget, this path ends here, and only this one. Opening a node is what may build a
      // schema — a lazy's target, an object's shape read through its getters — so it is what the budget counts.
      if (depth + 1 > MAX_RECURSION_DEPTH) {
        truncated = true;
        continue;
      }
      // Past the budget, nothing below was read, so any class may be marked there: the search assumes every one.
      if (!open) {
        truncated = true;
        unread = true;
        continue;
      }
      opened += 1;
      next.push(...children(node));
    }
    level = next;
  }
  const found = { classes, truncated, unread, opened };
  searched.set(schema, found);
  return found;
}

/** How a position is masked whole. */
export interface Mask {
  /**
   * The strongest class the position carries: its placeholder is the mask, unless `own`. Empty where a recursion that
   * reached the limit is all there is, and only there is the mask {@link TRUNCATED_MASK}.
   */
  readonly className: string;
  /** Whether the class's own mask applies: one class, from a marker, nothing opaque, and nothing cut off. */
  readonly own: boolean;
  /**
   * Every class marked at the position, in the order met, then every class a read that ran out of
   * {@link MAX_SEARCHED_SCHEMAS} assumed. Never the cutoff, which is not a class.
   */
  readonly classes: readonly string[];
  /**
   * The classes in `classes` that no read found, only assumed: a read below ran out of {@link MAX_SEARCHED_SCHEMAS},
   * so any class may be marked past it. Listed `truncated`.
   */
  readonly assumed: readonly string[];
  /**
   * Whether a recursion here reached {@link MAX_RECURSION_DEPTH}, or a read ran out of {@link MAX_SEARCHED_SCHEMAS}: a
   * flag beside the classes, never instead of them. A class known here is still the mask.
   */
  readonly truncated: boolean;
}

/** One position: every schema that reaches it, flattened through wrappers, choices, lazies and the kit's codecs. */
export interface Position {
  /**
   * Set when some value here is masked whole: every class the position masks, whatever the value's shape. What
   * `classifyPrivacy` lists.
   */
  readonly mask: Mask | undefined;
  /**
   * How an object's string key is masked when it is read here. A string key is a string whatever the key schema says,
   * a number key's included, so every mark applies to it but one that only a symbol option reaches.
   */
  readonly nameMask: Mask | undefined;
  /** Whether every value here is masked whole, whatever its shape. */
  readonly whole: boolean;
  /**
   * How a value is masked here, by its shape: a mark reached through a union option applies to a value of that
   * option's shape, and one reached through no option to every value. `undefined` where the value is walked or kept.
   */
  maskFor(value: unknown): Mask | undefined;
  /**
   * Whether a value's kind and prototype miss what the schemas here expect, and how it is masked where they do: a
   * class instance or a plain object where none of its kind is named, a `Date`, an array, a `Map` or a `Set` of a
   * subclass or with fields where an object is, an array-like instance where an array is. `undefined` where it fits:
   * a schema here names its kind and it is typical of that kind, or only an opaque node here takes its kind. A misfit
   * is never walked. Its mask is the strongest class beneath the schemas here of its kind, or beneath every schema here
   * where none names it, and `undefined`, to keep it as it is, where nothing there is marked.
   */
  misfit(value: unknown): { readonly mask: Mask | undefined } | undefined;
  /** The structural kinds here — `object`, `array`, `map` … — a value is walked by: none of a shape masked whole. */
  readonly kinds: ReadonlySet<string>;
  /** Whether anything here but a structural node may hold the value: a scalar, an opaque node. */
  readonly other: boolean;
  /** The position at an object key or a record's value. */
  field(key: PropertyKey): Position | undefined;
  /** The keys the objects here name, in order. */
  readonly keys: readonly PropertyKey[];
  /** The position at a key no object names: a catchall, a record's value. */
  readonly catchall: Position | undefined;
  /** The position a record's keys are read at. */
  readonly key: Position | undefined;
  /** The position at element `index` of an array or a tuple. */
  item(index: number): Position | undefined;
  /** How many items the longest tuple here names. */
  readonly items: number;
  /** The position at an element past every tuple item: an array's element, a tuple's rest. */
  readonly rest: Position | undefined;
  /** The positions of a map's keys and values. */
  readonly mapKey: Position | undefined;
  readonly mapValue: Position | undefined;
  /** The position of a set's elements. */
  readonly element: Position | undefined;
}

/** An id per schema, so a list of schemas has a key. */
const ids = new WeakMap<z.ZodType, number>();
let lastId = 0;
function idOf(schema: z.ZodType): number {
  let id = ids.get(schema);
  if (id === undefined) {
    lastId += 1;
    id = lastId;
    ids.set(schema, id);
  }
  return id;
}

/** Every position read, by the schemas that reach it, held weakly by the first of them. */
const positions = new WeakMap<z.ZodType, Map<string, Position>>();

/** The schema each leaf of one kind holds at a slot, read by `pick`. */
function slots(leaves: readonly z.ZodType[], kinds: readonly string[], pick: (def: Def) => unknown): z.ZodType[] {
  return leaves
    .filter((leaf) => kinds.includes(defOf(leaf).type))
    .flatMap((leaf) => [pick(defOf(leaf))].filter(isSchema));
}

/** A catchall a value's extra key is parsed by: none for a stripped object, `never` for a strict one. */
function openCatchall(def: Def): z.ZodType | undefined {
  return def.catchall && defOf(def.catchall).type !== "never" ? def.catchall : undefined;
}

/** The position `schemas` reach, read once for that list of schemas. */
export function positionOf(schemas: readonly z.ZodType[]): Position | undefined {
  const distinct = [...new Set(schemas)];
  const anchor = distinct[0];
  if (anchor === undefined) return undefined;
  const key = distinct.map(idOf).join(",");
  let row = positions.get(anchor);
  if (!row) {
    row = new Map();
    positions.set(anchor, row);
  }
  const known = row.get(key);
  if (known) return known;
  const { position, leaves, signature } = readPosition(distinct);
  // A position walked into is the same position whatever wrappers reached it: `Node` and `Node.optional()` are one,
  // so a recursion defined once comes round to the position it started at. Its masks are part of what it is.
  const first = leaves[0];
  let found = position;
  if (first !== undefined) {
    const leafKey = `${leaves.map(idOf).join(",")}${position.other ? "+" : ""}#${signature}`;
    let byLeaves = walked.get(first);
    if (!byLeaves) {
      byLeaves = new Map();
      walked.set(first, byLeaves);
    }
    found = byLeaves.get(leafKey) ?? position;
    byLeaves.set(leafKey, found);
  }
  row.set(key, found);
  return found;
}

/** Every position walked into, by its structural nodes, held weakly by the first of them. */
const walked = new WeakMap<z.ZodType, Map<string, Position>>();

/** One mark, or one opaque node's classes, at a position: and the shapes of value it applies to. */
interface Reach {
  /** The shapes of value it applies to: every shape, narrowed by each union option it was reached through. */
  readonly gate: ReadonlySet<ValueKind>;
  readonly classes: readonly string[];
  /** Whether it came from an opaque node or a recursion that ran out, rather than a marker. */
  readonly opaque: boolean;
  readonly truncated: boolean;
  /** Whether a read beneath it ran out of {@link MAX_SEARCHED_SCHEMAS}, so every class is assumed. */
  readonly unread: boolean;
}

/** The kind of value a structural node holds. */
function leafKind(leaf: z.ZodType): ValueKind {
  return SCHEMA_KINDS[defOf(leaf).type] as ValueKind;
}

/** The mask made of `reaches` and the structural nodes masked with them, or `undefined` when none applies. */
function maskOf(reaches: readonly Reach[], leaves: readonly z.ZodType[]): Mask | undefined {
  if (reaches.length === 0) return undefined;
  const searches = leaves.map(search);
  const found = new Set([
    ...reaches.flatMap((reach) => reach.classes),
    ...searches.flatMap((each) => [...each.classes]),
  ]);
  // A read that ran out of its budget never saw what lies past it: every class may be marked there.
  const unread = reaches.some((reach) => reach.unread) || searches.some((each) => each.unread);
  const assumed = unread ? unreadClasses().filter((name) => !found.has(name)) : [];
  const classes = [...found, ...assumed];
  const truncated = reaches.some((reach) => reach.truncated) || searches.some((each) => each.truncated);
  return {
    className: strongestPrivacyClass(classes) ?? "",
    own: !truncated && reaches.every((reach) => !reach.opaque) && classes.length === 1,
    classes,
    assumed,
    truncated,
  };
}

/**
 * The mask for a value of a kind or a prototype the schemas here do not expect: every class in `reaches` and beneath
 * `leaves`, as beneath an opaque node, or `undefined` where none is marked and no read there was cut off or ran out.
 */
function misfitMaskOf(reaches: readonly Reach[], leaves: readonly z.ZodType[]): Mask | undefined {
  const searches = leaves.map(search);
  const found = new Set([
    ...reaches.flatMap((reach) => reach.classes),
    ...searches.flatMap((each) => [...each.classes]),
  ]);
  const truncated = reaches.some((reach) => reach.truncated) || searches.some((each) => each.truncated);
  const unread = reaches.some((reach) => reach.unread) || searches.some((each) => each.unread);
  if (found.size === 0 && !truncated && !unread) return undefined;
  const assumed = unread ? unreadClasses().filter((name) => !found.has(name)) : [];
  const classes = [...found, ...assumed];
  return { className: strongestPrivacyClass(classes) ?? "", own: false, classes, assumed, truncated };
}

/** A mask, written out: two positions with the same leaves and the same masks are one. */
function maskKey(mask: Mask): string {
  const read = mask.truncated ? "truncated" : "read";
  return `${mask.own ? "own" : "strongest"}:${read}:${mask.classes.join("|")}:${mask.assumed.join("|")}`;
}

/** A set of shapes, written out the same way whatever order it was built in. */
function gateKey(gate: ReadonlySet<ValueKind>): string {
  return VALUE_KINDS.map((kind) => (gate.has(kind) ? "1" : "0")).join("");
}

/** Flatten a position and decide how it is masked. Its children are read when first asked for. */
function readPosition(schemas: readonly z.ZodType[]): {
  position: Position;
  leaves: readonly z.ZodType[];
  signature: string;
} {
  const reaches: Reach[] = [];
  const leaves = new Set<z.ZodType>();
  // Each schema met with the shapes it applies to, and whether as an option: a choice whose sides wrap one schema
  // reaches it once per path, and what it adds is the same each time, so it is read once.
  const met = new Set<string>();
  const lazyGates = new Set<string>();
  let other = false;
  // The kinds a scalar here names, and the kinds an opaque node here takes, whatever their prototype.
  const named = new Set<ValueKind>();
  const taken = new Set<ValueKind>();
  /** An opaque node: masked whole with every class beneath it, and kept where there is none. */
  const opaque = (node: z.ZodType, gate: ReadonlySet<ValueKind>) => {
    const own = scalarKinds(node);
    for (const kind of gate) if (!own || own.has(kind)) (own ? named : taken).add(kind);
    const inside = search(node);
    // A recursion beneath it that reached the limit counts as possibly marked: the value is masked whole.
    if (inside.classes.size > 0 || inside.truncated)
      reaches.push({
        gate,
        classes: [...inside.classes],
        opaque: true,
        truncated: inside.truncated,
        unread: inside.unread,
      });
    other = true;
  };
  // Lazies resolved by this read and by each read of an option's shapes, checked between levels, never inside one: a
  // choice of any width on one level is walked, and only how many levels of new lazies a schema builds can run it out.
  const cost = { spent: 0 };
  // What the searches beneath the lazies cut off at the budget have opened between them.
  let cutSpent = 0;
  // Each schema with the shapes of value it applies to, every shape until a union option narrows it, and whether it
  // is an option, narrowed to its own shapes when it is read. Level by level, a level for each lazy the schemas sit
  // beneath at this position, each level in the order the schema declares it, so a path that runs out ends alone.
  type Entry = [z.ZodType, ReadonlySet<ValueKind>, boolean];
  let level: Entry[] = schemas.map((schema): Entry => [schema, EVERY_KIND, false]);
  for (let lazies = 0; level.length > 0; lazies += 1) {
    const next: Entry[] = [];
    const open = cost.spent < MAX_SEARCHED_SCHEMAS;
    const stack = [...level].reverse();
    for (let entry = stack.pop(); entry; entry = stack.pop()) {
      const [node, reached, option] = entry;
      const seen = `${idOf(node)}:${gateKey(reached)}:${option ? "option" : ""}`;
      if (met.has(seen)) continue;
      met.add(seen);
      // An option applies where the value has its shape: its marks are narrowed to that shape.
      const kinds = option ? kindsOf(node, cost) : EVERY_KIND;
      const gate = option ? new Set([...reached].filter((kind) => kinds.has(kind))) : reached;
      if (gate.size === 0) continue;
      if (ownPrivacyClasses(node).length > 0) {
        // A marked container is masked whole, so every class marked inside it is a class it carries, as beneath an
        // opaque node: `pii(z.object({ token: secret(…) }))` is listed `pii` and `secret`, and masked `[secret]`.
        const inside = search(node);
        reaches.push({
          gate,
          classes: [...inside.classes],
          opaque: false,
          truncated: inside.truncated,
          unread: inside.unread,
        });
        continue;
      }
      const def = defOf(node);
      const codec = kitCodecOutput(node);
      if (makesValue(def) && holdsStructure(kindsOf(node, cost))) {
        // A fallback function or an `.overwrite()` over a structure makes a new value: opaque, as a transform is.
        opaque(node, gate);
        continue;
      }
      if (def.type === "lazy") {
        const key = `${idOf(node)}:${gateKey(gate)}`;
        if (lazyGates.has(key)) continue;
        lazyGates.add(key);
        if (lazies >= MAX_RECURSION_DEPTH || !open) {
          // A lazy nested in more lazies than the limit, or one on a level past the budget: this path is cut off, and
          // only this one. Every level above the budget's last is read whole, as nothing on it waits on another lazy.
          // Past the limit a value is cut off, and the cutoff is no class. Past the budget, the search beneath it,
          // bounded on its own, carries every class it finds, and every class where it runs out too.
          // Those searches share one budget, so a level of ten thousand cut lazies costs what one search does.
          const past = lazies >= MAX_RECURSION_DEPTH;
          const inside = past || cutSpent >= MAX_SEARCHED_SCHEMAS ? undefined : search(node);
          cutSpent += inside?.opened ?? 0;
          reaches.push({
            gate,
            classes: inside ? [...inside.classes] : [],
            opaque: true,
            truncated: true,
            unread: inside ? inside.unread : !past,
          });
          for (const kind of gate) taken.add(kind);
          other = true;
          continue;
        }
        cost.spent += 1;
        const inner = lazyInner(node);
        if (inner) next.push([inner, gate, false]);
      } else if (WRAPPERS.has(def.type) && def.innerType) {
        // A constant `.catch()` fallback is a value parse hands back here, so its kind is one the schema names.
        const fallback = constantFallback(def);
        const kind = fallback && kindOfValue(fallback.value);
        if (fallback && kind && gate.has(kind)) (isTypical(fallback.value as object, kind) ? named : taken).add(kind);
        stack.push([def.innerType, gate, false]);
      } else if (def.type === "union" && def.options) {
        for (const each of [...def.options].reverse()) stack.push([each, gate, true]);
      } else if (def.type === "intersection") {
        // A value of an intersection has both sides' shapes, so both apply wherever it does.
        for (const side of [def.right, def.left].filter(isSchema)) stack.push([side, gate, false]);
      } else if (codec) stack.push([codec, gate, false]);
      else if (STRUCTURAL.has(def.type)) {
        if (gate.has(leafKind(node))) leaves.add(node);
      } else opaque(node, gate);
    }
    level = next;
  }
  const allLeaves = [...leaves];
  const byKind = new Map<ValueKind, Mask>();
  for (const kind of VALUE_KINDS) {
    const applying = reaches.filter((reach) => reach.gate.has(kind));
    const mask = maskOf(
      applying,
      allLeaves.filter((leaf) => leafKind(leaf) === kind),
    );
    if (mask) byKind.set(kind, mask);
  }
  // A structural node of a shape that is masked is never walked: a value of that shape is masked whole.
  const leafList = allLeaves.filter((leaf) => !byKind.has(leafKind(leaf)));
  const mask = maskOf(
    reaches,
    allLeaves.filter((leaf) => byKind.has(leafKind(leaf))),
  );
  const nameMask = maskOf(
    reaches.filter((reach) => [...reach.gate].some((kind) => kind !== "symbol")),
    allLeaves.filter((leaf) => byKind.has(leafKind(leaf))),
  );
  const whole = byKind.size === VALUE_KINDS.length;
  for (const leaf of allLeaves) named.add(leafKind(leaf));
  const signature = `${[...byKind].map(([kind, each]) => `${kind}=${maskKey(each)}`).join(";")}/${gateKey(named)}/${gateKey(taken)}`;
  const memo = new Map<string, Position | undefined>();
  const once = (slot: string, read: () => readonly z.ZodType[]): Position | undefined => {
    if (!memo.has(slot)) memo.set(slot, positionOf(read()));
    return memo.get(slot);
  };
  const fields = new Map<PropertyKey, Position | undefined>();
  const objects = leafList.filter((leaf) => defOf(leaf).type === "object");
  const tuples = leafList.filter((leaf) => defOf(leaf).type === "tuple").map(defOf);
  const records = slots(leafList, ["record"], (def) => def.valueType);
  const arrays = slots(leafList, ["array"], (def) => def.element);
  const catchalls = objects.flatMap((leaf) => [openCatchall(defOf(leaf))].filter(isSchema));
  const misfits = new Map<ValueKind, { mask: Mask | undefined }>();
  const position: Position = {
    mask,
    nameMask,
    whole,
    maskFor: (value) => {
      const kind = kindOfValue(value);
      return kind === undefined ? undefined : byKind.get(kind);
    },
    misfit: (value) => {
      const kind = kindOfValue(value);
      if (kind === undefined) return undefined;
      const expected = named.has(kind);
      if (expected ? isTypical(value as object, kind) : taken.has(kind)) return undefined;
      let misfit = misfits.get(kind);
      if (!misfit) {
        // Where a schema here names its kind, the value is one of those gone wrong; where none does, it could be any.
        misfit = {
          mask: expected
            ? misfitMaskOf(
                [],
                leafList.filter((leaf) => leafKind(leaf) === kind),
              )
            : misfitMaskOf(reaches, allLeaves),
        };
        misfits.set(kind, misfit);
      }
      return misfit;
    },
    kinds: new Set(leafList.map((leaf) => defOf(leaf).type)),
    other,
    keys: [...new Set(objects.flatMap((leaf) => Reflect.ownKeys(shapeOf(leaf))))],
    field: (name) => {
      if (!fields.has(name)) {
        const named = objects.flatMap((leaf) => {
          const shape = shapeOf(leaf);
          return Object.hasOwn(shape, name) ? [shape[name] as z.ZodType] : [openCatchall(defOf(leaf))].filter(isSchema);
        });
        fields.set(name, positionOf([...named, ...records]));
      }
      return fields.get(name);
    },
    get catchall() {
      return once("catchall", () => [...catchalls, ...records]);
    },
    get key() {
      return once("key", () => slots(leafList, ["record"], (def) => def.keyType));
    },
    items: Math.max(0, ...tuples.map((def) => def.items?.length ?? 0)),
    item: (index) =>
      once(`item:${index}`, () => [
        ...arrays,
        ...tuples.flatMap((def) => [def.items?.[index] ?? def.rest].filter(isSchema)),
      ]),
    get rest() {
      return once("rest", () => [...arrays, ...tuples.flatMap((def) => [def.rest].filter(isSchema))]);
    },
    get mapKey() {
      return once("mapKey", () => slots(leafList, ["map"], (def) => def.keyType));
    },
    get mapValue() {
      return once("mapValue", () => slots(leafList, ["map"], (def) => def.valueType));
    },
    get element() {
      return once("element", () => slots(leafList, ["set"], (def) => def.valueType));
    },
  };
  return { position, leaves: leafList, signature };
}

/** The position at the root of a schema. */
export function rootPosition(schema: z.ZodType): Position {
  return positionOf([schema]) as Position;
}

/** What a walk says beside one masked path and class. */
export interface MarkNote {
  /**
   * Set where the class is assumed rather than found: a read ran out of its budget there, or the schema could not be
   * read at all, so any class may be marked below it.
   */
  readonly truncated?: true;
  /**
   * Set on a reference, once {@link MAX_LISTED_PATHS} paths are written out: the path this position was first listed
   * under. The class is marked somewhere beneath both, and the paths beneath this one are those beneath that one.
   */
  readonly sameAs?: string;
}

/**
 * What a walk reports. `marked` is called once per masked path and class. `unmarkedKey`, when given, is called for each
 * object key whose position is not masked whole, before the walk steps into it — the hook `pithy privacy scan` reads a
 * field's name through, so the scan and the inventory walk one tree the same way.
 */
export interface PrivacyVisitor {
  /** One masked path and class, with a {@link MarkNote} where the class is assumed or the path is a reference. */
  marked(path: string, className: string, note?: MarkNote): void;
  unmarkedKey?(path: string, key: string): void;
}

/** `parent.key`, or `key` at the root; an index or a bracket joins without a dot. */
function join(path: string, segment: string): string {
  return path === "" || segment.startsWith("[") ? `${path}${segment}` : `${path}.${segment}`;
}

/** One position the walk meets, at one path. */
interface Frame {
  readonly at: Position | undefined;
  readonly path: string;
  readonly depth: number;
  readonly key?: string;
  readonly parent?: Frame;
  /** The positions below, once this one is read. */
  below?: Frame[];
  /**
   * Set when the walk had read {@link MAX_CLASSIFIED_POSITIONS} distinct positions before it came to this new one, or
   * when its schema could not be read at all: nested deeper than the stack, or a getter that throws.
   */
  unread?: true;
  /** Set when {@link MAX_LISTED_PATHS} paths were written out before this one and its position was walked already. */
  sameAs?: Frame;
}

/** Whether a frame's position is one it sits below: a recursion defined once, come round. */
function onLine(frame: Frame): boolean {
  for (let above = frame.parent; above; above = above.parent) if (above.at === frame.at) return true;
  return false;
}

/**
 * A frame for the position `read` returns. A schema nested deeper than the stack can follow, or one whose getter
 * throws, cannot be read: its frame is `unread`, listed with every class, and nothing throws.
 */
function frameAt(
  read: () => Position | undefined,
  place: { path: string; depth: number; key?: string; parent?: Frame },
): Frame {
  try {
    return { ...place, at: read() };
  } catch {
    return { ...place, at: undefined, unread: true };
  }
}

/** The frames below a position that is read, in the order the schema names them. */
function framesBelow(frame: Frame, at: Position): Frame[] {
  const next = frame.depth + 1;
  const below: Frame[] = [];
  const add = (child: () => Position | undefined, path: string, depth: number, key?: string) => {
    const found = frameAt(
      child,
      key === undefined ? { path, depth, parent: frame } : { path, depth, key, parent: frame },
    );
    // A slot no schema here holds is no frame: only a position, or one that could not be read, is written out.
    if (found.at !== undefined || found.unread) below.push(found);
  };
  for (const key of at.keys) if (typeof key === "string") add(() => at.field(key), join(frame.path, key), next, key);
  add(() => at.catchall, join(frame.path, "*"), next);
  // A key is read where its object is, and never nested below it.
  add(() => at.key, join(frame.path, "<key>"), frame.depth);
  for (let index = 0; index < at.items; index += 1) add(() => at.item(index), `${frame.path}[${index}]`, next);
  add(() => at.rest, `${frame.path}[]`, next);
  add(() => at.mapKey, join(frame.path, "<key>"), next);
  add(() => at.mapValue, join(frame.path, "*"), next);
  add(() => at.element, `${frame.path}[]`, next);
  return below;
}

/** Every class a frame lists at its own path, each with whether it is only assumed. */
function ownClasses(frame: Frame): [string, boolean][] {
  const found: [string, boolean][] = [];
  const mask = frame.at?.mask;
  if (mask) for (const name of mask.classes) found.push([name, mask.assumed.includes(name)]);
  if (frame.unread) for (const name of unreadClasses()) found.push([name, true]);
  return found;
}

/**
 * Every class listed beneath each position the walk read, by the first frame that read it, and whether each is only
 * assumed. A class found anywhere beneath is found. A position beneath itself, a recursion defined once, is read until
 * nothing changes, last read first, so a chain of reused schemas settles in one pass.
 */
function classesBeneath(walked: ReadonlyMap<Position, Frame>): Map<Position, Map<string, boolean>> {
  const beneath = new Map<Position, Map<string, boolean>>();
  for (const at of walked.keys()) beneath.set(at, new Map());
  const firsts = [...walked].reverse();
  for (let changed = true; changed; ) {
    changed = false;
    for (const [at, first] of firsts) {
      const into = beneath.get(at) as Map<string, boolean>;
      const merge = (name: string, assumed: boolean) => {
        const known = into.get(name);
        if (known === undefined || (known && !assumed)) {
          into.set(name, assumed);
          changed = true;
        }
      };
      for (const child of first.below ?? []) {
        if (child.depth > MAX_RECURSION_DEPTH) continue;
        for (const [name, assumed] of ownClasses(child)) merge(name, assumed);
        const below = child.at && beneath.get(child.at);
        if (below) for (const [name, assumed] of below) merge(name, assumed);
      }
    }
  }
  return beneath;
}

/**
 * Walk a schema tree the way {@link classifyPrivacy} does, from `path`, and report to `visitor`. Exported so a second
 * reader of the tree — the CLI's scan — cannot walk it differently. A position met again below itself is a recursion
 * defined once, and is not walked again: its fields are listed once. A position nested more than
 * {@link MAX_RECURSION_DEPTH} levels deep is cut off by `redact` as {@link TRUNCATED_MASK}, which is no class, so it
 * is not listed.
 *
 * Positions are read level by level, shallowest first, and reported in the schema's own order. Each distinct position
 * counts once against {@link MAX_CLASSIFIED_POSITIONS}, wherever it sits, and only a schema that builds two new ones at
 * every level has more; the new positions left, none of them above the level the budget ran out on, are listed with
 * {@link unreadClasses}. Once {@link MAX_LISTED_PATHS} paths are written out, a position met again is a reference: its
 * path is listed with every class beneath it and the path it was first written out under, and nothing below it is
 * written out again. So the walk is linear in the schemas a tree holds, however many paths reach them. A schema that
 * cannot be read at all, nested deeper than the stack or behind a getter that throws, is listed with every class,
 * each truncated. It never throws.
 */
export function walkPrivacy(schema: z.ZodType, visitor: PrivacyVisitor, path = ""): void {
  const root = frameAt(() => rootPosition(schema), { path, depth: 0 });
  // Read, breadth first, so the budget runs out at the deepest level, never on a shallow branch.
  const queue: Frame[] = [root];
  // Each position is read once, wherever it sits, by the first frame that met it: a schema reused in many fields
  // costs the budget once.
  const walked = new Map<Position, Frame>();
  let references = false;
  for (let index = 0; index < queue.length; index += 1) {
    const frame = queue[index] as Frame;
    const { at } = frame;
    if (at === undefined || frame.depth > MAX_RECURSION_DEPTH || at.whole) continue;
    if (at.kinds.size === 0 || onLine(frame)) continue;
    const first = walked.get(at);
    if (first === undefined) {
      if (walked.size >= MAX_CLASSIFIED_POSITIONS) {
        frame.unread = true;
        continue;
      }
      walked.set(at, frame);
    } else if (queue.length >= MAX_LISTED_PATHS) {
      // Enough paths are written out: this one stands for the paths below the first, and adds none of its own.
      frame.sameAs = first;
      references = true;
      continue;
    }
    frame.below = framesBelow(frame, at);
    queue.push(...frame.below);
  }
  const beneath = references ? classesBeneath(walked) : new Map<Position, Map<string, boolean>>();
  // Report, depth first, in the order the schema names each position.
  const stack: Frame[] = [root];
  for (let frame = stack.pop(); frame; frame = stack.pop()) {
    // Past the limit a value is cut off, and the cutoff is not a class.
    if (frame.depth > MAX_RECURSION_DEPTH) continue;
    const { at } = frame;
    if (at?.mask) {
      const { assumed } = at.mask;
      for (const className of at.mask.classes)
        visitor.marked(frame.path, className, assumed.includes(className) ? { truncated: true } : undefined);
    } else if (at !== undefined && frame.key !== undefined) visitor.unmarkedKey?.(frame.path, frame.key);
    if (frame.unread)
      for (const className of unreadClasses()) visitor.marked(frame.path, className, { truncated: true });
    const reference = frame.sameAs;
    if (reference?.at) {
      for (const [className, assumed] of beneath.get(reference.at) ?? []) {
        visitor.marked(
          frame.path,
          className,
          assumed ? { truncated: true, sameAs: reference.path } : { sameAs: reference.path },
        );
      }
    }
    if (frame.below) stack.push(...[...frame.below].reverse());
  }
}

const classified = new WeakMap<z.ZodType, readonly PrivacyField[]>();

/**
 * Every position `redact` masks in a schema, and its class — the Art. 30 record for one object, derived rather than
 * maintained. Empty for a schema with no markers. A path reached twice is listed once per class. It never throws.
 */
export function classifyPrivacy(schema: z.ZodType): PrivacyField[] {
  const cached = classified.get(schema);
  if (cached) return [...cached];
  const fields: PrivacyField[] = [];
  const byKey = new Map<string, PrivacyField>();
  walkPrivacy(schema, {
    marked: (path, className, note) => {
      const key = `${path}\u0000${className}`;
      if (byKey.has(key)) return;
      const field: PrivacyField = { path, class: className };
      if (note?.truncated) field.truncated = true;
      if (note?.sameAs !== undefined) field.sameAs = note.sameAs;
      byKey.set(key, field);
      fields.push(field);
    },
  });
  classified.set(schema, fields);
  return [...fields];
}

/** Whether a schema holds a field of `className` at any depth: exactly what {@link classifyPrivacy} lists. */
export function hasPrivacy(schema: z.ZodType, className: string): boolean {
  return classifyPrivacy(schema).some((field) => field.class === className);
}
