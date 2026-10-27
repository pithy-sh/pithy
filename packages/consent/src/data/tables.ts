// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { createDatabase, type DatabaseSchema } from "@pithy-sh/core/src/data/db";
import type { Kysely } from "kysely";
import { ConsentDocument, ConsentMerge, ConsentRecord } from "./record";

/**
 * The consent capability's tables, in the app `DB`. Table names are camelCase constants; core's `createDatabase`
 * installs the mandatory `CamelCasePlugin`, so query code never types the snake_case `pithy_consent_*` names.
 */
export const consentTables = {
  pithyConsentRecords: ConsentRecord,
  pithyConsentDocuments: ConsentDocument,
  pithyConsentMerges: ConsentMerge,
} as const;
export type ConsentTables = typeof consentTables;

/**
 * Every table here is the record an auditor reads, so none is dropped by a `down` while it holds rows unless the
 * rows are counted first (#588). The records are append-only by trigger as well; this guards the schema around them.
 */
export const consentRetainedTables = [
  "pithyConsentRecords",
  "pithyConsentDocuments",
  "pithyConsentMerges",
] as const satisfies readonly (keyof ConsentTables)[];

/** The typed Kysely database over the consent tables. */
export type ConsentDatabase = Kysely<DatabaseSchema<ConsentTables>>;

/** Build the consent database from the app `DB` binding (CamelCasePlugin installed). */
export function consentDatabase(d1: D1Database): ConsentDatabase {
  return createDatabase(d1, consentTables);
}
