import type { z } from "zod";
import { MediaAsset } from "./mediaAsset";

/**
 * The adopter-extension mechanism, and the single reason one Zod schema can persist to either record
 * store. An adopter extends a media type by passing a `z.ZodObject` of extra fields to `media({ extend })`
 * — an owning `userId`, a tenant id, tags. From that one schema the mapping layer derives everything:
 *
 *   - D1: {@link extensionColumns} turns each field into a real column (type + nullability), which the
 *     generated `0002_extend` migration adds to `pithy_media_assets`; the effective schema then reads and
 *     writes those columns through the same codecs as the base fields.
 *   - KV: the effective schema validates the extra fields as part of the stored value — no columns, no
 *     migration, no backend-specific work.
 *
 * The base fields are always guaranteed; an extension field that collides with a base column name is
 * ignored, so an adopter can never redefine or drop a base field.
 */

/** A derived SQLite column: its affinity and whether the source field is required. */
export interface SqliteColumn {
  /** The SQLite storage affinity — `text` for strings/JSON, `integer` for numbers/booleans/dates. */
  type: "text" | "integer";
  /** Whether the column is `NOT NULL` — false when the field is optional, nullable, or nullish. */
  notNull: boolean;
}

/** A derived column plus its (camelCase) name, for the extension migration. */
export interface ExtensionColumn extends SqliteColumn {
  /** The column name — the extension field's key. `CamelCasePlugin` snake-cases it in the DDL. */
  name: string;
}

interface ZodInternal {
  def?: { type?: string; innerType?: z.ZodType; out?: z.ZodType };
}

/** Read a schema's internal def, tolerating both the `_zod.def` and `.def` shapes across Zod builds. */
function defOf(schema: z.ZodType): ZodInternal["def"] {
  const internal = schema as unknown as { _zod?: ZodInternal } & ZodInternal;
  return internal._zod?.def ?? internal.def;
}

/** Unwrap `optional` / `nullable` / `default` wrappers to the underlying schema, tracking nullability. */
function unwrap(schema: z.ZodType): { inner: z.ZodType; notNull: boolean } {
  let current = schema;
  let notNull = true;
  // A wrapper nests its target under `def.innerType`; walk until we reach a concrete type.
  for (let guard = 0; guard < 16; guard++) {
    const def = defOf(current);
    const kind = def?.type;
    if ((kind === "optional" || kind === "nullable" || kind === "default") && def?.innerType) {
      if (kind !== "default") notNull = false;
      current = def.innerType;
    } else {
      break;
    }
  }
  return { inner: current, notNull };
}

/** Map a concrete (unwrapped) schema — primitive or codec — to a SQLite affinity. */
function affinityOf(schema: z.ZodType): "text" | "integer" {
  const def = defOf(schema);
  // A codec is a `pipe`; its stored form follows the OUTPUT type (a date/boolean stores as a number,
  // a JSON payload stores as a string).
  const target = def?.type === "pipe" && def.out ? defOf(def.out)?.type : def?.type;
  switch (target) {
    case "number":
    case "boolean":
    case "date":
    case "bigint":
      return "integer";
    default:
      return "text";
  }
}

/** Derive the SQLite column (affinity + nullability) a single extension field maps to. */
export function sqliteColumnType(schema: z.ZodType): SqliteColumn {
  const { inner, notNull } = unwrap(schema);
  return { type: affinityOf(inner), notNull };
}

/**
 * The base column names. An extension may not redefine them, and the create handler treats any body key
 * that IS a base column as server-owned — never an extension field — so a client cannot smuggle a base
 * field (id, status, storageKey, …) in through the extension bag.
 */
export const BASE_COLUMN_NAMES: ReadonlySet<string> = new Set(Object.keys(MediaAsset.shape));

/**
 * A nullable D1 column returns SQLite NULL when a record omitted the field, so its schema must accept
 * null on read. A plain `.optional()` field (undefined-only) would throw on that null, breaking every D1
 * read of a record that omitted it. Widen such a field to also accept null (`.nullable()`), keeping the
 * D1 and KV paths in agreement — a not-null column is left untouched.
 */
function reconcileNullability(field: z.ZodType): z.ZodType {
  const { notNull } = sqliteColumnType(field);
  if (notNull) return field;
  // Already accepts null? (a `.nullable()`/`.nullish()` field parses null fine) — leave it. Otherwise
  // wrap so a stored NULL round-trips. `.nullable()` composes with an existing `.optional()`.
  return field.safeParse(null).success ? field : field.nullable();
}

/**
 * The effective record schema: the base {@link MediaAsset} with the adopter's extension fields merged in.
 * Returns the base schema unchanged when no extension is given, so the common case allocates nothing.
 */
export function extendMediaAsset(extension?: z.ZodObject): z.ZodObject {
  if (!extension) return MediaAsset;
  // The base owns its columns — drop any colliding extension key before merging so a base field can
  // never be redefined or weakened. Reconcile each remaining field's nullability with its D1 column.
  const extra: Record<string, z.ZodType> = {};
  for (const [key, field] of Object.entries(extension.shape)) {
    if (!BASE_COLUMN_NAMES.has(key)) extra[key] = reconcileNullability(field as z.ZodType);
  }
  return MediaAsset.extend(extra);
}

/**
 * The columns the `0002_extend` migration must add for `extension`, one per non-colliding field, in
 * declaration order. Empty when no extension is given.
 */
export function extensionColumns(extension?: z.ZodObject): ExtensionColumn[] {
  if (!extension) return [];
  const columns: ExtensionColumn[] = [];
  for (const [name, field] of Object.entries(extension.shape)) {
    if (BASE_COLUMN_NAMES.has(name)) continue;
    columns.push({ name, ...sqliteColumnType(field as z.ZodType) });
  }
  return columns;
}
