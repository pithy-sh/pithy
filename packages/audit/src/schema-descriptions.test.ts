// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import { describe, expect, test } from "vitest";
import { z } from "zod";

// `import.meta.glob` is a vite/vitest feature; declare it so plain `tsc` typecheck accepts it.
declare global {
  interface ImportMeta {
    glob(patterns: string[], options: { eager: true }): Record<string, Record<string, unknown>>;
  }
}

/**
 * **CLAUDE.md §Zod: the schemas are the documentation.** Every object, enum and union carries a
 * `.describe()`, and so does every field of every object.
 *
 * Eagerly import every source module except tests, so any newly exported schema is covered
 * automatically — there is no manual list to keep in sync. Mirrors core's meta-test.
 *
 * ## Two things this could not observe
 *
 * **It had no anti-vacuity guard.** Sixteen of the nineteen packages carrying this sweep had none: a
 * glob that matched nothing, a `src` that moved, or a build that exported no schema left `missing`
 * empty and the test green, over nothing. So the population is now pinned — the modules found, the Zod
 * exports found, and the fields actually visited.
 *
 * **It only walked object fields.** `collectMissing` recursed into `ZodObject` shapes and stopped, so
 * an object inside an array, inside an `.optional()`, inside a record or inside a union member was
 * never reached — and those are where the undescribed fields actually accumulate, because a field
 * wrapped in anything at all looks described from the outside. The walk now follows every container
 * Zod has, and **a kind it does not recognise throws** rather than being treated as a leaf: a walker
 * whose unknown case is silently empty cannot report the thing it exists to report.
 */
const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"], { eager: true });

/** A Zod schema's internal definition, as much of it as this walk reads. */
interface Def {
  type: string;
  element?: unknown;
  innerType?: unknown;
  options?: unknown[];
  valueType?: unknown;
  keyType?: unknown;
  items?: unknown[];
  rest?: unknown;
  left?: unknown;
  right?: unknown;
}

/**
 * Kinds with no schema inside them. **Listed, so that anything not listed is a hole rather than a
 * leaf** — that is the whole difference between a walk that can report and one that quietly cannot.
 */
const LEAVES = new Set([
  "string",
  "number",
  "int",
  "bigint",
  "boolean",
  "date",
  "symbol",
  "undefined",
  "null",
  "void",
  "any",
  "unknown",
  "never",
  "nan",
  "literal",
  "enum",
  "file",
  "template_literal",
  "custom",
  "transform",
  "function",
  "promise",
  // A codec is a `pipe` of two schemas. CLAUDE.md exempts the codec-helper primitives from the
  // description rule — `SQLiteBoolean` and friends are conversions, not documented shapes — so the walk
  // stops at one rather than reporting the halves it is made of.
  "pipe",
  // Cyclic by construction. Following the getter is how a walk over a recursive schema never returns.
  "lazy",
]);

/** The children of one schema, by kind. Throws for a kind this walk has never been taught. */
function children(schema: z.ZodType, path: string): z.ZodType[] {
  const def = (schema as unknown as { def: Def }).def;
  switch (def.type) {
    case "object":
      return Object.values((schema as unknown as z.ZodObject).shape) as z.ZodType[];
    case "array":
      return [def.element as z.ZodType];
    case "optional":
    case "nullable":
    case "default":
    case "prefault":
    case "readonly":
    case "catch":
    case "nonoptional":
    case "success":
      return [def.innerType as z.ZodType];
    case "union":
      return (def.options ?? []) as z.ZodType[];
    case "intersection":
      return [def.left as z.ZodType, def.right as z.ZodType];
    case "tuple":
      return [...((def.items ?? []) as z.ZodType[]), ...(def.rest ? [def.rest as z.ZodType] : [])];
    case "record":
    case "map":
      return [def.keyType as z.ZodType, def.valueType as z.ZodType].filter(Boolean);
    case "set":
      return [def.valueType as z.ZodType];
    default:
      if (LEAVES.has(def.type)) return [];
      throw new Error(
        `${path}: this walk has never been taught the Zod kind "${def.type}". Add it to the switch or to LEAVES — a kind it silently treats as a leaf is a schema nothing is holding to CLAUDE.md §Zod.`,
      );
  }
}

/**
 * Wrappers that describe **the same documented thing** as what they wrap.
 *
 * `TenantFilter.optional().describe("…")` and `TenantFilter.describe("…").optional()` are one described
 * field written two ways, and Zod's `.description` sits on whichever came last. A walk that demanded a
 * description at both depths would report a field that is documented, which is how a gate gets deleted
 * rather than obeyed. An `array` is deliberately not on this list: describing a list says nothing about
 * the shape of its elements, and an undescribed object inside an array is the gap this walk was
 * deepened to find.
 */
const TRANSPARENT = new Set(["optional", "nullable", "default", "prefault", "readonly", "catch", "nonoptional"]);

/** What one walk found: the complaints, and how much it actually looked at. */
interface Walk {
  missing: string[];
  /** Every field of every object reached, so an empty walk is visible as an empty walk. */
  fields: number;
}

/**
 * Record any object/enum/union missing a `.describe()` — on the schema itself or on any of its
 * fields — following every container Zod has. Codec-helper primitives are exempt (CLAUDE.md §Zod)
 * and aren't objects/enums/unions, so they're skipped.
 *
 * `described` carries a transparent wrapper's own description inward; see {@link TRANSPARENT}.
 */
function collectMissing(schema: z.ZodType, path: string, walk: Walk, seen: Set<z.ZodType>, described = false): void {
  if (seen.has(schema)) return;
  seen.add(schema);
  const kind = (schema as unknown as { def: Def }).def.type;
  const documented = described || Boolean(schema.description);
  if (kind === "object") {
    if (!documented) walk.missing.push(`${path} — object has no .describe()`);
    for (const [key, field] of Object.entries((schema as unknown as z.ZodObject).shape)) {
      const fieldSchema = field as z.ZodType;
      walk.fields += 1;
      if (!fieldSchema.description) walk.missing.push(`${path}.${key} — field has no .describe()`);
      collectMissing(fieldSchema, `${path}.${key}`, walk, seen);
    }
    return;
  }
  if ((kind === "union" || kind === "enum") && !documented) {
    walk.missing.push(`${path} — enum/union has no .describe()`);
  }
  const inherited = TRANSPARENT.has(kind) && documented;
  for (const [index, child] of children(schema, path).entries()) {
    collectMissing(child, `${path}[${kind}:${index}]`, walk, seen, inherited);
  }
}

/** Every exported Zod schema in the package, walked. */
function walkExports(): Walk & { schemas: number } {
  const walk: Walk = { missing: [], fields: 0 };
  const seen = new Set<z.ZodType>();
  let schemas = 0;
  for (const [file, mod] of Object.entries(modules)) {
    for (const [name, value] of Object.entries(mod)) {
      if (!(value instanceof z.ZodType)) continue;
      schemas += 1;
      collectMissing(value, `${file}:${name}`, walk, seen);
    }
  }
  return { ...walk, schemas };
}

describe("schema descriptions (CLAUDE.md §Zod: schemas are the docs)", () => {
  test("the sweep is looking at the package, not at nothing", () => {
    // The guard sixteen of nineteen of these files did without. Near-exact rather than a floor: audit
    // holds 19 non-test modules as this is written, and a glob returning 2 of them would be green while
    // checking a twentieth of the package.
    expect(Object.keys(modules).length).toBeGreaterThanOrEqual(18);
    const walk = walkExports();
    // Exports really resolved to schemas, and the walk really descended into them. `> 0` on each would
    // be satisfied by one schema with one field; these are the real numbers, so a collapse is loud.
    expect(walk.schemas).toBeGreaterThanOrEqual(10);
    expect(walk.fields).toBeGreaterThanOrEqual(40);
  });

  test("every exported object/enum/union — and every field — carries a .describe()", () => {
    const walk = walkExports();
    expect(walk.missing, walk.missing.join("\n")).toEqual([]);
  });

  test("the walk reaches through a container, and refuses a kind it does not know", () => {
    // The gate over the gate. `collectMissing` stopping at a wrapper is a field it cannot report, and
    // that was the state of all nineteen of these files: an undescribed object one `.optional()` deep
    // was invisible. Each line below is a container the old walk stopped at.
    const walk = (schema: z.ZodType): string[] => {
      const found: Walk = { missing: [], fields: 0 };
      collectMissing(schema, "sample", found, new Set());
      return found.missing;
    };
    expect(walk(z.array(z.object({ a: z.string() })))).toEqual([
      "sample[array:0] — object has no .describe()",
      "sample[array:0].a — field has no .describe()",
    ]);
    expect(
      walk(
        z
          .object({ a: z.string().describe("d") })
          .describe("d")
          .optional(),
      ),
    ).toEqual([]);
    expect(walk(z.record(z.string(), z.object({ a: z.string() })).describe("d"))).toHaveLength(2);
    expect(walk(z.union([z.object({ a: z.string() })]).describe("d"))).toHaveLength(2);
    expect(walk(z.tuple([z.object({ a: z.string() })]))).toHaveLength(2);
    // A transparent wrapper carrying the description documents what it wraps, whichever order they were
    // written in — but it says nothing about a field one level further down.
    expect(
      walk(
        z
          .union([z.string(), z.literal("")])
          .optional()
          .describe("d"),
      ),
    ).toEqual([]);
    expect(walk(z.object({ a: z.string() }).optional().describe("d"))).toEqual([
      "sample[optional:0].a — field has no .describe()",
    ]);
    // And an array is not transparent: describing the list does not describe the thing in it.
    expect(walk(z.array(z.object({ a: z.string().describe("d") })).describe("d"))).toEqual([
      "sample[array:0] — object has no .describe()",
    ]);
    // And the kind it has never met throws rather than passing as a leaf.
    const alien = { def: { type: "quantum" } } as unknown as z.ZodType;
    expect(() => children(alien, "sample")).toThrow(/never been taught/);
  });
});
