// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { z } from "zod";
import { PRIVACY_META_KEY, strongestPrivacyClass } from "./classes";
import { isTrustedDecode } from "./trusted";

/**
 * **Reading a privacy marker off a schema, and every marker off a schema tree** (#132).
 *
 * The marker is `meta({ privacy })` on the schema a marker was handed. Two things move it out of sight, and
 * this module is where both are undone, once:
 *
 * - **A wrapper.** `pii(z.string()).optional()` is a `ZodOptional` around the marked string, and the optional
 *   carries no meta of its own. {@link privacyOf} walks the wrapper chain inward — the `isFilterable` problem
 *   `@pithy-sh/vector` solved for `.meta({ filterable })`, solved here for this key.
 * - **Structure.** A marked field inside an object, an array, a union, a JSON column. {@link classifyPrivacy}
 *   walks the tree and names each marked path.
 *
 * ## What a path looks like
 *
 * Object keys join with `.`, an array element is `[]`, a tuple position is `[i]`, a record's or a map's value
 * and an object's catchall are `*`, and a record's or a map's key is `<key>`: `address.line1`, `devices[].token`,
 * `pair[1]`, `notes.*`, `byEmail.<key>`. A marked root is the empty path.
 *
 * ## What the walk steps into, and what it does not
 *
 * **A codec and a pipe are stepped into on both sides.** `sqliteJson(Profile)` stores `Profile` in a column, so a
 * marked field inside it is a marked field the table holds; a marker on a codec's wire side, or on a pipe's input, is
 * one `redact` masks, so it is listed too. A codec field marked as a whole — `pii(SQLiteDate)` — is read off the codec
 * itself before anything is stepped into.
 *
 * **A function over a mark it could read is listed whole.** `z.object({ email: pii(z.email()) }).transform(toAccount)`
 * hands back whatever `toAccount` returns, and no schema says where the email went, so `redact` masks the output whole
 * with the strongest class the function could read. The walk lists that position first — the empty path here — and
 * then the marked fields below it, because those are what the input holds. {@link runsHere} says whether a function
 * runs at a position, and {@link carriedClasses} what it could read; `redact` asks both the same questions, of every
 * branch that reaches the position.
 *
 * **Every branch is walked**: each option of a union or a discriminated union, both sides of an intersection. This is
 * the set of positions `redact` masks, exactly — it fails closed, masking a position any branch marks.
 *
 * **A lazy schema is followed**, the way `redact` follows one, so a marker behind a `z.lazy` is classified like
 * any other. A recursive schema is walked once per branch: a lazy or an object reached again inside itself
 * stops there, because the second visit has nothing new to say. That is what ends a walk over a recursive
 * schema, whether it is written with `z.lazy` or with a getter.
 *
 * **A marked node is not descended into.** `phi(z.object({ … }))` makes the whole value PHI, and `redact` masks
 * it whole; listing its inner fields as well would describe a masking that does not happen.
 */

/** One marked path in a schema, and its class. The per-field record the inventory is built from. */
export interface PrivacyField {
  /** Where in the value the field sits: `email`, `address.line1`, `devices[].token`, or `""` for the root. */
  path: string;
  /** The class it was marked with. */
  class: string;
}

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
  transform?: unknown;
  checks?: readonly { _zod?: { def?: { check?: string } } }[];
}

/** The definition behind a schema. */
function defOf(schema: z.ZodType): Def {
  return (schema as unknown as { def: Def }).def;
}

/** Wrappers that are the same field as what they wrap: a marker inside one is the field's marker. */
const WRAPPERS: ReadonlySet<string> = new Set([
  "optional",
  "nullable",
  "default",
  "prefault",
  "readonly",
  "catch",
  "nonoptional",
]);

/** The `privacy` meta on this exact schema, or `null`. */
function ownMarker(schema: z.ZodType): string | null {
  const meta = schema.meta() as Record<string, unknown> | undefined;
  const value = meta?.[PRIVACY_META_KEY];
  return typeof value === "string" ? value : null;
}

/** Step one wrapper inward, or `undefined` when `schema` is not a wrapper. */
function unwrapOnce(schema: z.ZodType): z.ZodType | undefined {
  const def = defOf(schema);
  return WRAPPERS.has(def.type) ? def.innerType : undefined;
}

/**
 * The class a field was marked with, read through its wrappers — `pii(z.string()).optional()` is `pii` — or
 * `null` when nothing along the chain carries one.
 */
export function privacyOf(schema: z.ZodType): string | null {
  let current: z.ZodType | undefined = schema;
  while (current) {
    const found = ownMarker(current);
    if (found !== null) return found;
    current = unwrapOnce(current);
  }
  return null;
}

/** `parent.key`, or `key` at the root. */
function join(path: string, key: string): string {
  return path === "" ? key : `${path}.${key}`;
}

/**
 * What a walk reports. `marked` is called once per marked path. `unmarkedKey`, when given, is called for each
 * object key whose schema carries no marker, before the walk steps into it — the hook `pithy privacy scan` reads
 * a field's name through, so the scan and the inventory walk one tree the same way.
 */
export interface PrivacyVisitor {
  marked(path: string, className: string): void;
  unmarkedKey?(path: string, key: string): void;
}

/** A schema with every wrapper around it stepped through. */
function unwrapped(schema: z.ZodType): z.ZodType {
  let node = schema;
  for (let inner = unwrapOnce(node); inner; inner = unwrapOnce(node)) node = inner;
  return node;
}

/** Check kinds that run a caller's function: a `.check()`, a `.refine()`, a `.superRefine()`, an `.overwrite()`. */
const FUNCTION_CHECKS: ReadonlySet<string> = new Set(["custom", "overwrite"]);

/** Whether a pipe is a codec whose decode is a caller's function, not one of the kit's own (`./trusted`). */
function untrustedCodec(def: Def): boolean {
  return typeof def.transform === "function" && !isTrustedDecode(def.transform);
}

/**
 * Whether this schema itself runs a caller's function on the value at its position: a transform, a `z.custom`, a
 * codec's decode, a check that can rewrite the value, or a `.catch()`, whose function is handed the input — on the
 * schema or on any wrapper around it. Only the kit's own codecs are trusted not to move a value.
 */
function ownFunction(schema: z.ZodType): boolean {
  for (let node: z.ZodType | undefined = schema; node; node = unwrapOnce(node)) {
    const def = defOf(node);
    if (def.type === "catch") return true;
    if ((def.checks ?? []).some((check) => FUNCTION_CHECKS.has(check._zod?.def?.check ?? ""))) return true;
    if (!WRAPPERS.has(def.type))
      return def.type === "transform" || def.type === "custom" || (def.type === "pipe" && untrustedCodec(def));
  }
  return false;
}

/** {@link runsHere}, by schema. A schema is immutable, so its answer never changes. */
const runs = new WeakMap<z.ZodType, boolean>();

/**
 * Whether a function runs on the value at this schema's position: on the schema itself, on either side of a pipe, in
 * any option of a union, on either side of an intersection, or behind a lazy. A field's, an element's or a value's own
 * functions sit at their own positions, and are not counted here.
 */
export function runsHere(schema: z.ZodType, seen: Set<z.ZodType> = new Set()): boolean {
  const known = runs.get(schema);
  if (known !== undefined) return known;
  if (seen.has(schema)) return false;
  const outermost = seen.size === 0;
  seen.add(schema);
  const def = defOf(unwrapped(schema));
  const found =
    ownFunction(schema) ||
    (def.type === "pipe" && [def.in, def.out].some((side) => side !== undefined && runsHere(side, seen))) ||
    (def.type === "union" && (def.options ?? []).some((option) => runsHere(option, seen))) ||
    (def.type === "intersection" && [def.left, def.right].some((side) => side !== undefined && runsHere(side, seen))) ||
    (def.type === "lazy" && def.getter !== undefined && runsHere(def.getter(), seen));
  // An answer reached inside a cycle was cut short by it, so only the outermost one is kept.
  if (outermost || found) runs.set(schema, found);
  return found;
}

/** Every class marked anywhere in a schema, on every side of every pipe and behind every lazy. */
function markersIn(schema: z.ZodType, found: Set<string>, seen: Set<z.ZodType>): void {
  if (seen.has(schema)) return;
  seen.add(schema);
  const marked = privacyOf(schema);
  if (marked !== null) {
    found.add(marked);
    return;
  }
  const def = defOf(unwrapped(schema));
  const node = unwrapped(schema);
  const children: (z.ZodType | null | undefined)[] = [
    def.element,
    def.left,
    def.right,
    def.rest,
    def.keyType,
    def.valueType,
    def.catchall,
    def.in,
    def.out,
    ...(def.options ?? []),
    ...(def.items ?? []),
  ];
  if (def.type === "object") children.push(...(Object.values((node as z.ZodObject).shape) as z.ZodType[]));
  if (def.type === "lazy" && def.getter) children.push(def.getter());
  for (const child of children) if (child) markersIn(child, found, seen);
}

/**
 * The classes a function at this schema's position could read: every mark at or below the position, in every branch,
 * except a mark that sits only after every function that runs there. In `z.preprocess(coerce, Profile)` the function
 * runs first and `Profile` says where each mark lands in what it returned, so `Profile`'s marks are not counted; in
 * `Profile.transform(f)` they are, because `f` reads them. A codec's app side comes after its decode the same way. A
 * union's options and an intersection's sides all read the same input, so a mark in one is read by a function in
 * another.
 *
 * `after` says a function at this position ran before this schema; `before`, that one runs after it.
 */
export function carriedClasses(schema: z.ZodType, after = false, before = false): Set<string> {
  const found = new Set<string>();
  carried(schema, after, before, found, new Set());
  return found;
}

function carried(schema: z.ZodType, after: boolean, before: boolean, found: Set<string>, seen: Set<z.ZodType>): void {
  if (seen.has(schema)) return;
  if (after && !before && !runsHere(schema)) return;
  if (before) {
    markersIn(schema, found, seen);
    return;
  }
  seen.add(schema);
  const marked = privacyOf(schema);
  if (marked !== null) {
    found.add(marked);
    return;
  }
  const def = defOf(unwrapped(schema));
  switch (def.type) {
    case "pipe":
      if (def.in) carried(def.in, after, def.out !== undefined && runsHere(def.out), found, seen);
      if (def.out)
        carried(
          def.out,
          after || untrustedCodec(def) || (def.in !== undefined && runsHere(def.in)),
          false,
          found,
          seen,
        );
      return;
    case "union":
      for (const option of def.options ?? []) carried(option, after, false, found, seen);
      return;
    case "intersection":
      for (const side of [def.left, def.right]) if (side) carried(side, after, false, found, seen);
      return;
    case "lazy":
      if (def.getter) carried(def.getter(), after, false, found, seen);
      return;
    default:
      seen.delete(schema);
      markersIn(schema, found, seen);
  }
}

/**
 * What one walk heard at each position, across every branch that reaches it: whether a function runs there, the
 * classes such a function could read, and whether a branch marks the position itself.
 */
interface Position {
  runs: boolean;
  readonly classes: Set<string>;
  marked: boolean;
}

/** One thing the walk reports, in the order it heard it. */
type Heard =
  | { readonly kind: "marked"; readonly path: string; readonly className: string }
  | { readonly kind: "unmarkedKey"; readonly path: string; readonly key: string };

/** The state of one walk: what it heard, in order, and each position it reached. */
interface Walk {
  readonly heard: Heard[];
  readonly positions: Map<string, Position>;
}

/** Step into a position from its parent, or at the root: record what runs there and what such a function reads. */
function enter(schema: z.ZodType, path: string, state: Walk, open: Set<z.ZodType>): void {
  let position = state.positions.get(path);
  if (!position) {
    position = { runs: false, classes: new Set(), marked: false };
    state.positions.set(path, position);
  }
  if (runsHere(schema)) position.runs = true;
  for (const className of carriedClasses(schema)) position.classes.add(className);
  walk(schema, path, state, open);
}

/** Walk one node, reporting each marked path it holds. `open` is the objects and lazies on the current branch. */
function walk(schema: z.ZodType, path: string, state: Walk, open: Set<z.ZodType>): void {
  const marked = privacyOf(schema);
  if (marked !== null) {
    state.heard.push({ kind: "marked", path, className: marked });
    const position = state.positions.get(path);
    if (position) position.marked = true;
    return;
  }
  const node = unwrapped(schema);
  const def = defOf(node);
  switch (def.type) {
    case "object": {
      // A recursive object written with a getter reaches itself again; the second visit has nothing new to say.
      if (open.has(node)) return;
      open.add(node);
      for (const [key, field] of Object.entries((node as z.ZodObject).shape) as [string, z.ZodType][]) {
        const fieldPath = join(path, key);
        if (privacyOf(field) === null) state.heard.push({ kind: "unmarkedKey", path: fieldPath, key });
        enter(field, fieldPath, state, open);
      }
      if (def.catchall) enter(def.catchall, join(path, "*"), state, open);
      open.delete(node);
      return;
    }
    case "array":
      if (def.element) enter(def.element, `${path}[]`, state, open);
      return;
    case "set":
      if (def.valueType) enter(def.valueType, `${path}[]`, state, open);
      return;
    case "tuple":
      for (const [index, item] of (def.items ?? []).entries()) enter(item, `${path}[${index}]`, state, open);
      if (def.rest) enter(def.rest, `${path}[]`, state, open);
      return;
    case "record":
    case "map":
      // A key is stored as surely as a value is, so a record keyed by a marked value holds that value.
      if (def.keyType) enter(def.keyType, join(path, "<key>"), state, open);
      if (def.valueType) enter(def.valueType, join(path, "*"), state, open);
      return;
    case "lazy": {
      // A recursive schema reaches the same lazy again inside itself; the second visit has nothing new to say.
      if (open.has(node) || !def.getter) return;
      open.add(node);
      walk(def.getter(), path, state, open);
      open.delete(node);
      return;
    }
    case "union":
      for (const option of def.options ?? []) walk(option, path, state, open);
      return;
    case "intersection":
      if (def.left) walk(def.left, path, state, open);
      if (def.right) walk(def.right, path, state, open);
      return;
    case "pipe":
      // Either side may carry a marker — a codec's wire side and its app side, a plain pipe's input and its output —
      // and `redact` masks a position either side marks, so both are listed.
      if (def.in) walk(def.in, path, state, open);
      if (def.out) walk(def.out, path, state, open);
      return;
    default:
      // A leaf, or a kind with no schema inside it.
      return;
  }
}

/** Whether `path` is `parent` or sits below it. */
function under(path: string, parent: string): boolean {
  return parent === "" || path === parent || path.startsWith(`${parent}.`) || path.startsWith(`${parent}[`);
}

/**
 * Walk a schema tree the way {@link classifyPrivacy} does, from `path`, and report to `visitor`. Exported so a
 * second reader of the tree — the CLI's scan — cannot walk it differently.
 *
 * A position where a function runs, over a mark it could read, is reported whole first, as the strongest class it
 * could read, before anything heard at or below it — the position `redact` masks whole. A position a branch marks
 * itself is masked by that marker instead.
 */
export function walkPrivacy(schema: z.ZodType, visitor: PrivacyVisitor, path = ""): void {
  const state: Walk = { heard: [], positions: new Map() };
  enter(schema, path, state, new Set());
  const whole: { path: string; className: string }[] = [];
  for (const [at, position] of state.positions) {
    const strongest = position.runs && !position.marked ? strongestPrivacyClass([...position.classes]) : undefined;
    if (strongest !== undefined) whole.push({ path: at, className: strongest });
  }
  const reported = new Set<string>();
  const reportWhole = (at: string): void => {
    for (const each of whole)
      if (!reported.has(each.path) && under(at, each.path)) {
        reported.add(each.path);
        visitor.marked(each.path, each.className);
      }
  };
  for (const each of state.heard) {
    reportWhole(each.path);
    if (each.kind === "marked") visitor.marked(each.path, each.className);
    else visitor.unmarkedKey?.(each.path, each.key);
  }
  for (const each of whole) if (!reported.has(each.path)) visitor.marked(each.path, each.className);
}

/** Classifications already computed, by schema. A schema is immutable, so its answer never changes. */
const classified = new WeakMap<z.ZodType, readonly PrivacyField[]>();

/**
 * Every marked path in a schema and its class, in one pass — the Art. 30 record for one object, derived rather
 * than maintained. Empty for a schema with no markers. A path reached twice (two union options naming the same
 * field) is listed once.
 */
export function classifyPrivacy(schema: z.ZodType): PrivacyField[] {
  const cached = classified.get(schema);
  if (cached) return [...cached];
  const found: PrivacyField[] = [];
  walkPrivacy(schema, { marked: (path, className) => found.push({ path, class: className }) });
  const seen = new Set<string>();
  const unique = found.filter((field) => {
    const key = `${field.path}\u0000${field.class}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  classified.set(schema, unique);
  return [...unique];
}

/** Whether a schema holds a field of `className` at any depth — the cheap boolean a route or a guard branches on. */
export function hasPrivacy(schema: z.ZodType, className: string): boolean {
  return classifyPrivacy(schema).some((field) => field.class === className);
}
