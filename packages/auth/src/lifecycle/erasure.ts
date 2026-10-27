// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { ErasureHistoryReader, ErasureHistoryRow, ErasureRecords } from "@pithy-sh/core/src/capability/erasure";
import { SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import { AuthAuditActions } from "../audit/actions";
import { type AuthDatabase, authDatabase } from "../data/tables";
import { UserLifecycleEvent } from "../data/userLifecycle";
import { resolveDb } from "../http/resolve";

/**
 * **A user's erasure record, read back for the control plane's attestation (#823).**
 *
 * `pithy_auth_user_lifecycle` is the one `pithy_auth_*` table a purge leaves behind, and it names the account by id
 * and nothing else. This reads the rows an erasure is made of — the deletion, any restore, each step, a failure, the
 * end — and hands them to core through the {@link ErasureRecords} seam, so the control plane never imports auth.
 */

/** The rows an erasure is made of. A suspension is not one. */
const ERASURE_ACTIONS = ["deleted", "restored", "purge_step", "purge_retained", "purge_failed", "purged"] as const;

/** The rows that are the purge itself, rather than the deletion it runs under. */
const PURGE_ACTIONS = ["purge_step", "purge_retained", "purge_failed", "purged"] as const;

/** The rows that end a deletion: its purge finishing, or the subject coming back. */
const CLOSING_ACTIONS = ["purged", "restored"] as const;

/** The reader, over one auth database. */
export function userErasureReader(db: AuthDatabase): ErasureHistoryReader {
  return {
    history: async (userIds) => {
      if (userIds.length === 0) return [];
      const rows = await db
        .selectFrom("pithyAuthUserLifecycle")
        .selectAll()
        .where("userId", "in", [...userIds])
        .where("action", "in", [...ERASURE_ACTIONS])
        .orderBy("id", "asc")
        .execute();
      return rows.map((raw): ErasureHistoryRow => {
        const row = UserLifecycleEvent.parse(raw);
        return {
          subjectId: row.userId,
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
        .selectFrom("pithyAuthUserLifecycle as row")
        .select("row.userId")
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
                    .selectFrom("pithyAuthUserLifecycle as closed")
                    .select("closed.id")
                    .whereRef("closed.userId", "=", "row.userId")
                    .whereRef("closed.id", ">", "row.id")
                    .where("closed.action", "in", [...CLOSING_ACTIONS])
                    .where("closed.createdAt", "<", from),
                ),
              ),
            ]),
          ]),
        )
        .orderBy("row.userId")
        .execute();
      return rows.map((row) => row.userId);
    },
  };
}

/** What auth declares: the `user` subject, the actions its purge records, and the reader over its database. */
export function authErasureRecords(database: string): ErasureRecords {
  return {
    subject: "user",
    resourceType: "user",
    auditActions: {
      deleted: [
        AuthAuditActions.adminUserSoftDeleted,
        AuthAuditActions.adminUserHardDeleted,
        AuthAuditActions.userSelfDeleted,
      ],
      step: AuthAuditActions.adminUserPurgeStep,
      failed: AuthAuditActions.adminUserPurgeFailed,
      purged: AuthAuditActions.adminUserPurged,
    },
    read: (env) => userErasureReader(authDatabase(resolveDb(env, database))),
  };
}
