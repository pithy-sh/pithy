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
 *   `readonly` and a brand; unions, discriminated unions and intersections, where a position is masked when any
 *   option or side marks it; the kit's `SQLiteDate`, `SQLiteBoolean` and `sqliteJson(schema)`, read through to the
 *   schema they decode to; and recursion, a `z.lazy` or a getter, read as the schema Zod settled on.
 * - **Everything else is opaque**: a transform, a pipe, a preprocess, any other codec, `z.custom`, `any`, `unknown`,
 *   a lazy or a getter that builds a new schema at every level without end. Nothing inside one is walked. With a mark
 *   anywhere beneath it, its position is masked whole with the strongest class it carries; with none, it is kept.
 * - **Recursion is bounded once**, at {@link MAX_RECURSION_DEPTH}: a search through lazies and getters that goes
 *   deeper, and a value that comes round to one position it is already inside more often, is masked whole as
 *   {@link TRUNCATED_CLASS}.
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
   * Set when a search ran past {@link MAX_RECURSION_DEPTH} here and assumed {@link TRUNCATED_CLASS} rather than read
   * further: a schema built anew at every level. Absent everywhere the schema was read to the end.
   */
  truncated?: true;
}

/**
 * How many recursion steps a search takes before it stops and assumes the strongest class: each lazy resolved and
 * each object whose fields are getters. It bounds `redact` too, by how often a value comes round to one position it
 * is already inside, each position counted on its own. Far past any recursion a real value holds.
 */
export const MAX_RECURSION_DEPTH = 256;

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

/** The getters of an object's shape as written, while Zod has not yet read it. Once read, it holds plain values. */
function rawGetters(schema: z.ZodType): Map<PropertyKey, () => unknown> {
  const found = new Map<PropertyKey, () => unknown>();
  const accessor = Object.getOwnPropertyDescriptor(defOf(schema), "shape")?.get as { raw?: unknown } | undefined;
  const raw = accessor?.raw;
  if (typeof raw !== "object" || raw === null) return found;
  for (const key of Reflect.ownKeys(raw)) {
    const get = Object.getOwnPropertyDescriptor(raw, key)?.get;
    if (get) found.set(key, () => get.call(raw));
  }
  return found;
}

/** The schemas an object's getters settled on, read before Zod froze its shape: each is checked for an endless build. */
const fromGetter = new WeakSet<z.ZodType>();

/**
 * An object's fields, read through the shape Zod freezes on first read, so every walk sees the schemas `parse` does,
 * whichever read the shape first. A getter is never called here: Zod calls it once, and its answer is the field.
 */
function shapeOf(schema: z.ZodType): Record<PropertyKey, z.ZodType> {
  const getters = rawGetters(schema);
  const shape = defOf(schema).shape ?? {};
  for (const key of getters.keys()) if (isSchema(shape[key])) fromGetter.add(shape[key]);
  return shape;
}

/**
 * Whether a getter's schema builds a new one at every level without end: the search beneath it ran out of recursion.
 * Such a schema is opaque wherever it is met, and a recursion defined once never is, as its search meets itself.
 */
function builtWithoutEnd(schema: z.ZodType): boolean {
  return fromGetter.has(schema) && search(schema).truncated;
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
 * path more than {@link MAX_RECURSION_DEPTH} recursion steps long stops the whole search with
 * {@link TRUNCATED_CLASS}: nothing past it could carry a stronger class. Depth first is what keeps a schema that
 * builds two new ones at every level linear: the first path runs out, and the search ends.
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
    const step = def.type === "lazy" || (def.type === "object" && rawGetters(node).size > 0) ? 1 : 0;
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
  /** Set when the position is masked whole. */
  readonly mask: Mask | undefined;
  /** The structural kinds here — `object`, `array`, `map` … — a value is walked by. */
  readonly kinds: ReadonlySet<string>;
  /** Whether anything here but a structural node may hold the value: a scalar, an opaque node. */
  readonly other: boolean;
  /** The strongest class anything here carries: what masks a key or an element no schema names. */
  readonly carried: string | undefined;
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
  const { position, leaves } = readPosition(distinct);
  // A position walked into is the same position whatever wrappers reached it: `Node` and `Node.optional()` are one,
  // so a recursion defined once comes round to the position it started at.
  const first = leaves[0];
  let found = position;
  if (position.mask === undefined && first !== undefined) {
    const leafKey = `${leaves.map(idOf).join(",")}${position.other ? "+" : ""}`;
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

/** Flatten a position and decide how it is masked. Its children are read when first asked for. */
function readPosition(schemas: readonly z.ZodType[]): { position: Position; leaves: readonly z.ZodType[] } {
  const marks = new Set<string>();
  const opaque = new Set<string>();
  const leaves = new Set<z.ZodType>();
  const lazies = new Set<z.ZodType>();
  let truncated = false;
  let other = false;
  const stack = [...schemas].reverse();
  for (let node = stack.pop(); node; node = stack.pop()) {
    const own = ownMarker(node);
    if (own !== null) {
      marks.add(own);
      continue;
    }
    const def = defOf(node);
    const codec = kitCodecOutput(node);
    const lazy = def.type === "lazy" && !search(node).truncated;
    if (lazy && lazies.has(node)) continue;
    if (builtWithoutEnd(node)) {
      // Opaque, below.
    } else if (WRAPPERS.has(def.type) && def.innerType) {
      stack.push(def.innerType);
      continue;
    } else if (def.type === "union" && def.options) {
      stack.push(...[...def.options].reverse());
      continue;
    } else if (def.type === "intersection") {
      stack.push(...[def.right, def.left].filter(isSchema));
      continue;
    } else if (codec) {
      stack.push(codec);
      continue;
    } else if (lazy) {
      lazies.add(node);
      const inner = lazyInner(node);
      if (inner) stack.push(inner);
      continue;
    } else if (STRUCTURAL.has(def.type)) {
      leaves.add(node);
      continue;
    }
    const inside = search(node);
    for (const className of inside.classes) opaque.add(className);
    if (inside.truncated) truncated = true;
    other = true;
  }
  const leafList = [...leaves];
  let carriedClasses: string[] | undefined;
  const carriedAll = (): string[] => {
    carriedClasses ??= [...new Set([...marks, ...opaque, ...leafList.flatMap((leaf) => [...search(leaf).classes])])];
    return carriedClasses;
  };
  let mask: Mask | undefined;
  if (marks.size > 0 || opaque.size > 0) {
    const classes = carriedAll();
    mask = {
      className: strongestPrivacyClass(classes) as string,
      own: opaque.size === 0 && classes.length === 1,
      classes,
      truncated: truncated || leafList.some((leaf) => search(leaf).truncated),
    };
  }
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
    kinds: new Set(leafList.map((leaf) => defOf(leaf).type)),
    other,
    get carried() {
      return strongestPrivacyClass(carriedAll());
    },
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
  return { position, leaves: leafList };
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

/**
 * Walk a schema tree the way {@link classifyPrivacy} does, from `path`, and report to `visitor`. Exported so a second
 * reader of the tree — the CLI's scan — cannot walk it differently. A position met again below itself is a recursion
 * defined once, and is not walked again: its fields are listed once.
 */
export function walkPrivacy(schema: z.ZodType, visitor: PrivacyVisitor, path = ""): void {
  type Frame = { at: Position | undefined; path: string; key?: string } | { leave: Position };
  const line = new Set<Position>();
  const stack: Frame[] = [{ at: rootPosition(schema), path }];
  for (let frame = stack.pop(); frame; frame = stack.pop()) {
    if ("leave" in frame) {
      line.delete(frame.leave);
      continue;
    }
    const { at } = frame;
    if (at === undefined) continue;
    if (at.mask) {
      for (const className of at.mask.classes)
        visitor.marked(frame.path, className, at.mask.truncated && className === TRUNCATED_CLASS);
      continue;
    }
    if (frame.key !== undefined) visitor.unmarkedKey?.(frame.path, frame.key);
    if (line.has(at)) continue;
    line.add(at);
    const below: Frame[] = [];
    for (const key of at.keys)
      if (typeof key === "string") below.push({ at: at.field(key), path: join(frame.path, key), key });
    below.push({ at: at.catchall, path: join(frame.path, "*") }, { at: at.key, path: join(frame.path, "<key>") });
    for (let index = 0; index < at.items; index += 1)
      below.push({ at: at.item(index), path: `${frame.path}[${index}]` });
    below.push(
      { at: at.rest, path: `${frame.path}[]` },
      { at: at.mapKey, path: join(frame.path, "<key>") },
      { at: at.mapValue, path: join(frame.path, "*") },
      { at: at.element, path: `${frame.path}[]` },
    );
    stack.push({ leave: at }, ...below.reverse());
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
