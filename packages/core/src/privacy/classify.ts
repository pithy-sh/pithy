// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { z } from "zod";
import { type BuiltInPrivacyClass, PRIVACY_META_KEY, strongestPrivacyClass } from "./classes";

/**
 * **Reading a privacy marker off a schema, and every marker off a schema tree** (#132).
 *
 * The marker is `meta({ privacy })` on the schema a marker was handed. {@link privacyOf} reads it through the
 * wrappers that are the same field — `pii(z.string()).optional()` is `pii` — and {@link classifyPrivacy} names
 * each position of a schema that `redact` masks.
 *
 * ## The rule, shared with `redact` and `Redacted<T>`
 *
 * **Structural nodes are walked precisely.** An object — strict, stripped or loose, and its catchall — an array, a
 * record's keys and values, a tuple's items and rest, the wrappers that are the same position (`optional`, `nullable`,
 * `default`, `prefault`, `catch`, `readonly`, `nonoptional`; a brand is a type and no node), a union, a discriminated
 * union, an intersection and a lazy. At a union or an intersection a position's marks are the marks of every option
 * and every side, so no branch is chosen and none is tested.
 *
 * **Every other node is opaque**: a transform, a pipe, a preprocess, a codec — `sqliteJson` included, there is no
 * trusted list — a `z.custom` or a `z.instanceof`, `any`, `unknown`, a set, a map, a promise, a function, and any kind
 * this walk does not know. An opaque node with a mark anywhere inside it, on any side and behind any lazy, is masked
 * whole, with one placeholder naming the strongest class it carries. An opaque node with no mark inside is kept as it
 * is — unless something else at its position carries a mark, because a transform or an `unknown` beside a marked
 * object reads or holds the same value, so the position is masked whole with it. A scalar kind (a string, a number, a
 * literal, an enum, a date) holds nothing else, and never masks a position by itself. A coercion is not a scalar:
 * `z.coerce.string()` runs `String()` over the same input a marked array beside it reads, so it counts as a transform.
 * What a function returns says nothing about where a mark went, so the rule does not try.
 *
 * **A check is not a node.** `.refine()`, `.superRefine()`, `.check()` and `.overwrite()` leave the schema the kind
 * it was, so a check that writes a marked value somewhere else is not seen — here, by `redact` or by the type — and
 * neither is what a `.catch()` fallback writes into a field its schema names. Move a value with a `.transform()`,
 * which is a node.
 *
 * **Each schema is read once.** What a walk learns about a schema — the classes inside it, the position it reaches, the
 * fields it holds — is kept by the schema object itself, and {@link classifyPrivacy}, {@link hasPrivacy},
 * {@link walkPrivacy} and `redact` all read that one record, so they cannot disagree about a position. A part many
 * fields share, or a DAG that doubles at every level, is read once and costs once. A lazy is read through Zod's own
 * cached target, the schema `parse` ran, never by calling its getter again, and an object through the shape Zod froze
 * on first read. A recursive schema built once is a cycle in that record: `classifyPrivacy` lists its fields once, and
 * `redact` follows a value down it level by level.
 *
 * **The one limit is recursion, and past it a walk fails closed.** No count of nodes, fields or paths bounds a walk,
 * so a schema with no recursion in it is read to the end at any size. What is bounded is how many recursion steps one
 * path takes, at {@link MAX_RECURSION_DEPTH}: each `z.lazy` resolved, each object whose getters build its fields when
 * it is first read, and each level of a value that comes round to a schema it is already inside. A factory that
 * builds a new schema at every level never comes round to one it has read, so it reaches the limit, and so does a
 * value nested that deep under a recursive schema built once. Past it the position is taken to carry the strongest
 * class, {@link TRUNCATED_CLASS}: `redact` masks it whole as `[secret]`, and `classifyPrivacy` lists it with
 * `truncated: true` — the way `Redacted<T>` types a position past its own depth as `unknown`. Once one recursion has
 * run out, every position in the rest of it that would take another recursion step is listed closed rather than read,
 * because a factory that builds two lazies at every level has 2^256 paths inside the limit. A field outside it, a
 * field with a mark of its own, and a field with no recursion step anywhere below it are read as they are. What one
 * schema reads as never turns on which schema was read before it: a shape is filed by whether it was read inside a
 * recursion that ran out, and one whose read reached the limit by the depth it was read at. Build a recursive schema
 * once and refer to it by name, and nothing it holds ever reaches the limit.
 *
 * ## What a path looks like
 *
 * Object keys join with `.`, an array element is `[]`, a tuple position is `[i]`, a record's value and an object's
 * catchall are `*`, and a record's key is `<key>`: `address.line1`, `devices[].token`, `pair[1]`, `notes.*`,
 * `byEmail.<key>`. A marked root is the empty path. An opaque position with a mark inside is listed at its own path,
 * once per class it carries, and nothing below it is: `profile` for `sqliteJson(Profile)`, not `profile.phone`.
 */

/** One marked path in a schema, and its class. The per-field record the inventory is built from. */
export interface PrivacyField {
  /** Where in the value the field sits: `email`, `address.line1`, `devices[].token`, or `""` for the root. */
  path: string;
  /** The class it was marked with. */
  class: string;
  /**
   * Set when the walk ran out of recursion here ({@link MAX_RECURSION_DEPTH}) and assumed a mark of
   * {@link TRUNCATED_CLASS} rather than read further: a factory-built recursive schema, or a chain of lazies that
   * long. `redact` masks the position whole. Absent everywhere the schema was read to the end.
   */
  truncated?: true;
}

/** A Zod schema's internal definition, as much of it as the rule reads. */
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
  coerce?: boolean;
}

/** The definition behind a schema: the one its own `parse` reads. */
function defOf(schema: z.ZodType): Def {
  return (schema as unknown as { _zod: { def: Def } })._zod.def;
}

/** Whether reading an object's shape ran a getter, by object. Known only before the first read, so kept from it. */
const minted = new WeakMap<z.ZodType, boolean>();

/**
 * Whether the shape an object has not yet frozen holds a getter. Zod keeps the shape as written behind the accessor
 * until the first read, and a getter that returns a new schema each time is a factory: one recursion step.
 */
function holdsGetter(def: Def): boolean {
  const accessor = Object.getOwnPropertyDescriptor(def, "shape")?.get as { raw?: unknown } | undefined;
  const raw = accessor?.raw;
  if (typeof raw !== "object" || raw === null) return false;
  return Object.values(Object.getOwnPropertyDescriptors(raw)).some((field) => field.get !== undefined);
}

/**
 * An object's fields: its definition's shape, which Zod freezes on first read, so a getter in it runs once and every
 * later read — `parse`'s and this walk's — sees the same schemas. Every read of a shape goes through here, so whether
 * it held a getter is noted before the first.
 */
function shapeOf(schema: z.ZodType): Record<PropertyKey, z.ZodType> {
  const def = defOf(schema);
  if (!minted.has(schema)) minted.set(schema, holdsGetter(def));
  return def.shape ?? {};
}

/** How many recursion steps lie between a node and what it holds: one for a lazy and for an object built by getters. */
function stepInto(schema: z.ZodType): number {
  const def = defOf(schema);
  if (def.type === "lazy") return 1;
  if (def.type !== "object") return 0;
  shapeOf(schema);
  return minted.get(schema) === true ? 1 : 0;
}

/** Wrappers that are the same position as what they wrap: a marker inside one is the position's marker. */
const WRAPPERS: ReadonlySet<string> = new Set([
  "optional",
  "nullable",
  "default",
  "prefault",
  "readonly",
  "catch",
  "nonoptional",
]);

/** The kinds a position is walked into. Every kind that is neither one of these nor a wrapper, a union, an intersection or a lazy is opaque. */
const STRUCTURAL: ReadonlySet<string> = new Set(["object", "array", "record", "tuple"]);

/**
 * The opaque kinds that only ever hold a scalar. Any other opaque node with no mark inside may hand back an object or
 * an array with keys and elements no schema at its position names.
 */
const SCALARS: ReadonlySet<string> = new Set([
  "string",
  "number",
  "bigint",
  "boolean",
  "date",
  "symbol",
  "undefined",
  "null",
  "void",
  "never",
  "nan",
  "literal",
  "enum",
  "template_literal",
]);

/**
 * How many recursion steps one path takes before the walk stops and fails closed: each lazy resolved, each object
 * whose getters build its fields, and each level of a value that comes round to a schema it is already inside. Far
 * past any recursion a value holds, and short of a stack overflow. It is the only limit: no count of nodes bounds a
 * walk.
 */
export const MAX_RECURSION_DEPTH = 256;

/**
 * The class a walk assumes where it ran out of recursion: the strongest there is, because what lies past the limit
 * was not read. `redact` masks such a position as `[secret]`.
 */
export const TRUNCATED_CLASS: BuiltInPrivacyClass = "secret";

/** Whether a node only ever holds a scalar: a scalar kind that does not coerce its input. */
function isScalar(def: Def): boolean {
  return SCALARS.has(def.type) && def.coerce !== true;
}

/** The `privacy` meta on this exact schema, or `null`. */
function ownMarker(schema: z.ZodType): string | null {
  const meta = schema.meta() as Record<string, unknown> | undefined;
  const value = meta?.[PRIVACY_META_KEY];
  return typeof value === "string" ? value : null;
}

/**
 * The class a field was marked with, read through its wrappers — `pii(z.string()).optional()` is `pii` — or
 * `null` when nothing along the chain carries one.
 */
export function privacyOf(schema: z.ZodType): string | null {
  for (let node: z.ZodType | undefined = schema; node; ) {
    const found = ownMarker(node);
    if (found !== null) return found;
    const def = defOf(node);
    node = WRAPPERS.has(def.type) ? def.innerType : undefined;
  }
  return null;
}

/**
 * What a lazy stands for: Zod's own cached target, the schema `parse` ran. Never the getter called again, which may
 * return a different schema from the one that parsed the value.
 */
function lazyInner(schema: z.ZodType): z.ZodType | undefined {
  const inner = (schema as unknown as { _zod: { innerType?: unknown } })._zod.innerType;
  return isSchema(inner) ? inner : undefined;
}

/** Whether a value is a Zod schema. */
function isSchema(value: unknown): value is z.ZodType {
  return typeof value === "object" && value !== null && "_zod" in value && "def" in value;
}

/** Every schema a node holds, whatever its kind: what an opaque node is searched for a mark through. */
function children(schema: z.ZodType): z.ZodType[] {
  const def = defOf(schema);
  if (def.type === "lazy") {
    const inner = lazyInner(schema);
    return inner ? [inner] : [];
  }
  const found: z.ZodType[] = [];
  // Read first, through `shapeOf`: listing the definition below reads the shape too, and freezes it.
  if (def.type === "object") {
    const shape = shapeOf(schema);
    for (const key of Reflect.ownKeys(shape)) if (isSchema(shape[key])) found.push(shape[key]);
  }
  for (const [key, slot] of Object.entries(def)) {
    // A check is not a node, and holds no schema a value is parsed by. A lazy's getter is read above, through its cache.
    if (key === "checks" || key === "getter") continue;
    if (key === "shape" && def.type === "object") continue;
    if (isSchema(slot)) found.push(slot);
    else if (Array.isArray(slot)) found.push(...slot.filter(isSchema));
    else if (key === "shape" && typeof slot === "object" && slot !== null)
      found.push(...Object.values(slot).filter(isSchema));
  }
  return found;
}

/** Every key a schema-set memo is filed under: an id per schema, assigned the first time a walk meets it. */
const ids = new WeakMap<z.ZodType, number>();
let lastId = 0;

/** A schema's id. */
function idOf(schema: z.ZodType): number {
  let id = ids.get(schema);
  if (id === undefined) {
    lastId += 1;
    id = lastId;
    ids.set(schema, id);
  }
  return id;
}

/** A memo of what a list of schemas reads as, held weakly by the first of them. */
type Memo<T> = WeakMap<z.ZodType, Map<string, T>>;

/** The slot for `schemas` in `memo`: what it holds, and how to fill it. */
function slot<T>(memo: Memo<T>, schemas: readonly z.ZodType[]): { found: T | undefined; fill(value: T): void } {
  const anchor = schemas[0] as z.ZodType;
  const key = schemas.map(idOf).join(",");
  let row = memo.get(anchor);
  if (!row) {
    row = new Map();
    memo.set(anchor, row);
  }
  const filed = row;
  return { found: filed.get(key), fill: (value) => filed.set(key, value) };
}

/** The same schemas, each once, in the order first met. */
function distinctSchemas(schemas: readonly z.ZodType[]): z.ZodType[] {
  return [...new Set(schemas)];
}

/** What {@link marksIn} found inside a schema, and whether it ran out of recursion first. */
interface Search {
  readonly classes: ReadonlySet<string>;
  readonly truncated: boolean;
}

/** {@link marksIn}, by schema. A schema is immutable, so its answer never changes. */
const searched = new WeakMap<z.ZodType, Search>();

/**
 * Every class marked anywhere in a schema: on it, on every side of every pipe and codec, in every option, behind
 * every lazy, in a set's elements, a map's keys and a function's arguments. What decides an opaque node. Each node is
 * read once, and a schema already searched is not searched again. A path more than {@link MAX_RECURSION_DEPTH}
 * recursion steps long stops the search there with {@link TRUNCATED_CLASS} added, so it fails closed, and the search
 * ends: what it would read past the cut could only add a class weaker than the one it now carries.
 */
function marksIn(schema: z.ZodType): Search {
  const known = searched.get(schema);
  if (known) return known;
  const found = new Set<string>();
  let truncated = false;
  const seen = new Set<z.ZodType>();
  const stack: [z.ZodType, number][] = [[schema, 0]];
  for (let entry = stack.pop(); entry; entry = stack.pop()) {
    const [node, depth] = entry;
    if (seen.has(node)) continue;
    seen.add(node);
    const done = node === schema ? undefined : searched.get(node);
    if (done) {
      for (const className of done.classes) found.add(className);
      if (done.truncated) truncated = true;
      if (truncated) break;
      continue;
    }
    const own = ownMarker(node);
    if (own !== null) {
      found.add(own);
      continue;
    }
    const inside = children(node);
    const next = depth + stepInto(node);
    if (next > MAX_RECURSION_DEPTH && inside.length > 0) {
      truncated = true;
      break;
    }
    // Reversed, so the classes come out in the order the schema declares them.
    stack.push(...inside.map((child): [z.ZodType, number] => [child, next]).reverse());
  }
  if (truncated) found.add(TRUNCATED_CLASS);
  const result: Search = { classes: found, truncated };
  searched.set(schema, result);
  return result;
}

/**
 * **One position, as the rule reads it**: every schema that reaches it, flattened through the wrappers, the options of
 * a union, the sides of an intersection and each lazy.
 */
export interface Position {
  /** The classes a marked node at this position carries. */
  readonly marks: ReadonlySet<string>;
  /** The classes an opaque node at this position carries anywhere inside it. */
  readonly opaque: ReadonlySet<string>;
  /** The structural nodes at this position: objects, arrays, records and tuples. */
  readonly leaves: readonly z.ZodType[];
  /** How many lazies deep the position resolved, along its deepest chain of them: its recursion steps. */
  readonly depth: number;
  /**
   * Whether an opaque node with no mark inside, and not a scalar, sits here: a transform or an `unknown`, which may
   * hold whatever the rest of the position marks.
   */
  readonly free: boolean;
  /** The opaque nodes with no mark inside, which `pithy privacy scan` still reads field names through. */
  readonly unmarked: readonly z.ZodType[];
  /** The scalar kinds at this position: a value of one of them is held by a scalar, and kept. */
  readonly scalars: ReadonlySet<string>;
  /**
   * Whether the walk ran out of recursion here — a chain of lazies past {@link MAX_RECURSION_DEPTH}, or a search of an
   * opaque node's insides that was cut short — so the position is taken to carry {@link TRUNCATED_CLASS}, and masked
   * whole.
   */
  readonly truncated: boolean;
}

/** {@link position}, by the schemas that reach it. */
const positions: Memo<Position> = new WeakMap();

/** The position `schemas` reach. A lazy met again at the same position is not followed again. */
function position(schemas: readonly z.ZodType[]): Position {
  const memo = slot(positions, schemas);
  if (memo.found) return memo.found;
  const marks = new Set<string>();
  const opaque = new Set<string>();
  const leaves = new Set<z.ZodType>();
  const lazies = new Set<z.ZodType>();
  let depth = 0;
  let free = false;
  const unmarked: z.ZodType[] = [];
  const scalars = new Set<string>();
  let truncated = false;
  const stack = schemas.map((schema): [z.ZodType, number] => [schema, 0]).reverse();
  for (let entry = stack.pop(); entry; entry = stack.pop()) {
    const [node, steps] = entry;
    const own = ownMarker(node);
    if (own !== null) {
      marks.add(own);
      continue;
    }
    const def = defOf(node);
    if (WRAPPERS.has(def.type)) {
      if (def.innerType) stack.push([def.innerType, steps]);
    } else if (def.type === "union")
      stack.push(...[...(def.options ?? [])].reverse().map((option): [z.ZodType, number] => [option, steps]));
    else if (def.type === "intersection")
      stack.push(...[def.right, def.left].filter(isSchema).map((side): [z.ZodType, number] => [side, steps]));
    else if (def.type === "lazy") {
      // The lazy itself is the guard, never a wrapper built around it: a getter that reaches it again stops here.
      if (lazies.has(node)) continue;
      // A lazy whose getter returns a new lazy, at every level, would never reach anything else: stop, closed. The
      // position is masked whole, so nothing more it could reach would change it.
      if (steps + 1 > MAX_RECURSION_DEPTH) {
        truncated = true;
        break;
      }
      lazies.add(node);
      depth = Math.max(depth, steps + 1);
      const inner = lazyInner(node);
      if (inner) stack.push([inner, steps + 1]);
    } else if (STRUCTURAL.has(def.type)) leaves.add(node);
    else {
      const inside = marksIn(node);
      for (const className of inside.classes) opaque.add(className);
      if (inside.truncated) truncated = true;
      if (inside.classes.size === 0 && isScalar(def)) scalars.add(def.type);
      else if (inside.classes.size === 0) {
        free = true;
        unmarked.push(node);
      }
    }
  }
  if (truncated) opaque.add(TRUNCATED_CLASS);
  const found: Position = { marks, opaque, leaves: [...leaves], depth, free, unmarked, scalars, truncated };
  memo.fill(found);
  return found;
}

/** Every class a position carries, on it or anywhere below it. */
function carriedClasses(at: Position): string[] {
  return [...new Set([...at.marks, ...at.opaque, ...at.leaves.flatMap((leaf) => [...marksIn(leaf).classes])])];
}

/** Whether anything a position carries was assumed rather than read, because a search ran out of recursion. */
function carriedTruncated(at: Position): boolean {
  return at.truncated || at.leaves.some((leaf) => marksIn(leaf).truncated);
}

/** How a position is masked whole: the strongest class, whether as its placeholder, every class, and whether assumed. */
export interface WholeMask {
  readonly className: string;
  readonly placeholder: boolean;
  readonly classes: readonly string[];
  readonly truncated: boolean;
}

/** {@link wholeMask}, by position. */
const wholes = new WeakMap<Position, WholeMask | null>();

/**
 * How a position is masked whole, or `undefined` when it is walked into. A marked node masks it with its class's own
 * mask where that class is the only one at the position; two classes mask it with the placeholder of the strongest,
 * because one class's own mask — a PAN's first six and last four — is no mask for another's value. An opaque node with
 * a mark inside masks it with the `[class]` placeholder, and so does an opaque node with no mark inside where anything
 * else at the position carries one: a transform or an `unknown` beside a marked object reads, or holds, the same
 * value. `classes` are every class the mask stands for; `className` is the strongest. `truncated` says the walk ran
 * out of recursion and assumed {@link TRUNCATED_CLASS} among them.
 */
function wholeMask(at: Position): WholeMask | undefined {
  const known = wholes.get(at);
  if (known !== undefined) return known ?? undefined;
  const own = [...new Set([...at.marks, ...at.opaque])];
  const fromCarried = own.length === 0 && at.free;
  const classes = fromCarried ? carriedClasses(at) : own;
  const className = strongestPrivacyClass(classes);
  const found =
    className === undefined
      ? undefined
      : {
          className,
          placeholder: at.opaque.size > 0 || at.marks.size !== 1,
          classes,
          truncated: fromCarried ? carriedTruncated(at) : at.truncated,
        };
  wholes.set(at, found ?? null);
  return found;
}

/** The strongest class a position carries, on it or below it: what masks a key or an element no schema names. */
export function carried(at: Position): string | undefined {
  return strongestPrivacyClass(carriedClasses(at));
}

/** Whether a schema is `z.never()`, the catchall a strict object refuses an extra key with. */
function isNever(schema: z.ZodType | undefined): boolean {
  return schema === undefined || defOf(schema).type === "never";
}

/** The schemas at an object key `key`: each object's field or catchall, and each record's value. */
function fieldSchemas(leaves: readonly z.ZodType[], key: PropertyKey): z.ZodType[] {
  const found: z.ZodType[] = [];
  for (const leaf of leaves) {
    const def = defOf(leaf);
    if (def.type === "object") {
      const shape = shapeOf(leaf);
      if (Object.hasOwn(shape, key)) found.push(shape[key] as z.ZodType);
      else if (!isNever(def.catchall)) found.push(def.catchall as z.ZodType);
    } else if (def.type === "record" && def.valueType) found.push(def.valueType);
  }
  return found;
}

/** The schemas at a key no object names: each object's catchall and each record's value. */
function catchallSchemas(leaves: readonly z.ZodType[]): z.ZodType[] {
  const found: z.ZodType[] = [];
  for (const leaf of leaves) {
    const def = defOf(leaf);
    if (def.type === "object" && !isNever(def.catchall)) found.push(def.catchall as z.ZodType);
    else if (def.type === "record" && def.valueType) found.push(def.valueType);
  }
  return found;
}

/** The keys any object at the position names, string and symbol alike, in order. */
function namedKeys(leaves: readonly z.ZodType[]): PropertyKey[] {
  const keys = new Set<PropertyKey>();
  for (const leaf of leaves)
    if (defOf(leaf).type === "object") for (const key of Reflect.ownKeys(shapeOf(leaf))) keys.add(key);
  return [...keys];
}

/** The schemas a record's keys are parsed by: every record at the position. */
function keySchemas(leaves: readonly z.ZodType[]): z.ZodType[] {
  return leaves.flatMap((leaf) => {
    const def = defOf(leaf);
    return def.type === "record" && def.keyType ? [def.keyType] : [];
  });
}

/** The schemas at element `index`: each array's element, and each tuple's item there or its rest. */
function elementSchemas(leaves: readonly z.ZodType[], index: number): z.ZodType[] {
  const found: z.ZodType[] = [];
  for (const leaf of leaves) {
    const def = defOf(leaf);
    if (def.type === "array" && def.element) found.push(def.element);
    else if (def.type === "tuple") {
      const item = def.items?.[index] ?? def.rest ?? undefined;
      if (item) found.push(item);
    }
  }
  return found;
}

/** The schemas at an element past every tuple's items: each array's element and each tuple's rest. */
function restSchemas(leaves: readonly z.ZodType[]): z.ZodType[] {
  const found: z.ZodType[] = [];
  for (const leaf of leaves) {
    const def = defOf(leaf);
    if (def.type === "array" && def.element) found.push(def.element);
    else if (def.type === "tuple" && def.rest) found.push(def.rest);
  }
  return found;
}

/** Whether a leaf is one of `kinds`. */
export function leafIs(leaf: z.ZodType, ...kinds: string[]): boolean {
  return kinds.includes(defOf(leaf).type);
}

/**
 * **What every walk reads at one position**: the position, how it is masked whole, and — where it is not — the
 * structural nodes it holds. `redact`, `classifyPrivacy`, `hasPrivacy` and `walkPrivacy` all read this one record.
 */
export interface Site {
  readonly at: Position;
  readonly whole: WholeMask | undefined;
  readonly shape: Shape | undefined;
}

/**
 * The structural nodes at a position, read once by the schemas themselves, and the site below each key, element and
 * catchall. A recursive schema built once reaches its own shape again, so the record is a cycle wherever the schema is.
 */
export interface Shape {
  readonly leaves: readonly z.ZodType[];
  /** The site at each key an object names, string or symbol, in order. */
  readonly fields: ReadonlyMap<PropertyKey, Site>;
  /** The site at a key no object names: a catchall, a loose object's rest, a record's value. */
  readonly catchall: Site | undefined;
  /** The site a record's keys are read at. */
  readonly key: Site | undefined;
  /** The site at each tuple position. */
  readonly items: readonly (Site | undefined)[];
  /** The site at an element past every tuple position: an array's element, a tuple's rest. */
  readonly rest: Site | undefined;
}

/** A shape while its sites are read. */
type Building = { -readonly [K in keyof Shape]: Shape[K] } & {
  fields: Map<PropertyKey, Site>;
  items: (Site | undefined)[];
};

/** Where a recursion ran out: read no further, listed and masked as {@link TRUNCATED_CLASS}. */
const CUT: Site = {
  at: {
    marks: new Set(),
    opaque: new Set([TRUNCATED_CLASS]),
    leaves: [],
    depth: 0,
    free: false,
    unmarked: [],
    scalars: new Set(),
    truncated: true,
  },
  whole: { className: TRUNCATED_CLASS, placeholder: true, classes: [TRUNCATED_CLASS], truncated: true },
  shape: undefined,
};

/**
 * How a shape is read, which is part of what it is filed under: `open` where no recursion has run out, and `closed`
 * inside one that has, where every position that would take another recursion step is listed closed. Outside every
 * recursion a read is always open, because a cut in one field there is no reason to close the next.
 */
type Mode = "open" | "closed";

/**
 * What one set of structural nodes, read one way, has read as. A shape whose read never reached the recursion limit
 * reads the same at any depth that keeps it inside the limit, so it is kept once, with how many recursion steps below
 * it the read went. A shape whose read did reach the limit cut a path at a depth of its own, and outside every
 * recursion opened each field after the cut again, so it is kept by the depth it was read at.
 */
interface Filed {
  clean: { shape: Shape; reach: number } | undefined;
  readonly byDepth: Map<number, Shape>;
}

/** Every shape read, by its structural nodes and how it was read. */
const shapes: Record<Mode, Memo<Filed>> = { open: new WeakMap(), closed: new WeakMap() };

/**
 * A shape while it is read. `low` is the oldest shape still being read that this one closed a cycle to, and `members`
 * the shapes read inside it that closed one to it: their record holds a shape whose depth is settled only when it is.
 */
interface Frame {
  readonly shape: Shape;
  readonly filed: Filed;
  readonly depth: number;
  low: number;
  readonly members: Frame[];
}

/** The shapes being read, outermost first, and where each is on that line. */
const reading: Frame[] = [];
const readingAt = new Map<Filed, number>();

/**
 * Set where a recursion ran out, and cleared once the read is back outside every recursion: until then, a position it
 * would walk into and that holds a recursion step below it is listed closed rather than read. A factory that builds
 * two lazies at every level would otherwise read 2^256 shapes.
 */
let cutting = false;

/** The most recursion steps any check in the current read has reached: past the limit, the read cut a path. */
let deepest = 0;

/** Whether a structural walk from a schema takes a recursion step: a lazy, or an object whose getters build its fields. */
const recursive = new WeakMap<z.ZodType, boolean>();

/** The schemas a shape read walks into from a node: through wrappers, options, sides and structural slots. */
function walkedInto(schema: z.ZodType): z.ZodType[] {
  const def = defOf(schema);
  if (WRAPPERS.has(def.type)) return def.innerType ? [def.innerType] : [];
  if (def.type === "union") return [...(def.options ?? [])];
  if (def.type === "intersection") return [def.left, def.right].filter(isSchema);
  if (def.type === "object") {
    const shape = shapeOf(schema);
    const fields = Reflect.ownKeys(shape).map((key) => shape[key]);
    return [...fields, isNever(def.catchall) ? undefined : def.catchall].filter(isSchema);
  }
  if (def.type === "array") return def.element ? [def.element] : [];
  if (def.type === "record") return [def.keyType, def.valueType].filter(isSchema);
  if (def.type === "tuple") return [...(def.items ?? []), def.rest ?? undefined].filter(isSchema);
  return [];
}

/**
 * Whether reading a schema's shape takes a recursion step anywhere below it. A marked node is masked whole and an
 * opaque one is not walked into, so neither counts. Without a step the walk is finite, so it is read to the end even
 * where a recursion beside it ran out: closing it would mask a value nothing below it marks or cuts.
 */
function holdsRecursion(schema: z.ZodType): boolean {
  const known = recursive.get(schema);
  if (known !== undefined) return known;
  const seen = new Set<z.ZodType>();
  const stack = [schema];
  let found = false;
  for (let node = stack.pop(); node; node = stack.pop()) {
    if (seen.has(node)) continue;
    seen.add(node);
    const done = node === schema ? undefined : recursive.get(node);
    if (done === false) continue;
    if (done === true || (ownMarker(node) === null && stepInto(node) > 0)) {
      found = true;
      break;
    }
    if (ownMarker(node) === null) stack.push(...walkedInto(node));
  }
  // With no step found, nothing reachable from any node read takes one either.
  if (!found) for (const node of seen) recursive.set(node, false);
  recursive.set(schema, found);
  return found;
}

/** The site `schemas` reach, `depth` recursion steps down. */
function siteAt(schemas: readonly z.ZodType[], depth: number): Site | undefined {
  if (schemas.length === 0) return undefined;
  const at = position(distinctSchemas(schemas));
  const below = depth + at.depth;
  deepest = Math.max(deepest, below);
  if (below > MAX_RECURSION_DEPTH) {
    cutting = true;
    return CUT;
  }
  const whole = wholeMask(at);
  if (whole || at.leaves.length === 0) return { at, whole, shape: undefined };
  if (cutting && below > 0 && at.leaves.some(holdsRecursion)) return CUT;
  return { at, whole: undefined, shape: shapeAt(at.leaves, below) };
}

/** Forget a shape kept for one read only: it closed a cycle to a shape whose read reached the limit. */
function unfile(frame: Frame): void {
  if (frame.filed.clean?.shape === frame.shape) frame.filed.clean = undefined;
  if (frame.filed.byDepth.get(frame.depth) === frame.shape) frame.filed.byDepth.delete(frame.depth);
}

/**
 * The shape of `leaves`, read once for each way it is read: a shape met again while it is still being read is the
 * cycle closing. What a later read is handed is what it would have read itself, whichever schema was read first.
 */
function shapeAt(leaves: readonly z.ZodType[], depth: number): Shape {
  // Outside every recursion `cutting` is always clear here: each field there clears it before it is read.
  const mode: Mode = cutting ? "closed" : "open";
  const memo = slot(shapes[mode], leaves);
  const filed = memo.found ?? { clean: undefined, byDepth: new Map<number, Shape>() };
  if (!memo.found) memo.fill(filed);
  const open = readingAt.get(filed);
  if (open !== undefined) {
    // Every shape read since this one depends on it, and is settled when it is.
    for (let index = open + 1; index < reading.length; index += 1)
      (reading[index] as Frame).low = Math.min((reading[index] as Frame).low, open);
    return (reading[open] as Frame).shape;
  }
  const clean = filed.clean;
  if (clean && depth + clean.reach <= MAX_RECURSION_DEPTH) {
    deepest = Math.max(deepest, depth + clean.reach);
    return clean.shape;
  }
  const known = filed.byDepth.get(depth);
  if (known) {
    // It ran out here when it was read, so it runs out here now.
    cutting = true;
    deepest = Math.max(deepest, MAX_RECURSION_DEPTH + 1);
    return known;
  }
  const shape: Building = {
    leaves,
    fields: new Map(),
    catchall: undefined,
    key: undefined,
    items: [],
    rest: undefined,
  };
  const frame: Frame = { shape, filed, depth, low: reading.length, members: [] };
  const outer = deepest;
  deepest = depth;
  readingAt.set(filed, reading.length);
  reading.push(frame);
  const next = depth + Math.max(0, ...leaves.map(stepInto));
  const read = (schemas: readonly z.ZodType[]): Site | undefined => {
    // Outside every recursion, a cut in one field is no reason to close the next.
    if (depth === 0) cutting = false;
    return siteAt(schemas, next);
  };
  for (const key of namedKeys(leaves)) {
    const field = read(fieldSchemas(leaves, key));
    if (field) shape.fields.set(key, field);
  }
  shape.catchall = read(catchallSchemas(leaves));
  shape.key = read(keySchemas(leaves));
  const items = Math.max(0, ...leaves.map((leaf) => (leafIs(leaf, "tuple") ? (defOf(leaf).items?.length ?? 0) : 0)));
  for (let index = 0; index < items; index += 1) shape.items.push(read(elementSchemas(leaves, index)));
  shape.rest = read(restSchemas(leaves));
  reading.pop();
  readingAt.delete(filed);
  const ranOut = deepest > MAX_RECURSION_DEPTH;
  if (ranOut) filed.byDepth.set(depth, shape);
  else filed.clean = { shape, reach: deepest - depth };
  if (frame.low < reading.length) {
    // Part of a cycle through a shape still being read: kept for the rest of that read, and settled with it.
    (reading[frame.low] as Frame).members.push(frame, ...frame.members);
  } else {
    for (const member of frame.members) {
      if (ranOut) unfile(member);
      // A member reused elsewhere reaches this shape again, as deep below it as this read went.
      else if (member.filed.clean?.shape === member.shape)
        member.filed.clean = { shape: member.shape, reach: deepest - member.depth };
    }
  }
  deepest = Math.max(outer, deepest);
  return shape;
}

/** Every schema's site as a root, read once. */
const roots = new WeakMap<z.ZodType, Site>();

/** The site at the root of `schema`: the one record every walk of it reads. */
export function siteOf(schema: z.ZodType): Site {
  const known = roots.get(schema);
  if (known) return known;
  cutting = false;
  deepest = 0;
  const found = siteAt([schema], 0) as Site;
  cutting = false;
  roots.set(schema, found);
  return found;
}

/** The site inside a position's opaque nodes with no mark inside, by those nodes: the scan reads names through it. */
const insides: Memo<Site | null> = new WeakMap();

/**
 * What the opaque nodes with no mark inside hold, read as one position — a JSON column's object, a transform's input.
 * `redact` keeps such a node whole, but `pithy privacy scan` reads the names inside it. Its search ended with no mark
 * and no cut, so it is read to the end.
 */
function insideOf(site: Site): Site | undefined {
  const { unmarked } = site.at;
  if (unmarked.length === 0) return undefined;
  const memo = slot(insides, unmarked);
  if (memo.found !== undefined) return memo.found ?? undefined;
  memo.fill(null);
  const outer = { cutting, deepest };
  cutting = false;
  const found = siteAt(unmarked.flatMap(children), 0);
  ({ cutting, deepest } = outer);
  memo.fill(found ?? null);
  return found;
}

/** `parent.key`, or `key` at the root. */
function join(path: string, key: string): string {
  return path === "" ? key : `${path}.${key}`;
}

/**
 * What a walk reports. `marked` is called once per masked path and class. `unmarkedKey`, when given, is called for each
 * object key whose position is not masked whole, before the walk steps into it — the hook `pithy privacy scan` reads a
 * field's name through, so the scan and the inventory walk one tree the same way.
 */
export interface PrivacyVisitor {
  /** One masked path and class; `truncated` when the walk ran out of recursion there and assumed the class. */
  marked(path: string, className: string, truncated?: boolean): void;
  unmarkedKey?(path: string, key: string): void;
}

/**
 * Walk one site. `line` holds the shapes and insides the path is already inside, so a recursive schema is listed once:
 * a shape met again below itself is not walked again, and a shape a sibling reuses is walked there in full.
 */
function walkSite(site: Site | undefined, path: string, visitor: PrivacyVisitor, line: Set<object>): void {
  if (site === undefined) return;
  const { whole, shape } = site;
  if (whole) {
    for (const className of whole.classes)
      visitor.marked(path, className, whole.truncated && className === TRUNCATED_CLASS);
    return;
  }
  // An opaque node with no mark inside is kept by `redact` and lists nothing, but the scan still reads the names of
  // the fields inside it — a JSON column's, a transform's input — because marking one is how the node gets masked.
  if (visitor.unmarkedKey) {
    const inside = insideOf(site);
    if (inside && !line.has(inside)) {
      line.add(inside);
      walkSite(inside, path, visitor, line);
      line.delete(inside);
    }
  }
  if (shape === undefined || line.has(shape)) return;
  line.add(shape);
  for (const [key, field] of shape.fields) {
    if (typeof key !== "string") continue;
    const fieldPath = join(path, key);
    if (!field.whole) visitor.unmarkedKey?.(fieldPath, key);
    walkSite(field, fieldPath, visitor, line);
  }
  walkSite(shape.catchall, join(path, "*"), visitor, line);
  walkSite(shape.key, join(path, "<key>"), visitor, line);
  for (const [index, item] of shape.items.entries()) walkSite(item, `${path}[${index}]`, visitor, line);
  walkSite(shape.rest, `${path}[]`, visitor, line);
  line.delete(shape);
}

/**
 * Walk a schema tree the way {@link classifyPrivacy} does, from `path`, and report to `visitor`. Exported so a
 * second reader of the tree — the CLI's scan — cannot walk it differently.
 */
export function walkPrivacy(schema: z.ZodType, visitor: PrivacyVisitor, path = ""): void {
  walkSite(siteOf(schema), path, visitor, new Set());
}

/** Classifications already computed, by schema. A schema is immutable, so its answer never changes. */
const classified = new WeakMap<z.ZodType, readonly PrivacyField[]>();

/**
 * Every position `redact` masks in a schema, and its class, in one pass — the Art. 30 record for one object, derived
 * rather than maintained. Empty for a schema with no markers. A path reached twice (two union options naming the same
 * field) is listed once per class. It never throws: a position past {@link MAX_RECURSION_DEPTH} is listed as
 * {@link TRUNCATED_CLASS} with `truncated: true`.
 */
export function classifyPrivacy(schema: z.ZodType): PrivacyField[] {
  const cached = classified.get(schema);
  if (cached) return [...cached];
  const unique: PrivacyField[] = [];
  const byKey = new Map<string, PrivacyField>();
  walkPrivacy(schema, {
    marked: (path, className, truncated) => {
      const key = `${path}\u0000${className}`;
      const known = byKey.get(key);
      if (known) {
        if (truncated) known.truncated = true;
        return;
      }
      const field: PrivacyField = truncated ? { path, class: className, truncated: true } : { path, class: className };
      byKey.set(key, field);
      unique.push(field);
    },
  });
  classified.set(schema, unique);
  return [...unique];
}

/** The classes {@link classifyPrivacy} lists for a schema, by schema. */
const listed = new WeakMap<z.ZodType, ReadonlySet<string>>();

/**
 * Whether a schema holds a field of `className` at any depth — the cheap boolean a route or a guard branches on. It
 * reads the record `classifyPrivacy` lists from, each site once, without spelling out a path.
 */
export function hasPrivacy(schema: z.ZodType, className: string): boolean {
  let classes = listed.get(schema);
  if (!classes) {
    const found = new Set<string>();
    const seen = new Set<Shape>();
    const stack: (Site | undefined)[] = [siteOf(schema)];
    for (let index = 0; index < stack.length; index += 1) {
      const site = stack[index];
      if (site === undefined) continue;
      if (site.whole) for (const each of site.whole.classes) found.add(each);
      const { shape } = site;
      if (site.whole || shape === undefined || seen.has(shape)) continue;
      seen.add(shape);
      // A symbol key is masked by `redact` but has no path to list, so it is read here as `classifyPrivacy` reads it.
      for (const [key, field] of shape.fields) if (typeof key === "string") stack.push(field);
      stack.push(shape.catchall, shape.key, ...shape.items, shape.rest);
    }
    classes = found;
    listed.set(schema, classes);
  }
  return classes.has(className);
}
