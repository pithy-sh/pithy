// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { InternalError } from "../error/pithyError";

/**
 * **CLAUDE.md §Zod, made executable: the schemas are the documentation.**
 *
 * Every object, enum and union carries a `.describe()`, and so does every field of every object. The
 * rule is stated once in `CLAUDE.md` and enforced nineteen times — once per package that declares a
 * schema — and until #351 each of those nineteen enforcements was a private copy of the walk. They
 * drifted, as copies do: three demanded a description on the field exactly as written, fifteen walked
 * the wrapper chain to find one, one stepped through a `pipe` and eighteen did not, and exactly one
 * (`@pithy-sh/audit`, #326) descended into an `array` — the shape that hides an undescribed object.
 * A package's coverage was decided by which copy it inherited.
 *
 * This is that walk, once, in the package every other one already depends on. It is deliberately not
 * test-only code: an adopter declaring capability config of their own is held to the same rule by the
 * same CLI surfaces that read these descriptions, so the check belongs where they can reach it.
 *
 * ## This folder
 *
 * `src/schema/` reasons *about* Zod schemas. It is not a drawer to declare them in — §"group by
 * concern, not by artifact kind" forbids that, and a schema belongs beside the thing it describes.
 */

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

/** The kind tag Zod puts on a schema's definition. */
function kindOf(schema: z.ZodType): string {
  return (schema as unknown as { def: Def }).def.type;
}

/**
 * Kinds with no schema inside them. **Listed, so that anything not listed is a hole rather than a
 * leaf** — that is the whole difference between a walk that can report and one that quietly cannot.
 */
const LEAVES: ReadonlySet<string> = new Set([
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
  // Cyclic by construction. Following the getter is how a walk over a recursive schema never returns.
  "lazy",
]);

/**
 * Wrappers that describe **the same documented thing** as what they wrap.
 *
 * `TenantFilter.optional().describe("…")` and `TenantFilter.describe("…").optional()` are one described
 * field written two ways, and Zod's `.description` sits on whichever came last. A walk that demanded a
 * description at both depths would report a field that is documented, which is how a gate gets deleted
 * rather than obeyed — so a description is carried *inward* by {@link collectMissing} and looked for
 * *outward* by {@link describedInChain}, and both directions are asserted.
 *
 * An `array` is deliberately not on this list: describing a list says nothing about the shape of its
 * elements, and an undescribed object inside an array is the gap this walk was deepened to find.
 */
const TRANSPARENT: ReadonlySet<string> = new Set([
  "optional",
  "nullable",
  "default",
  "prefault",
  "readonly",
  "catch",
  "nonoptional",
]);

/**
 * The children of one schema, by kind. **Throws for a kind this walk has never been taught** — a
 * walker whose unknown case is silently empty cannot report the thing it exists to report.
 *
 * A `pipe` is stepped through; a **codec** is not. This gate reads the schema tree, so wrapping an
 * object in a guard — `refusesVanishingKey`, and anything else that pipes into a schema — would turn
 * an export it checks into an export it silently skips, and losing coverage as a side effect of adding
 * a guard is the wrong direction. A codec is the §Zod exemption spelled as a type rather than as an
 * accident: `z.codec` builds a `ZodCodec`, so the exemption names codec helpers and nothing else.
 * Measured in #326 — stepping through codecs too reports seven fields whose union sides carry no
 * description, every one of them a `SQLiteDate` or a `sqliteJson`.
 */
export function childSchemas(schema: z.ZodType, path: string): z.ZodType[] {
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
    case "pipe":
      if (schema instanceof z.ZodCodec) return [];
      return [(schema as unknown as { in: z.ZodType }).in, (schema as unknown as { out: z.ZodType }).out];
    default:
      if (LEAVES.has(def.type)) return [];
      throw new InternalError({
        message: "A schema kind this walk has never been taught was reached.",
        action: `Add "${def.type}" to the switch in @pithy-sh/core/src/schema/describedness, or to its LEAVES.`,
        detail: `${path}: unknown Zod kind "${def.type}". A kind silently treated as a leaf is a schema nothing is holding to CLAUDE.md §Zod.`,
      });
  }
}

/**
 * Whether a description sits anywhere in a field's transparent-wrapper chain.
 *
 * `.describe("…").optional()` puts it on the inner type and `.optional().describe("…")` puts it on the
 * wrapper. Both are one described field. Only {@link TRANSPARENT} wrappers are followed — an `array`
 * or a `pipe` describes something other than what it holds.
 */
export function describedInChain(schema: z.ZodType): boolean {
  let current: z.ZodType | undefined = schema;
  const seen = new Set<z.ZodType>();
  while (current && !seen.has(current)) {
    if (current.description) return true;
    if (!TRANSPARENT.has(kindOf(current))) return false;
    seen.add(current);
    current = (current as unknown as { def?: { innerType?: z.ZodType } }).def?.innerType;
  }
  return false;
}

/** What one walk found: the complaints, and how much it actually looked at. */
export interface SchemaWalk {
  /** One line per object, enum, union or field with no `.describe()` anywhere that documents it. */
  missing: string[];
  /** Every field of every object reached, so an empty walk is visible as an empty walk. */
  fields: number;
}

/**
 * Record any object/enum/union missing a `.describe()` — on the schema itself or on any of its
 * fields — following every container Zod has. Codec-helper primitives are exempt (CLAUDE.md §Zod) and
 * are not objects/enums/unions, so they are skipped.
 *
 * `described` carries a transparent wrapper's own description inward; see {@link TRANSPARENT}.
 */
export function collectMissing(
  schema: z.ZodType,
  path: string,
  walk: SchemaWalk,
  seen: Set<z.ZodType>,
  described = false,
): void {
  if (seen.has(schema)) return;
  seen.add(schema);
  const kind = kindOf(schema);
  const documented = described || describedInChain(schema);
  if (kind === "object") {
    if (!documented) walk.missing.push(`${path} — object has no .describe()`);
    for (const [key, field] of Object.entries((schema as unknown as z.ZodObject).shape)) {
      const fieldSchema = field as z.ZodType;
      walk.fields += 1;
      if (!describedInChain(fieldSchema)) walk.missing.push(`${path}.${key} — field has no .describe()`);
      collectMissing(fieldSchema, `${path}.${key}`, walk, seen);
    }
    return;
  }
  if ((kind === "union" || kind === "enum") && !documented) {
    walk.missing.push(`${path} — enum/union has no .describe()`);
  }
  const inherited = TRANSPARENT.has(kind) && documented;
  for (const [index, child] of childSchemas(schema, path).entries()) {
    collectMissing(child, `${path}[${kind}:${index}]`, walk, seen, inherited);
  }
}

/** One schema, walked. The entry point a unit test reaches for. */
export function undescribed(schema: z.ZodType, path = "schema"): SchemaWalk {
  const walk: SchemaWalk = { missing: [], fields: 0 };
  collectMissing(schema, path, walk, new Set());
  return walk;
}

/** What a package-wide sweep found, including the size of the population it swept. */
export interface ExportWalk extends SchemaWalk {
  /** Modules the glob handed over. Zero is a broken pattern, not a clean package. */
  modules: number;
  /** Exports that resolved to a Zod schema. */
  schemas: number;
}

/**
 * Every exported Zod schema in a package, walked.
 *
 * Takes the result of `import.meta.glob([...], { eager: true })`. The counts come back with the
 * findings **because a sweep that found nothing and a sweep that looked at nothing are the same green
 * run otherwise** — the caller pins all three against literals of its own.
 */
export function undescribedExports(modules: Record<string, Record<string, unknown>>): ExportWalk {
  const walk: SchemaWalk = { missing: [], fields: 0 };
  const seen = new Set<z.ZodType>();
  let schemas = 0;
  for (const [file, mod] of Object.entries(modules)) {
    for (const [name, value] of Object.entries(mod)) {
      if (!(value instanceof z.ZodType)) continue;
      schemas += 1;
      collectMissing(value, `${file}:${name}`, walk, seen);
    }
  }
  return { ...walk, modules: Object.keys(modules).length, schemas };
}
