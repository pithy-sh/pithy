// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import type { D1Database } from "@cloudflare/workers-types";
import { createDatabase, type DatabaseSchema } from "@pithy-sh/core/src/data/db";
import type { Kysely } from "kysely";
import { AuditEventRow } from "./auditEvent";

/**
 * The audit capability's table map: camelCase keys (CamelCasePlugin emits the snake_case
 * `pithy_audit_` SQL). One source of truth, shared by the capability wiring (`capability.ts`), the
 * recorder, and the query helper so all three type against the same schema.
 */
export const auditTables = {
  pithyAuditEvents: AuditEventRow,
};
export type AuditTables = typeof auditTables;

/** The typed Kysely view over the audit table — what the recorder and query helper run against. */
export type AuditDatabase = Kysely<DatabaseSchema<AuditTables>>;

/** Build the audit Kysely over a D1 binding (or a REST `D1Database` from `@pithy-sh/cloudflare`). */
export function auditDatabase(d1: D1Database): AuditDatabase {
  return createDatabase(d1, auditTables);
}
