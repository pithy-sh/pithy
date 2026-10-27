// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * One connection's calls over a window — `#812`.
 *
 * `GET {audit}/control-plane/usage` reads the `controlplane/call_allowed` and `controlplane/call_denied` rows of one
 * connection between two instants, and groups them by scope and key. None of 0001's indexes serves that:
 * `pithyAuditEventsResourceIdx` finds the connection's rows but not by action or time, and `pithyAuditEventsActionIdx`
 * finds every call of every connection. On the table a dashboard connection appends thousands of rows to a day, the
 * difference is a range read against a scan.
 *
 * **In this column order, and it is the query's.** `action` first, because the read names two actions with `IN` and
 * SQLite walks one range per value. `resourceId` second, an equality inside each. `occurredAt` last, so the window
 * is a bounded range rather than a filter over every row the connection ever wrote. `resourceType` is left out: a
 * connection id is a UUID, so `resourceId` is already selective, and the type is checked against the row it finds.
 *
 * **Appended, never folded into `0001`.** The audit capability has shipped, so its table is history.
 */
export const audit_0003_call_index: Migration = {
  up: async (db: Kysely<unknown>): Promise<void> => {
    await db.schema
      .createIndex("pithyAuditEventsCallIdx")
      .on("pithyAuditEvents")
      .columns(["action", "resourceId", "occurredAt"])
      .execute();
  },

  down: async (db: Kysely<unknown>): Promise<void> => {
    await db.schema.dropIndex("pithyAuditEventsCallIdx").execute();
  },
};
