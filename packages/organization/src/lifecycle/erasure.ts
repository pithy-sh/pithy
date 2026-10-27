// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import type { ErasureHistoryReader, ErasureHistoryRow, ErasureRecords } from "@pithy-sh/core/src/capability/erasure";
import { SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { OrganizationAuditActions } from "../audit/actions";
import { OrganizationLifecycleEvent } from "../data/organizationLifecycle";
import { type OrganizationDatabase, organizationDatabase } from "../data/tables";

/**
 * **An organization's erasure record, read back for the control plane's attestation (#823).**
 *
 * `pithy_organization_lifecycle` is the one `pithy_organization_*` table a purge leaves behind, and it names the
 * organization by id and nothing else. This reads the rows an erasure is made of and hands them to core through the
 * {@link ErasureRecords} seam — the same shape `@pithy-sh/auth` declares for a user.
 */

/** The rows an erasure is made of. A suspension is not one. */
const ERASURE_ACTIONS = ["deleted", "restored", "purge_step", "purge_retained", "purge_failed", "purged"] as const;

/** The rows that are the purge itself. */
const PURGE_ACTIONS = ["purge_step", "purge_retained", "purge_failed", "purged"] as const;

/** The rows that end a deletion: its purge finishing, or the subject coming back. */
const CLOSING_ACTIONS = ["purged", "restored"] as const;

/** The reader, over one organization database. */
export function organizationErasureReader(db: OrganizationDatabase): ErasureHistoryReader {
  return {
    history: async (organizationIds) => {
      if (organizationIds.length === 0) return [];
      const rows = await db
        .selectFrom("pithyOrganizationLifecycle")
        .selectAll()
        .where("organizationId", "in", [...organizationIds])
        .where("action", "in", [...ERASURE_ACTIONS])
        .orderBy("id", "asc")
        .execute();
      return rows.map((raw): ErasureHistoryRow => {
        const row = OrganizationLifecycleEvent.parse(raw);
        return {
          subjectId: row.organizationId,
          action: row.action as ErasureHistoryRow["action"],
          actorType: row.actorType,
          reason: row.reason,
          step: row.step,
          mode: row.mode,
          purgeAfter: row.purgeAfter,
          at: row.createdAt,
        };
      });
    },
    subjectsIn: async (since, until) => {
      const from = SQLiteDate.encode(since);
      const to = SQLiteDate.encode(until);
      const rows = await db
        .selectFrom("pithyOrganizationLifecycle as row")
        .select("row.organizationId")
        .distinct()
        .where((eb) =>
          eb.or([
            eb.and([
              eb("row.action", "in", [...PURGE_ACTIONS]),
              eb("row.createdAt", ">=", from),
              eb("row.createdAt", "<=", to),
            ]),
            eb.and([
              eb("row.action", "=", "deleted"),
              eb("row.purgeAfter", ">=", from),
              eb("row.purgeAfter", "<=", to),
            ]),
            // Outstanding in the window: due by its end, or recorded before the due instant was, and neither purged
            // nor restored before it opened. A purge that came due earlier and has written nothing since is the one
            // the period read exists to name.
            eb.and([
              eb("row.action", "=", "deleted"),
              eb("row.createdAt", "<=", to),
              eb.or([eb("row.purgeAfter", "<=", to), eb("row.purgeAfter", "is", null)]),
              eb.not(
                eb.exists(
                  eb
                    .selectFrom("pithyOrganizationLifecycle as closed")
                    .select("closed.id")
                    .whereRef("closed.organizationId", "=", "row.organizationId")
                    .whereRef("closed.id", ">", "row.id")
                    .where("closed.action", "in", [...CLOSING_ACTIONS])
                    .where("closed.createdAt", "<", from),
                ),
              ),
            ]),
          ]),
        )
        .orderBy("row.organizationId")
        .execute();
      return rows.map((row) => row.organizationId);
    },
  };
}

/** What organization declares: the `organization` subject, the actions its purge records, and the reader. */
export const organizationErasureRecords: ErasureRecords = {
  subject: "organization",
  resourceType: "organization",
  auditActions: {
    deleted: [OrganizationAuditActions.adminOrganizationDeleted, OrganizationAuditActions.adminOrganizationHardDeleted],
    step: OrganizationAuditActions.purgeStep,
    failed: OrganizationAuditActions.purgeFailed,
    purged: OrganizationAuditActions.purged,
  },
  read: (env) => {
    // The purge reads the same binding: the organization's tables live in the app database.
    const d1 = env.DB;
    if (typeof d1 !== "object" || d1 === null) {
      throw new InternalError({
        message: "The organization database is not bound.",
        action: "Bind the DB D1 database to this Worker.",
        detail: "the erasure read found no DB binding on the env",
      });
    }
    return organizationErasureReader(organizationDatabase(d1 as D1Database));
  },
};
