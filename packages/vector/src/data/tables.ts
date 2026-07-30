// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { createDatabase, type DatabaseSchema } from "@pithy-sh/core/src/data/db";
import type { Kysely } from "kysely";
import type { z } from "zod";
import { VectorDocument } from "./document";

/** The document corpus. `CamelCasePlugin` snake-cases it to `pithy_vector_documents`. */
export const VECTOR_DOCUMENTS_TABLE = "pithyVectorDocuments";

/** The vector tables map. One table: the corpus every index hydrates from and re-embeds out of. */
export function vectorTables(): Record<string, z.ZodObject> {
  return {
    [VECTOR_DOCUMENTS_TABLE]: VectorDocument,
  };
}

/** The typed Kysely database over the vector tables. */
export type VectorTables = {
  [VECTOR_DOCUMENTS_TABLE]: typeof VectorDocument;
};
export type VectorDatabase = Kysely<DatabaseSchema<VectorTables>>;

/** Build the vector database from the `DB` binding (CamelCasePlugin installed). */
export function vectorDatabase(d1: D1Database): VectorDatabase {
  return createDatabase(d1, {
    [VECTOR_DOCUMENTS_TABLE]: VectorDocument,
  }) as unknown as VectorDatabase;
}
