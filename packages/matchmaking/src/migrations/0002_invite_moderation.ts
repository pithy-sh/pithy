// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * What a management client needs from the invites table — `#819`.
 *
 * **`cancelKey`** is the idempotency key a control-plane cancel was sent with. It sits on the row it canceled,
 * so the cancel and its key land in one conditional `UPDATE` and a retry of the same request finds itself there:
 * nothing to race, and no second table to keep in step. **Unique**, so one key cannot cancel two invites; SQLite
 * counts every null as distinct, so the invites nobody canceled carry none and never collide.
 *
 * **`(status, createdAt)`** is the index the pending-invites read pages on: an equality, then the sort column,
 * so the page is a range scan and its `LIMIT` stops it.
 *
 * **Appended, never folded into `0001`.** Matchmaking has shipped, so its table is history. Nullable with no
 * backfill: no invite before this one was canceled by a management client.
 */
export const matchmaking_0002_invite_moderation: Migration = {
  up: async (db: Kysely<unknown>): Promise<void> => {
    await db.schema.alterTable("pithyMatchmakingInvites").addColumn("cancelKey", "text").execute();
    await db.schema
      .createIndex("pithyMatchmakingInvitesCancelKeyIdx")
      .on("pithyMatchmakingInvites")
      .column("cancelKey")
      .unique()
      .execute();
    await db.schema
      .createIndex("pithyMatchmakingInvitesStatusCreatedIdx")
      .on("pithyMatchmakingInvites")
      .columns(["status", "createdAt"])
      .execute();
  },

  down: async (db: Kysely<unknown>): Promise<void> => {
    await db.schema.dropIndex("pithyMatchmakingInvitesStatusCreatedIdx").execute();
    // The index goes before the column: SQLite refuses to drop a column an index still names.
    await db.schema.dropIndex("pithyMatchmakingInvitesCancelKeyIdx").execute();
    await db.schema.alterTable("pithyMatchmakingInvites").dropColumn("cancelKey").execute();
  },
};
