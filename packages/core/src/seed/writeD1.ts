import type { Kysely } from "kysely";
import { z } from "zod";
import { fromZodError } from "../error/pithyError";
import type { D1SeedGroup } from "./seed";

/** Options for {@link seedD1Group}. */
export interface SeedD1Options {
  /** Validate + count only; perform no write. */
  dryRun?: boolean;
}

/** The outcome of seeding one D1 group. */
export interface SeedD1Result {
  /** The table seeded. */
  table: string;
  /** The number of rows validated (and, unless `dryRun`, written). */
  rows: number;
}

/**
 * Seed one D1 group, idempotently and non-destructively.
 *
 * Every row is `schema.encode(row)`d first — this IS the write-time Zod validation boundary. An
 * invalid fixture throws a `ValidationError` (a `ZodError` mapped via `fromZodError`) **before any
 * write for this group**, so a partial group never lands. The insert is `INSERT OR IGNORE`
 * (`orIgnore`), so re-running seeds writes no duplicate rows and never overwrites existing data. The
 * table's row schema is resolved by the caller from the composed databases registry and passed in —
 * the fixture never redeclares it.
 *
 * `dryRun` validates and counts but writes nothing.
 */
export async function seedD1Group(
  // biome-ignore lint/suspicious/noExplicitAny: the group's table is a runtime string, so the DB is the erased row universe; the row schema validates the fixture.
  db: Kysely<any>,
  group: D1SeedGroup,
  schema: z.ZodType,
  options: SeedD1Options = {},
): Promise<SeedD1Result> {
  const encoded = group.rows.map((row, index) => {
    try {
      return schema.encode(row);
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw fromZodError(error, {
          message: `Invalid seed row for table "${group.table}".`,
          action: "Fix the fixture so every field matches the table schema.",
          detail: `Row ${index} for database "${group.database}" table "${group.table}" failed encode validation.`,
        });
      }
      throw error;
    }
  });

  if (options.dryRun || encoded.length === 0) {
    return { table: group.table, rows: encoded.length };
  }

  await db
    .insertInto(group.table)
    .orIgnore()
    .values(encoded as never)
    .execute();
  return { table: group.table, rows: encoded.length };
}
