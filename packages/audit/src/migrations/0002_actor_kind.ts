// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * What kind of management client acted — `#721`.
 *
 * `actorType: "control-plane"` names an agent, the dashboard and a script identically, and those are the
 * questions asked after an incident. The kind is recorded on the connection when it is registered and
 * stamped onto every control-plane row by `requireControlPlane`; this is the column it lands in.
 *
 * **Appended, never folded into `0001`.** The audit capability has shipped, so its table is history.
 *
 * **Nullable, with no default and no backfill.** Every row before this one, and every row whose actor is
 * not a management client, has no kind — and a row recorded under a connection registered before kinds
 * were recorded has none either. Null says exactly that. No index: the trail is read by time and actor
 * first, and a kind narrows a page that `actorType` has already narrowed.
 */
export const audit_0002_actor_kind: Migration = {
  up: async (db: Kysely<unknown>): Promise<void> => {
    await db.schema.alterTable("pithyAuditEvents").addColumn("actorKind", "text").execute();
  },

  down: async (db: Kysely<unknown>): Promise<void> => {
    // In place, as `controlplane_0002` drops its column: D1's engine supports it, and a rebuild would
    // rewrite every row of the largest table in the project to remove one nothing else reads.
    await db.schema.alterTable("pithyAuditEvents").dropColumn("actorKind").execute();
  },
};
