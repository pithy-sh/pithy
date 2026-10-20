// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { PRIVACY_META_KEY } from "./classes";

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
 * Object keys join with `.`, an array element is `[]`, a tuple position is `[i]`, a record's value is `*`:
 * `address.line1`, `devices[].token`, `pair[1]`, `notes.*`. A marked root is the empty path.
 *
 * ## What the walk steps into, and what it does not
 *
 * **A codec is stepped into on its app side.** `sqliteJson(Profile)` stores `Profile` in a column, so a marked
 * field inside it is a marked field the table holds. A codec field marked as a whole — `pii(SQLiteDate)` — is
 * read off the codec itself before anything is stepped into. A plain pipe is stepped into on both sides.
 *
 * **A lazy schema is not followed.** It is how a recursive schema is written, and following its getter is how a
 * walk over one never returns. A marker that lives only behind a `z.lazy` is therefore not classified, and the
 * inventory says which sources it walked rather than implying it walked everything.
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
  valueType?: z.ZodType;
  in?: z.ZodType;
  out?: z.ZodType;
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

/** Walk one node, appending each marked path it holds. */
function walk(schema: z.ZodType, path: string, out: PrivacyField[]): void {
  const marked = privacyOf(schema);
  if (marked !== null) {
    out.push({ path, class: marked });
    return;
  }
  let node: z.ZodType = schema;
  for (let inner = unwrapOnce(node); inner; inner = unwrapOnce(node)) node = inner;
  const def = defOf(node);
  switch (def.type) {
    case "object":
      for (const [key, field] of Object.entries((node as z.ZodObject).shape))
        walk(field as z.ZodType, join(path, key), out);
      return;
    case "array":
      if (def.element) walk(def.element, `${path}[]`, out);
      return;
    case "set":
      if (def.valueType) walk(def.valueType, `${path}[]`, out);
      return;
    case "tuple":
      for (const [index, item] of (def.items ?? []).entries()) walk(item, `${path}[${index}]`, out);
      if (def.rest) walk(def.rest, `${path}[]`, out);
      return;
    case "record":
    case "map":
      if (def.valueType) walk(def.valueType, join(path, "*"), out);
      return;
    case "union":
      for (const option of def.options ?? []) walk(option, path, out);
      return;
    case "intersection":
      if (def.left) walk(def.left, path, out);
      if (def.right) walk(def.right, path, out);
      return;
    case "pipe":
      // A codec's app side is what the field holds; a plain pipe may carry a marker on either side.
      if (node instanceof z.ZodCodec) {
        if (def.out) walk(def.out, path, out);
        return;
      }
      if (def.in) walk(def.in, path, out);
      if (def.out) walk(def.out, path, out);
      return;
    default:
      // A leaf, a lazy schema, or a kind with no schema inside it. See the module note on `lazy`.
      return;
  }
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
  walk(schema, "", found);
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
