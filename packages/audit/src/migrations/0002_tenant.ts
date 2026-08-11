// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * Add `tenant` to `pithy_audit_events` — whose action it was — and the index the (tenant, time) read
 * needs.
 *
 * `project`, `environment` and `worker` say which deployment of ours wrote a row. In a multi-tenant
 * application all three are constant across every row, so nothing on the event distinguished one
 * customer's history from another's. `actor_id` does not either: one person can administer two
 * tenants, and every event they produce carries the same actor.
 *
 * **Nullable, with no default, permanently.** A single-tenant app has no such dimension and must not be
 * made to invent one; a CLI-originated action and a fleet-wide operator action genuinely have no
 * tenant. Null is therefore a legitimate value meaning "not tenant-scoped", and it is also what every
 * row written before this migration reads as — SQLite fills the new column with NULL, nothing
 * back-fills it, and nothing ever can. The tenant of an action is a fact at the time of the action;
 * a membership table only knows who belongs where *now*, so deriving one from the other would hand a
 * year of one tenant's history to another the day somebody changes teams.
 *
 * The index leads with `tenant` and carries `occurred_at` because that is the query: one tenant's
 * trail, newest first, usually over a window. A `tenant`-only index would still leave the sort to a
 * scan of the largest table in most projects.
 *
 * `down` drops the index *before* the column. SQLite refuses to drop a column an index refers to, so
 * the other order is not a style preference — it fails.
 */
export const audit_0002_tenant: Migration = {
  up: async (db: Kysely<unknown>): Promise<void> => {
    await db.schema.alterTable("pithyAuditEvents").addColumn("tenant", "text").execute();
    await db.schema
      .createIndex("pithyAuditEventsTenantIdx")
      .on("pithyAuditEvents")
      .columns(["tenant", "occurredAt"])
      .execute();
  },
  down: async (db: Kysely<unknown>): Promise<void> => {
    await db.schema.dropIndex("pithyAuditEventsTenantIdx").execute();
    await db.schema.alterTable("pithyAuditEvents").dropColumn("tenant").execute();
  },
};
