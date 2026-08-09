// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Kysely } from "kysely";
import { z } from "zod";
import { chunkRowsByBoundParameters } from "../data/boundParameters";
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
 * How many parameters one encoded row will bind.
 *
 * The **union** of every row's keys, not the first row's count: Kysely builds one column list for a
 * multi-row insert from every object it was given, so a group whose rows differ binds against the wider
 * list. Over-counting only makes the chunks smaller, which is always safe; under-counting is the bug.
 *
 * A row that is not an object cannot be an insert record at all, and Kysely will say so far more
 * usefully than an arithmetic helper would — so it is counted as one parameter and left to fail there.
 */
function columnsPerRow(encoded: readonly unknown[]): number {
  const columns = new Set<string>();
  for (const row of encoded) {
    if (typeof row !== "object" || row === null) return 1;
    for (const key of Object.keys(row)) columns.add(key);
  }
  return Math.max(columns.size, 1);
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
 * **The group is written in chunks sized against D1's bound-parameter ceiling, and that belongs here
 * rather than at any call site.** An insert binds one parameter per column per row, so a group's real
 * limit is `100 / columns` — around fifteen rows for a seven-column table — and it moves with the
 * table. Every fixture the kit ships is 2–6 rows, which is why the single unbatched insert survived: it
 * only breaks on a fixture big enough to do the job fixtures exist for, and `DEFAULT_PAGE_SIZE` is 25,
 * so anything proving a paged list crosses the limit by construction. `pithy-sh/dashboard` hit it on
 * its first realistic seed and worked around it by splitting fourteen tables into twenty-nine groups by
 * hand. A rule that every adopter re-derives after a confusing `too many SQL variables` is a rule in
 * the wrong place; the size is derived from the row's own column count, never guessed.
 *
 * Chunks are written in sequence, and a group is deliberately not atomic across them. `INSERT OR
 * IGNORE` makes a partial run safe to re-run — the landed chunks collide and are ignored — which is the
 * same property that makes seeding re-runnable at all.
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

  for (const chunk of chunkRowsByBoundParameters(encoded, columnsPerRow(encoded))) {
    await db
      .insertInto(group.table)
      .orIgnore()
      .values(chunk as never)
      .execute();
  }
  return { table: group.table, rows: encoded.length };
}
