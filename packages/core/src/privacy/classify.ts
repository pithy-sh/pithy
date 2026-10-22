// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { z } from "zod";
import { isSqliteJson, SQLiteBoolean, SQLiteDate } from "../data/codecs";
import { type BuiltInPrivacyClass, PRIVACY_META_KEY, strongestPrivacyClass } from "./classes";

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
 *   tuples and their rest, records, `Map` and `Set`; the wrappers `optional`, `nullable`, `default`, `catch`,
 *   `readonly` and a brand; unions, discriminated unions and intersections, where an option's marks apply where
 *   the value has that option's shape — a marked string option to a string, never to an array or a number beside
 *   it — and a mark reached through no option applies to every value; the kit's `SQLiteDate`, `SQLiteBoolean` and
 *   `sqliteJson(schema)`, read through to the schema they decode to; and recursion, a `z.lazy` or a getter, to the
 *   one limit below.
 * - **Everything else is opaque**: a transform, a pipe, a preprocess, any other codec, `z.custom`, `any`, `unknown`.
 *   Nothing inside one is walked. With a mark anywhere beneath it, its position is masked whole with the strongest
 *   class it carries; with none, it is kept, a union option beside a marked one included.
 * - **Recursion is bounded once**, at {@link MAX_RECURSION_DEPTH} levels of nesting: a position deeper than that is
 *   masked whole as {@link TRUNCATED_CLASS}, whatever the recursion is written with. Nothing here tells one kind of
 *   recursion from another, so every answer is a function of the schema and the value alone.
 * - **`classifyPrivacy` reads at most {@link MAX_CLASSIFIED_POSITIONS} positions**, level by level, shallowest first.
 *   `redact` walks a value, which is finite; a list walks the schema, and one that builds two new schemas at every
 *   level has more positions than any list can hold. Such a schema is read whole down to the level the budget runs
 *   out on, and each position left, none of them above that level, is listed as {@link TRUNCATED_CLASS} with
 *   `truncated`. It is the one place the list says more than `redact` masks, and it says the strongest class.
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
   * Set where the walk stopped reading and assumed {@link TRUNCATED_CLASS}: a position nested past
   * {@link MAX_RECURSION_DEPTH}, a search beneath it that ran that deep, or one left once the walk had read
   * {@link MAX_CLASSIFIED_POSITIONS}, level by level. Absent everywhere the schema was read to the end.
   */
  truncated?: true;
}

/**
 * **The one recursion limit**, shared by `redact`, `classifyPrivacy` and `Redacted<T>` (`./types` reads this constant's
 * type). Depth is counted in levels of nesting: every object, array, tuple, record, map and set a position sits inside.
 * A position deeper than this is masked whole as {@link TRUNCATED_CLASS} and typed `unknown`, however the recursion
 * is written: a `z.lazy`, a getter that returns one schema, or one that builds a new schema each read. No schema
 * written out by hand nests this deep, so only a recursion reaches it. A search for a mark beneath an opaque node
 * stops at the same depth, counting each lazy too, and so does the one `Redacted<T>` makes.
 */
export const MAX_RECURSION_DEPTH = 256;

/**
 * How many positions {@link classifyPrivacy} reads, level by level, before it lists each one left as
 * {@link TRUNCATED_CLASS}. Far past any schema written out, and past any recursion defined once, which is listed once;
 * only one that builds two new schemas at every level reaches it, and then only below the levels it read whole.
 */
export const MAX_CLASSIFIED_POSITIONS = 10_000;

/** The class assumed past {@link MAX_RECURSION_DEPTH}: the strongest there is, because nothing past it was read. */
export const TRUNCATED_CLASS: BuiltInPrivacyClass = "secret";

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

/** The kinds of schema that hold no value a mask could apply to. */
const NO_VALUE: ReadonlySet<string> = new Set(["null", "undefined", "void", "never"]);

/**
 * The shapes a schema's output can have: read through its wrappers, the options of a union, the sides of an
 * intersection, a lazy and the kit's codecs. Every shape for anything opaque, whose output nothing here reads.
 */
function kindsOf(schema: z.ZodType, path: Set<z.ZodType> = new Set()): ReadonlySet<ValueKind> {
  const def = defOf(schema);
  const one = SCHEMA_KINDS[def.type];
  if (one !== undefined) return new Set([one]);
  if (NO_VALUE.has(def.type)) return NO_KIND;
  if (def.type === "literal" || def.type === "enum") {
    const values = (schema as unknown as { _zod: { values?: ReadonlySet<unknown> } })._zod.values;
    return values ? new Set([...values].flatMap((value) => [kindOfValue(value)].filter(isKind))) : EVERY_KIND;
  }
  // A lazy that only ever resolves to itself holds nothing parse could return: every shape, so nothing is missed.
  if (path.has(schema)) return EVERY_KIND;
  path.add(schema);
  try {
    if (WRAPPERS.has(def.type) && def.innerType) return kindsOf(def.innerType, path);
    if (def.type === "union" && def.options) return joinKinds(def.options.map((option) => kindsOf(option, path)));
    if (def.type === "intersection" && def.left && def.right) {
      const right = kindsOf(def.right, path);
      return new Set([...kindsOf(def.left, path)].filter((kind) => right.has(kind)));
    }
    if (def.type === "lazy") {
      const inner = lazyInner(schema);
      return inner ? kindsOf(inner, path) : EVERY_KIND;
    }
    const codec = kitCodecOutput(schema);
    return codec ? kindsOf(codec, path) : EVERY_KIND;
  } finally {
    path.delete(schema);
  }
}

function isKind(kind: ValueKind | undefined): kind is ValueKind {
  return kind !== undefined;
}

function joinKinds(sets: readonly ReadonlySet<ValueKind>[]): ReadonlySet<ValueKind> {
  return new Set(sets.flatMap((set) => [...set]));
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
  readonly classes: ReadonlySet<string>;
  readonly truncated: boolean;
}

const searched = new WeakMap<z.ZodType, Search>();

/**
 * Every class marked anywhere beneath a schema, on every side of every node. Depth first, each schema once, and a
 * path more than {@link MAX_RECURSION_DEPTH} levels long, counting each lazy and each structural node, stops the whole
 * search with {@link TRUNCATED_CLASS}: nothing past it could carry a stronger class. Depth first is what keeps a
 * schema that builds two new ones at every level linear: the first path runs out, and the search ends.
 */
function search(schema: z.ZodType): Search {
  const known = searched.get(schema);
  if (known) return known;
  const classes = new Set<string>();
  let truncated = false;
  const seen = new Set<z.ZodType>();
  const stack: [z.ZodType, number][] = [[schema, 0]];
  for (let entry = stack.pop(); entry; entry = stack.pop()) {
    const [node, depth] = entry;
    if (seen.has(node)) continue;
    seen.add(node);
    const own = ownMarker(node);
    if (own !== null) {
      classes.add(own);
      continue;
    }
    const def = defOf(node);
    const step = def.type === "lazy" || STRUCTURAL.has(def.type) ? 1 : 0;
    if (depth + step > MAX_RECURSION_DEPTH) {
      truncated = true;
      break;
    }
    // Reversed, so the classes come out in the order the schema declares them.
    stack.push(
      ...children(node)
        .map((child): [z.ZodType, number] => [child, depth + step])
        .reverse(),
    );
  }
  if (truncated) classes.add(TRUNCATED_CLASS);
  const found = { classes, truncated };
  searched.set(schema, found);
  return found;
}

/** How a position is masked whole. */
export interface Mask {
  /** The strongest class the position carries: its placeholder is the mask, unless `own`. */
  readonly className: string;
  /** Whether the class's own mask applies: one class, from a marker, and nothing opaque. */
  readonly own: boolean;
  /** Every class the position carries, in the order met. */
  readonly classes: readonly string[];
  /** Whether a search ran out of recursion and assumed {@link TRUNCATED_CLASS}. */
  readonly truncated: boolean;
}

/** One position: every schema that reaches it, flattened through wrappers, choices, lazies and the kit's codecs. */
export interface Position {
  /**
   * Set when some value here is masked whole: every class the position masks, whatever the value's shape. What
   * `classifyPrivacy` lists, and how a record's key is masked, since an object's key is a string whatever its schema.
   */
  readonly mask: Mask | undefined;
  /** Whether every value here is masked whole, whatever its shape. */
  readonly whole: boolean;
  /**
   * How a value is masked here, by its shape: a mark reached through a union option applies to a value of that
   * option's shape, and one reached through no option to every value. `undefined` where the value is walked or kept.
   */
  maskFor(value: unknown): Mask | undefined;
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
}

/** The kind of value a structural node holds. */
function leafKind(leaf: z.ZodType): ValueKind {
  return SCHEMA_KINDS[defOf(leaf).type] as ValueKind;
}

/** The mask made of `reaches` and the structural nodes masked with them, or `undefined` when none applies. */
function maskOf(reaches: readonly Reach[], leaves: readonly z.ZodType[]): Mask | undefined {
  if (reaches.length === 0) return undefined;
  const found = leaves.map(search);
  const classes = [
    ...new Set([...reaches.flatMap((reach) => reach.classes), ...found.flatMap((each) => [...each.classes])]),
  ];
  return {
    className: strongestPrivacyClass(classes) as string,
    own: reaches.every((reach) => !reach.opaque) && classes.length === 1,
    classes,
    truncated: reaches.some((reach) => reach.truncated) || found.some((each) => each.truncated),
  };
}

/** A mask, written out: two positions with the same leaves and the same masks are one. */
function maskKey(mask: Mask): string {
  return `${mask.own ? "own" : "strongest"}:${mask.truncated ? "truncated" : "read"}:${mask.classes.join("|")}`;
}

/** Flatten a position and decide how it is masked. Its children are read when first asked for. */
function readPosition(schemas: readonly z.ZodType[]): {
  position: Position;
  leaves: readonly z.ZodType[];
  signature: string;
} {
  const reaches: Reach[] = [];
  const leaves = new Set<z.ZodType>();
  const lazies = new Set<z.ZodType>();
  const lazyGates = new Set<string>();
  let other = false;
  // Each schema with the shapes of value it applies to: every shape, until a union option narrows it.
  const stack: [z.ZodType, ReadonlySet<ValueKind>][] = [...schemas].reverse().map((schema) => [schema, EVERY_KIND]);
  for (let entry = stack.pop(); entry; entry = stack.pop()) {
    const [node, gate] = entry;
    if (gate.size === 0) continue;
    const own = ownMarker(node);
    if (own !== null) {
      reaches.push({ gate, classes: [own], opaque: false, truncated: false });
      continue;
    }
    const def = defOf(node);
    const codec = kitCodecOutput(node);
    const lazy = def.type === "lazy";
    if (lazy) {
      const key = `${idOf(node)}:${[...gate].join(",")}`;
      if (lazyGates.has(key)) continue;
      lazyGates.add(key);
      if (!lazies.has(node) && lazies.size >= MAX_RECURSION_DEPTH) {
        // A lazy that only ever resolves to another: past the limit, assumed the strongest class, as a search is.
        reaches.push({ gate, classes: [TRUNCATED_CLASS], opaque: true, truncated: true });
        other = true;
        continue;
      }
    }
    if (WRAPPERS.has(def.type) && def.innerType) {
      stack.push([def.innerType, gate]);
      continue;
    } else if (def.type === "union" && def.options) {
      // An option applies where the value has its shape: its marks are narrowed to that shape.
      for (const option of [...def.options].reverse()) {
        const kinds = kindsOf(option);
        stack.push([option, new Set([...gate].filter((kind) => kinds.has(kind)))]);
      }
      continue;
    } else if (def.type === "intersection") {
      // A value of an intersection has both sides' shapes, so both apply wherever it does.
      for (const side of [def.right, def.left].filter(isSchema)) stack.push([side, gate]);
      continue;
    } else if (codec) {
      stack.push([codec, gate]);
      continue;
    } else if (lazy) {
      lazies.add(node);
      const inner = lazyInner(node);
      if (inner) stack.push([inner, gate]);
      continue;
    } else if (STRUCTURAL.has(def.type)) {
      if (gate.has(leafKind(node))) leaves.add(node);
      continue;
    }
    const inside = search(node);
    if (inside.classes.size > 0)
      reaches.push({ gate, classes: [...inside.classes], opaque: true, truncated: inside.truncated });
    other = true;
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
  const whole = byKind.size === VALUE_KINDS.length;
  const signature = [...byKind].map(([kind, each]) => `${kind}=${maskKey(each)}`).join(";");
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
  const position: Position = {
    mask,
    whole,
    maskFor: (value) => {
      const kind = kindOfValue(value);
      return kind === undefined ? undefined : byKind.get(kind);
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

/**
 * What a walk reports. `marked` is called once per masked path and class. `unmarkedKey`, when given, is called for each
 * object key whose position is not masked whole, before the walk steps into it — the hook `pithy privacy scan` reads a
 * field's name through, so the scan and the inventory walk one tree the same way.
 */
export interface PrivacyVisitor {
  /** One masked path and class; `truncated` when a search ran out of recursion there and assumed the class. */
  marked(path: string, className: string, truncated?: boolean): void;
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
  /** Set when the walk had read {@link MAX_CLASSIFIED_POSITIONS} before it came to this one. */
  unread?: true;
}

/** Whether a frame's position is one it sits below: a recursion defined once, come round. */
function onLine(frame: Frame): boolean {
  for (let above = frame.parent; above; above = above.parent) if (above.at === frame.at) return true;
  return false;
}

/** The frames below a position that is read, in the order the schema names them. */
function framesBelow(frame: Frame, at: Position): Frame[] {
  const next = frame.depth + 1;
  const below: Frame[] = [];
  const add = (child: Position | undefined, path: string, depth: number, key?: string) => {
    below.push(
      key === undefined ? { at: child, path, depth, parent: frame } : { at: child, path, depth, key, parent: frame },
    );
  };
  for (const key of at.keys) if (typeof key === "string") add(at.field(key), join(frame.path, key), next, key);
  add(at.catchall, join(frame.path, "*"), next);
  // A key is read where its object is, and never nested below it.
  add(at.key, join(frame.path, "<key>"), frame.depth);
  for (let index = 0; index < at.items; index += 1) add(at.item(index), `${frame.path}[${index}]`, next);
  add(at.rest, `${frame.path}[]`, next);
  add(at.mapKey, join(frame.path, "<key>"), next);
  add(at.mapValue, join(frame.path, "*"), next);
  add(at.element, `${frame.path}[]`, next);
  return below;
}

/**
 * Walk a schema tree the way {@link classifyPrivacy} does, from `path`, and report to `visitor`. Exported so a second
 * reader of the tree — the CLI's scan — cannot walk it differently. A position met again below itself is a recursion
 * defined once, and is not walked again: its fields are listed once. A position nested more than
 * {@link MAX_RECURSION_DEPTH} levels deep is masked whole by `redact`, and listed as {@link TRUNCATED_CLASS}.
 *
 * Positions are read level by level, shallowest first, and reported in the schema's own order. Only a schema that
 * builds two new ones at every level has more than {@link MAX_CLASSIFIED_POSITIONS}; the positions left, none of them
 * above the level the budget ran out on, are listed as {@link TRUNCATED_CLASS}.
 */
export function walkPrivacy(schema: z.ZodType, visitor: PrivacyVisitor, path = ""): void {
  const root: Frame = { at: rootPosition(schema), path, depth: 0 };
  // Read, breadth first, so the budget runs out at the deepest level, never on a shallow branch.
  const queue: Frame[] = [root];
  let read = 0;
  for (let index = 0; index < queue.length; index += 1) {
    const frame = queue[index] as Frame;
    const { at } = frame;
    if (at === undefined || frame.depth > MAX_RECURSION_DEPTH || at.whole) continue;
    if (at.kinds.size === 0 || onLine(frame)) continue;
    if (read >= MAX_CLASSIFIED_POSITIONS) {
      frame.unread = true;
      continue;
    }
    read += 1;
    frame.below = framesBelow(frame, at);
    queue.push(...frame.below);
  }
  // Report, depth first, in the order the schema names each position.
  const stack: Frame[] = [root];
  for (let frame = stack.pop(); frame; frame = stack.pop()) {
    const { at } = frame;
    if (at === undefined) continue;
    if (frame.depth > MAX_RECURSION_DEPTH) {
      visitor.marked(frame.path, TRUNCATED_CLASS, true);
      continue;
    }
    if (at.mask) {
      for (const className of at.mask.classes)
        visitor.marked(frame.path, className, at.mask.truncated && className === TRUNCATED_CLASS);
    } else if (frame.key !== undefined) visitor.unmarkedKey?.(frame.path, frame.key);
    if (frame.unread) visitor.marked(frame.path, TRUNCATED_CLASS, true);
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
    marked: (path, className, truncated) => {
      const key = `${path}\u0000${className}`;
      if (byKey.has(key)) return;
      const field: PrivacyField = truncated ? { path, class: className, truncated: true } : { path, class: className };
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
