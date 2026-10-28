// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * Legal holds. Appended: the seam has shipped and adopters' databases hold its rows.
 *
 * One row per hold, kept after it is released, so the table is the record of every hold that ever stood. Indexed on
 * `(state, subject_type, subject_id)`, because the question every purge and prune asks is "is an active hold on this
 * subject", and it is asked once per step.
 */
export const controlplane_0005_holds: Migration = {
  up: async (db: Kysely<unknown>): Promise<void> => {
    await db.schema
      .createTable("pithyControlplaneHolds")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("subjectType", "text", (c) => c.notNull())
      .addColumn("subjectId", "text")
      .addColumn("reason", "text", (c) => c.notNull())
      .addColumn("placedBy", "text", (c) => c.notNull())
      .addColumn("placedAt", "integer", (c) => c.notNull())
      .addColumn("state", "text", (c) => c.notNull())
      .addColumn("releasedAt", "integer")
      .addColumn("releasedBy", "text")
      .addColumn("releaseReason", "text")
      .execute();
    await db.schema
      .createIndex("pithyControlplaneHoldsSubjectIdx")
      .on("pithyControlplaneHolds")
      .columns(["state", "subjectType", "subjectId"])
      .execute();
  },

  down: async (db: Kysely<unknown>): Promise<void> => {
    await db.schema.dropIndex("pithyControlplaneHoldsSubjectIdx").execute();
    await db.schema.dropTable("pithyControlplaneHolds").execute();
  },
};
