// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import type { D1Database } from "@cloudflare/workers-types";
import type { AuditCitation, AuditCitationReader } from "@pithy-sh/core/src/audit/citations";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { AuditEventRow } from "./data/auditEvent";
import { type AuditDatabase, auditDatabase } from "./data/tables";

/**
 * **Citing the trail (#823)** — the reader core's `composedAuditCitations` finds, so the control plane's erasure
 * attestation can point at the events a purge wrote by id and chain position, and import nothing from here.
 *
 * It hands back where an event is, never what it holds: no IP, no user-agent, and of the metadata only a `step`
 * name, which is how a purge step's event says which step it records. A row written before the chain began has no
 * position, and says so with `null` rather than a guess.
 */

/** The reader over one audit database. */
export function auditCitationReader(db: AuditDatabase): AuditCitationReader {
  return async (query) => {
    if (query.resourceIds.length === 0 || query.actions.length === 0) return [];
    const rows = await db
      .selectFrom("pithyAuditEvents")
      .selectAll()
      .where("resourceType", "=", query.resourceType)
      .where("resourceId", "in", [...query.resourceIds])
      .where("action", "in", [...query.actions])
      .orderBy("occurredAt", "asc")
      .orderBy("id", "asc")
      .execute();
    return rows.map((raw): AuditCitation => {
      const row = AuditEventRow.parse(raw);
      const step = row.metadata?.step;
      return {
        eventId: row.eventId,
        action: row.action,
        resourceId: row.resourceId ?? "",
        occurredAt: row.occurredAt,
        tenant: row.tenant ?? null,
        seq: row.chainSeq ?? null,
        hash: row.chainHash ?? null,
        step: typeof step === "string" ? step : null,
      };
    });
  };
}

/** The reader over the binding the config names, built per call from the env, like the Workflow recorder. */
export function auditCitationsFor(database: string): (env: Record<string, unknown>) => AuditCitationReader {
  return (env) => {
    const binding = env[database];
    if (typeof binding !== "object" || binding === null) {
      throw new InternalError({
        message: "The audit database is not bound.",
        action: `Bind the ${database} D1 database to this Worker.`,
        detail: `the audit citation reader found no ${database} binding on the env`,
      });
    }
    return auditCitationReader(auditDatabase(binding as D1Database));
  };
}
