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
 A recursive schema terminates on the lazy itself: a lazy is read through Zod's own cached target, the schema `parse`
 * ran, never by calling its getter again, and a walk that meets the same lazy again at the same position, or below
 * itself here, stops. An object written with a getter that reaches itself stops the same way, through the shape Zod
 * froze on first read. **A walk never throws, and past {@link MAX_SCHEMA_DEPTH} it fails closed.** A factory that
 * builds a new schema at every level — a getter or a lazy that calls a function returning a fresh one — hands every
 * level a node no guard has seen. Every position, every lazy resolved and every level searched counts toward one
 * budget, and where it runs out the walk stops and takes the rest to carry a mark of the strongest class,
 * {@link TRUNCATED_CLASS}: `redact` masks that position whole as `[secret]`, and `classifyPrivacy` lists it with
 * `truncated: true`. A value nested that deep under a recursive schema built once is masked there the same way. Build
 * a recursive schema once and refer to it by name, and nothing a hand-written schema holds ever reaches the limit.
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
   * Set when the walk ran out of depth here ({@link MAX_SCHEMA_DEPTH}) and assumed a mark of {@link TRUNCATED_CLASS}
   * rather than read further: a factory-built recursive schema, or one nested past the limit. `redact` masks the
   * position whole. Absent everywhere the schema was read to the end.
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
  shape?: Record<string, z.ZodType>;
  coerce?: boolean;
}

/** The definition behind a schema: the one its own `parse` reads. */
function defOf(schema: z.ZodType): Def {
  return (schema as unknown as { _zod: { def: Def } })._zod.def;
}

/**
 * An object's fields: its definition's shape, which Zod freezes on first read, so a getter in it runs once and every
 * later read — `parse`'s and this walk's — sees the same schemas.
 */
function shapeOf(schema: z.ZodType): Record<string, z.ZodType> {
  return defOf(schema).shape ?? {};
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
 * How deep a walk goes before it stops and fails closed: far past any schema written by hand, and short of a stack
 * overflow. Positions, lazies resolved and levels searched all count. A factory that builds a new schema at every
 * level reaches it, and so does a value nested that deep.
 */
export const MAX_SCHEMA_DEPTH = 256;

/**
 * The class a walk assumes where it ran out of depth: the strongest there is, because what lies past the limit was
 * not read. `redact` masks such a position as `[secret]`.
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
  for (const [key, slot] of Object.entries(def)) {
    // A check is not a node, and holds no schema a value is parsed by. A lazy's getter is read above, through its cache.
    if (key === "checks" || key === "getter") continue;
    if (isSchema(slot)) found.push(slot);
    else if (Array.isArray(slot)) found.push(...slot.filter(isSchema));
    else if (key === "shape" && typeof slot === "object" && slot !== null)
      found.push(...Object.values(slot).filter(isSchema));
  }
  return found;
}

/** {@link marksIn}, by schema. A schema is immutable, so its answer never changes. */
const marked = new WeakMap<z.ZodType, ReadonlySet<string>>();

/** Every schema whose search {@link marksIn} cut short at {@link MAX_SCHEMA_DEPTH}, assuming {@link TRUNCATED_CLASS}. */
const cutShort = new WeakSet<z.ZodType>();

/**
 * Every class marked anywhere in a schema: on it, on every side of every pipe and codec, in every option, behind
 * every lazy, in a set's elements, a map's keys and a function's arguments. What decides an opaque node. A search
 * deeper than {@link MAX_SCHEMA_DEPTH} stops there and adds {@link TRUNCATED_CLASS}, so it fails closed.
 */
function marksIn(schema: z.ZodType): ReadonlySet<string> {
  const known = marked.get(schema);
  if (known) return known;
  const found = new Set<string>();
  const seen = new Set<z.ZodType>();
  const stack: [z.ZodType, number][] = [[schema, 0]];
  for (let entry = stack.pop(); entry; entry = stack.pop()) {
    const [node, depth] = entry;
    if (seen.has(node)) continue;
    if (depth > MAX_SCHEMA_DEPTH) {
      found.add(TRUNCATED_CLASS);
      cutShort.add(schema);
      continue;
    }
    seen.add(node);
    const own = ownMarker(node);
    if (own !== null) found.add(own);
    // Reversed, so the classes come out in the order the schema declares them.
    else
      stack.push(
        ...children(node)
          .map((child): [z.ZodType, number] => [child, depth + 1])
          .reverse(),
      );
  }
  marked.set(schema, found);
  return found;
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
  /** Each lazy this position went through. */
  readonly lazies: readonly z.ZodType[];
  /**
   * Whether an opaque node with no mark inside, and not a scalar, sits here: a transform or an `unknown`, which may
   * hold whatever the rest of the position marks.
   */
  readonly free: boolean;
  /** The opaque nodes with no mark inside, which `pithy privacy scan` still reads field names through. */
  readonly unmarked: readonly z.ZodType[];
  /** The classes inside each lazy this position did not follow again, because the walk is already inside it. */
  readonly beyond: ReadonlySet<string>;
  /**
   * Whether the walk ran out of depth here — a chain of lazies past {@link MAX_SCHEMA_DEPTH}, or a search of an opaque
   * node's insides that was cut short — so the position is taken to carry {@link TRUNCATED_CLASS}, and masked whole.
   */
  readonly truncated: boolean;
}

/** {@link position} of one schema, which is the common case and never changes. */
const positions = new WeakMap<z.ZodType, Position>();

/**
 * The position `schemas` reach. A lazy in `stop` is not followed: it is one the walk is already inside, so following
 * it again would say nothing new and never end.
 */
export function position(schemas: readonly z.ZodType[], stop?: ReadonlySet<z.ZodType>): Position {
  const single = schemas.length === 1 && !stop ? schemas[0] : undefined;
  const known = single && positions.get(single);
  if (known) return known;
  const marks = new Set<string>();
  const opaque = new Set<string>();
  const leaves: z.ZodType[] = [];
  const lazies: z.ZodType[] = [];
  let free = false;
  const unmarked: z.ZodType[] = [];
  const beyond = new Set<string>();
  let truncated = false;
  const stack = [...schemas].reverse();
  for (let node = stack.pop(); node; node = stack.pop()) {
    const own = ownMarker(node);
    if (own !== null) {
      marks.add(own);
      continue;
    }
    const def = defOf(node);
    if (WRAPPERS.has(def.type)) {
      if (def.innerType) stack.push(def.innerType);
    } else if (def.type === "union") stack.push(...[...(def.options ?? [])].reverse());
    else if (def.type === "intersection") stack.push(...[def.right, def.left].filter(isSchema));
    else if (def.type === "lazy") {
      // The lazy itself is the guard, never a wrapper built around it: a getter that reaches it again stops here.
      if (lazies.includes(node)) continue;
      if (stop?.has(node)) {
        // Not walked again, but what it holds is still what this position holds.
        for (const className of marksIn(node)) beyond.add(className);
        if (cutShort.has(node)) truncated = true;
        continue;
      }
      // A lazy whose getter returns a new lazy, at every level, would never reach anything else: stop, closed.
      if (lazies.length >= MAX_SCHEMA_DEPTH) {
        truncated = true;
        continue;
      }
      lazies.push(node);
      const inner = lazyInner(node);
      if (inner) stack.push(inner);
    } else if (STRUCTURAL.has(def.type)) leaves.push(node);
    else {
      const inside = marksIn(node);
      for (const className of inside) opaque.add(className);
      if (cutShort.has(node)) truncated = true;
      if (inside.size === 0 && !isScalar(def)) {
        free = true;
        unmarked.push(node);
      }
    }
  }
  if (truncated) opaque.add(TRUNCATED_CLASS);
  const found: Position = { marks, opaque, leaves, lazies, free, unmarked, beyond, truncated };
  if (single) positions.set(single, found);
  return found;
}

/** Every class a position carries, on it or anywhere below it. */
function carriedClasses(at: Position): string[] {
  return [...new Set([...at.marks, ...at.opaque, ...at.beyond, ...at.leaves.flatMap((leaf) => [...marksIn(leaf)])])];
}

/** Whether anything a position carries was assumed rather than read, because a search ran out of depth. */
function carriedTruncated(at: Position): boolean {
  return at.truncated || at.leaves.some((leaf) => marksIn(leaf).size > 0 && cutShort.has(leaf));
}

/** A position past the depth budget, read no further: it carries {@link TRUNCATED_CLASS} and is masked whole. */
export const PAST_DEPTH: Position = {
  marks: new Set(),
  opaque: new Set([TRUNCATED_CLASS]),
  leaves: [],
  lazies: [],
  free: false,
  unmarked: [],
  beyond: new Set(),
  truncated: true,
};

/**
 * How a position is masked whole, or `undefined` when it is walked into. A marked node masks it with its class's own
 * mask. An opaque node with a mark inside masks it with the `[class]` placeholder, and so does an opaque node with no
 * mark inside where anything else at the position carries one: a transform or an `unknown` beside a marked object
 * reads, or holds, the same value. `classes` are every class the mask stands for; `className` is the strongest.
 * `truncated` says the walk ran out of depth and assumed {@link TRUNCATED_CLASS} among them.
 */
export function wholeMask(at: Position):
  | {
      readonly className: string;
      readonly placeholder: boolean;
      readonly classes: readonly string[];
      readonly truncated: boolean;
    }
  | undefined {
  const own = [...new Set([...at.marks, ...at.opaque])];
  const fromCarried = own.length === 0 && at.free;
  const classes = fromCarried ? carriedClasses(at) : own;
  const className = strongestPrivacyClass(classes);
  if (className === undefined) return undefined;
  const truncated = fromCarried ? carriedTruncated(at) : at.truncated;
  return { className, placeholder: at.opaque.size > 0 || at.marks.size === 0, classes, truncated };
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
export function fieldSchemas(leaves: readonly z.ZodType[], key: string): z.ZodType[] {
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

/** The keys any object at the position names, in order. */
function namedKeys(leaves: readonly z.ZodType[]): string[] {
  const keys = new Set<string>();
  for (const leaf of leaves)
    if (defOf(leaf).type === "object") for (const key of Object.keys(shapeOf(leaf))) keys.add(key);
  return [...keys];
}

/** The schemas a record's keys are parsed by: every record at the position. */
export function keySchemas(leaves: readonly z.ZodType[]): z.ZodType[] {
  return leaves.flatMap((leaf) => {
    const def = defOf(leaf);
    return def.type === "record" && def.keyType ? [def.keyType] : [];
  });
}

/** The schemas at element `index`: each array's element, and each tuple's item there or its rest. */
export function elementSchemas(leaves: readonly z.ZodType[], index: number): z.ZodType[] {
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
  /** One masked path and class; `truncated` when the walk ran out of depth there and assumed the class. */
  marked(path: string, className: string, truncated?: boolean): void;
  unmarkedKey?(path: string, key: string): void;
}

/**
 * Walk one position. `open` is the lazies and objects on the current branch, which are not walked again below
 * themselves, and `depth` how many positions and lazies deep the branch is. Past {@link MAX_SCHEMA_DEPTH} the position
 * is listed as {@link TRUNCATED_CLASS}, truncated, and read no further.
 */
function walkAt(
  schemas: readonly z.ZodType[],
  path: string,
  visitor: PrivacyVisitor,
  open: Set<z.ZodType>,
  depth: number,
): void {
  if (schemas.length === 0) return;
  const reached = position(schemas, open);
  // Every lazy this position resolved is one more level down: a factory's lazies run the budget out like its fields.
  const at = depth + reached.lazies.length > MAX_SCHEMA_DEPTH ? PAST_DEPTH : reached;
  const whole = wholeMask(at);
  if (whole) {
    for (const className of whole.classes)
      visitor.marked(path, className, whole.truncated && className === TRUNCATED_CLASS);
    return;
  }
  // An opaque node with no mark inside is kept by `redact` and lists nothing, but the scan still reads the names of
  // the fields inside it — a JSON column's, a transform's input — because marking one is how the node gets masked.
  if (visitor.unmarkedKey)
    for (const node of at.unmarked.filter((each) => !open.has(each))) {
      open.add(node);
      walkAt(children(node), path, visitor, open, depth + 1);
      open.delete(node);
    }
  // A recursive object written with a getter reaches itself again; the second visit has nothing new to say.
  const leaves = at.leaves.filter((leaf) => !open.has(leaf));
  if (leaves.length === 0) return;
  const entered = [...at.lazies, ...leaves].filter((node) => !open.has(node));
  for (const node of entered) open.add(node);
  depth += at.lazies.length;
  for (const key of namedKeys(leaves)) {
    const fieldPath = join(path, key);
    const field = fieldSchemas(leaves, key);
    if (!wholeMask(position(field, open))) visitor.unmarkedKey?.(fieldPath, key);
    walkAt(field, fieldPath, visitor, open, depth + 1);
  }
  walkAt(catchallSchemas(leaves), join(path, "*"), visitor, open, depth + 1);
  walkAt(keySchemas(leaves), join(path, "<key>"), visitor, open, depth + 1);
  const items = Math.max(0, ...leaves.map((leaf) => (leafIs(leaf, "tuple") ? (defOf(leaf).items?.length ?? 0) : 0)));
  for (let index = 0; index < items; index += 1)
    walkAt(elementSchemas(leaves, index), `${path}[${index}]`, visitor, open, depth + 1);
  walkAt(restSchemas(leaves), `${path}[]`, visitor, open, depth + 1);
  for (const node of entered) open.delete(node);
}

/**
 * Walk a schema tree the way {@link classifyPrivacy} does, from `path`, and report to `visitor`. Exported so a
 * second reader of the tree — the CLI's scan — cannot walk it differently.
 */
export function walkPrivacy(schema: z.ZodType, visitor: PrivacyVisitor, path = ""): void {
  walkAt([schema], path, visitor, new Set(), 0);
}

/** Classifications already computed, by schema. A schema is immutable, so its answer never changes. */
const classified = new WeakMap<z.ZodType, readonly PrivacyField[]>();

/**
 * Every position `redact` masks in a schema, and its class, in one pass — the Art. 30 record for one object, derived
 * rather than maintained. Empty for a schema with no markers. A path reached twice (two union options naming the same
 * field) is listed once per class. It never throws: a position past {@link MAX_SCHEMA_DEPTH} is listed as
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

/** Whether a schema holds a field of `className` at any depth — the cheap boolean a route or a guard branches on. */
export function hasPrivacy(schema: z.ZodType, className: string): boolean {
  return classifyPrivacy(schema).some((field) => field.class === className);
}
