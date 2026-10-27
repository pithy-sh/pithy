// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * The events one request wrote — `#828`.
 *
 * `GET {audit}/control-plane/reach` answers whose data a credential reached, and the gate's own
 * `controlplane/call_allowed` row cannot say: it is written before the handler runs, so before any tenant is
 * resolved. The handler's events carry the tenant, and the request id (`cf-ray`) is what ties them to the call. The
 * reach statement finds them by it, once per call in the window, so without this index every call is a scan of the
 * trail.
 *
 * **Appended, never folded into `0001`.** The audit capability has shipped, so its table is history.
 */
export const audit_0004_request_index: Migration = {
  up: async (db: Kysely<unknown>): Promise<void> => {
    await db.schema.createIndex("pithyAuditEventsRequestIdx").on("pithyAuditEvents").column("requestId").execute();
  },

  down: async (db: Kysely<unknown>): Promise<void> => {
    await db.schema.dropIndex("pithyAuditEventsRequestIdx").execute();
  },
};
