// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { CamelCasePlugin, type Generated, Kysely } from "kysely";
import { D1Dialect } from "kysely-d1";
import type { z } from "zod";
import { guardBoundParameters } from "./boundParameters";

/**
 * The Kysely D1 database builder.
 *
 * One master map of table name → Zod table schema is the whole database
 * definition. The database interface Kysely sees is derived from each schema's
 * `z.input` side — the SQLite row shape — never a hand-written row interface.
 * `CamelCasePlugin` is mandatory: tables use snake_case columns, query code
 * uses camelCase, and the plugin bridges the two in both directions.
 */

/** A master map of table name → that table's Zod schema. */
export type SchemaMap = Record<string, z.ZodType>;

/**
 * Present a numeric `id` to Kysely as `Generated<number>`: optional on insert
 * (D1 assigns it), a number on select. A table without a numeric `id` is left
 * unchanged. Externally-exposed entities use a text id and so are untouched.
 */
export type WithGeneratedId<Row> = Row extends { id: number } ? Omit<Row, "id"> & { id: Generated<number> } : Row;

/** The Kysely database interface derived from a schema map's `z.input` (row) side. */
export type DatabaseSchema<M extends SchemaMap> = {
  [K in keyof M]: WithGeneratedId<z.input<M[K]>>;
};

/**
 * Build a typed Kysely instance over D1 for `map`. The `map` argument carries
 * the table types — it drives inference of the database interface; Kysely needs
 * no values from it at runtime. `CamelCasePlugin` is always installed.
 *
 * So is `guardBoundParameters`. This is the one seam every Kysely instance in
 * the repository comes from, so it is the one place the bound-parameter ceiling
 * can be stated for all of them — including for query sites that have never
 * heard of it. Five capabilities bound past the cap while the arithmetic to
 * avoid it sat unimported in `boundParameters.ts` (#246, #250); a rule that
 * every call site has to remember is a rule in the wrong place.
 */
export function createDatabase<M extends SchemaMap>(d1: D1Database, map: M): Kysely<DatabaseSchema<M>> {
  void map; // type-only carrier; see doc comment
  return new Kysely<DatabaseSchema<M>>({
    dialect: new D1Dialect({ database: guardBoundParameters(d1) }),
    plugins: [new CamelCasePlugin()],
  });
}
