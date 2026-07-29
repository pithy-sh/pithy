import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { z } from "zod";
import { filterKeyProblem, MAX_METADATA_INDEXES } from "./limits";

/**
 * One introspection pass over an index's metadata schema, two outputs: the metadata indexes to provision, and
 * — via `index/filter.ts` — the shape of the filters the index can answer. They come from the same source
 * because they must agree. Cloudflare states it verbatim:
 *
 * > "Vectors upserted before a metadata index was created won't have their metadata contained in that index."
 *
 * Filtering on a field indexed late does **not** error. It silently returns partial results: every vector
 * written before the index existed simply fails to match. Combined with a hard ceiling of ten metadata indexes
 * per index, that makes filterability a provisioning-time decision wearing the costume of a query-time one. A
 * thin wrapper over the binding cannot remove that footgun. Declaring it in the schema can, because then one
 * declaration drives provisioning, the filter type, the drift check `pithy vector provision` runs against the
 * live index, and the boot check the Worker runs against what that command recorded.
 *
 * The marker is Zod 4's `.meta({ filterable: true })`, beside the field's mandatory `.describe()`. `.meta()`
 * merges rather than replaces, in either order, so a field carries both.
 */

/** The value type of an indexed metadata property. Vectorize indexes these three and nothing else. */
export const MetadataIndexType = z
  .enum(["string", "number", "boolean"])
  .describe("The value type of an indexed metadata property, which decides how a filter compares against it.");
export type MetadataIndexType = z.infer<typeof MetadataIndexType>;

/** One metadata index to provision on a Vectorize index — a property name and the type it is indexed as. */
export const MetadataIndexDescriptor = z
  .object({
    propertyName: z.string().min(1).describe("The metadata property this index covers, as named in the schema."),
    indexType: MetadataIndexType.describe("How Vectorize stores and compares this property's values."),
  })
  .describe("One metadata index derived from a field marked filterable in an index's metadata schema.");
export type MetadataIndexDescriptor = z.infer<typeof MetadataIndexDescriptor>;

/** The result of one introspection pass: what to provision, and every reason the schema is not provisionable. */
export interface MetadataIntrospection {
  /** The metadata indexes, in declaration order. Empty when nothing is marked filterable. */
  indexes: MetadataIndexDescriptor[];
  /** Human-readable reasons the schema cannot be honoured. Empty means the schema is good. */
  problems: string[];
}

/** Strip `.optional()`, `.nullable()`, `.default()` and friends down to the type that carries the value. */
function unwrap(schema: z.ZodType): z.ZodType {
  let current: z.ZodType = schema;
  for (;;) {
    const inner = (current as unknown as { def?: { innerType?: z.ZodType } }).def?.innerType;
    if (!inner) return current;
    current = inner;
  }
}

/**
 * Whether a field is marked filterable. The marker is read at every level of the wrapper chain, so
 * `z.string().meta({ filterable: true }).optional()` counts — the wrapper is a different schema object and
 * carries no metadata of its own, and a reader who wrapped a marked field plainly meant to keep the mark.
 */
export function isFilterable(schema: z.ZodType): boolean {
  let current: z.ZodType | undefined = schema;
  while (current) {
    const meta = current.meta() as { filterable?: unknown } | undefined;
    if (meta?.filterable === true) return true;
    current = (current as unknown as { def?: { innerType?: z.ZodType } }).def?.innerType;
  }
  return false;
}

/** The type of every value a `z.enum`/`z.literal` admits, or null when they are not all one indexable type. */
function uniformPrimitiveType(values: readonly unknown[]): MetadataIndexType | null {
  if (values.length === 0) return null;
  const first = typeof values[0];
  if (first !== "string" && first !== "number" && first !== "boolean") return null;
  return values.every((value) => typeof value === first) ? first : null;
}

/** The metadata index type a field maps to, or null when Vectorize cannot index it. */
function indexTypeOf(schema: z.ZodType): MetadataIndexType | null {
  const base = unwrap(schema);
  const def = (base as unknown as { def: { type: string; entries?: Record<string, unknown>; values?: unknown[] } }).def;
  switch (def.type) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    // An enum or a literal is a constrained primitive; index it as whatever primitive it constrains, so a
    // status field declared as an enum is filterable without restating it as a bare string.
    case "enum":
      return uniformPrimitiveType(Object.values(def.entries ?? {}));
    case "literal":
      return uniformPrimitiveType(def.values ?? []);
    default:
      return null;
  }
}

/**
 * Introspect an index's metadata schema. Never throws — it returns every problem it found, so a config parse
 * can report them all as Zod issues at once instead of failing on the first.
 */
export function introspectMetadata(metadata: z.ZodObject): MetadataIntrospection {
  const indexes: MetadataIndexDescriptor[] = [];
  const problems: string[] = [];

  for (const [propertyName, field] of Object.entries(metadata.shape)) {
    const schema = field as z.ZodType;
    if (!isFilterable(schema)) continue;

    const keyProblem = filterKeyProblem(propertyName);
    if (keyProblem) {
      problems.push(`Metadata field ${keyProblem}.`);
      continue;
    }

    const indexType = indexTypeOf(schema);
    if (!indexType) {
      problems.push(
        `Metadata field \`${propertyName}\` is marked filterable but Vectorize cannot index its type. Only strings, numbers, and booleans are indexable.`,
      );
      continue;
    }

    indexes.push({ propertyName, indexType });
  }

  // The eleventh filterable field fails here, at assembly, rather than at provisioning time — where Vectorize
  // would reject it after the first ten already exist, leaving the index half-configured and every filter on
  // the rejected field silently partial.
  if (indexes.length > MAX_METADATA_INDEXES) {
    problems.push(
      `${indexes.length} fields are marked filterable; Vectorize allows ${MAX_METADATA_INDEXES} metadata indexes per index. Drop ${indexes.length - MAX_METADATA_INDEXES}: ${indexes.map((index) => index.propertyName).join(", ")}.`,
    );
  }

  return { indexes, problems };
}

/**
 * The metadata indexes an index's schema declares. Throws on any problem — this is the form provisioning and
 * the drift check call, where a half-usable answer is worse than none.
 */
export function metadataIndexes(metadata: z.ZodObject): MetadataIndexDescriptor[] {
  const { indexes, problems } = introspectMetadata(metadata);
  if (problems.length > 0) {
    throw new ValidationError({
      message: "This index's metadata schema cannot be provisioned.",
      action: "Fix the fields marked filterable in the index's metadata schema, then run `pithy vector provision`.",
      detail: problems.join(" "),
      issues: problems.map((problem) => ({ path: ["metadata"], message: problem, code: "custom" })),
    });
  }
  return indexes;
}
