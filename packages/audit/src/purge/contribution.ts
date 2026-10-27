// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import { personRowsExport } from "@pithy-sh/core/src/capability/personRows";
import type { RetainingPurgeContribution } from "@pithy-sh/core/src/capability/purge";
import { AuditEventRow } from "../data/auditEvent";

/**
 * What a person's purge means for `@pithy-sh/audit` (#814): **nothing is erased, and the export says so and why.**
 *
 * The audit trail is the record of who acted — who signed in, who changed a role, who deleted an organization — and
 * it is what a security review or a dispute is read against. A trail that forgot an actor on request would answer
 * neither, so this contribution **retains**: the purge records the step as retained with the basis below and erases
 * no event, and the export answers for every event where the person is the actor.
 *
 * Events are written through `emit`, whose metadata is held to `Loggable` — no token, no secret reaches a row — so
 * the export carries each event whole.
 */

/** The one sentence the purge records with this step. */
export const AUDIT_PURGE_SUMMARY = "Keeps every audit event where the user is the actor.";

/** Why, in the sentence the person is told. */
export const AUDIT_RETENTION_BASIS =
  "Kept as the record of who did what, which a security review or a dispute is read against.";

/** The user contribution `audit()` declares, over the D1 binding its config names. */
export function auditUserPurge(database = "DB"): RetainingPurgeContribution {
  return {
    subject: "user",
    summary: AUDIT_PURGE_SUMMARY,
    retain: { basis: AUDIT_RETENTION_BASIS },
    export: personRowsExport({
      capability: "audit",
      database,
      tables: [{ table: "pithyAuditEvents", schema: AuditEventRow, columns: ["actorId"], as: "events", orderBy: "id" }],
    }),
  };
}
