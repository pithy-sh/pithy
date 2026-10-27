// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import type { D1Database } from "@cloudflare/workers-types";
import { createDatabase, type DatabaseSchema } from "@pithy-sh/core/src/data/db";
import type { Insertable, Kysely } from "kysely";
import { AuditEventRow } from "./auditEvent";
import { AuditSinkStateRow } from "./sinkState";

/**
 * The audit capability's table map: camelCase keys (CamelCasePlugin emits the snake_case
 * `pithy_audit_` SQL). One source of truth, shared by the capability wiring (`capability.ts`), the
 * recorder, and the query helper so all three type against the same schema.
 */
export const auditTables = {
  pithyAuditEvents: AuditEventRow,
  // Shipping's delivery state, one row per declared sink (#824).
  pithyAuditSinks: AuditSinkStateRow,
};
export type AuditTables = typeof auditTables;

/** The typed Kysely view over the audit table — what the recorder and query helper run against. */
export type AuditDatabase = Kysely<DatabaseSchema<AuditTables>>;

/** One row as the recorder inserts it — the `z.input` side, every column it may name. */
export type AuditEventInsert = Insertable<DatabaseSchema<AuditTables>["pithyAuditEvents"]>;

/** Build the audit Kysely over a D1 binding (or a REST `D1Database` from `@pithy-sh/cloudflare`). */
export function auditDatabase(d1: D1Database): AuditDatabase {
  return createDatabase(d1, auditTables);
}
