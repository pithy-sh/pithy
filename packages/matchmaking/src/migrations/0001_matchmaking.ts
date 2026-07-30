// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * Creates the matchmaking D1 tables: `pithy_matchmaking_invites` (direct invites) and
 * `pithy_matchmaking_friends` (the symmetric friend graph). Room codes live in KV, so they are not here.
 * All identifiers are camelCase; the runner's `CamelCasePlugin` snake-cases them to `pithy_matchmaking_*`.
 */
export const matchmaking_0001_matchmaking: Migration = {
  up: async (db: Kysely<unknown>) => {
    await db.schema
      .createTable("pithyMatchmakingInvites")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("gameKey", "text", (c) => c.notNull())
      .addColumn("inviterId", "text", (c) => c.notNull())
      .addColumn("inviteeId", "text", (c) => c.notNull())
      .addColumn("status", "text", (c) => c.notNull())
      .addColumn("sessionId", "text")
      .addColumn("createdAt", "integer", (c) => c.notNull())
      .addColumn("respondedAt", "integer")
      .execute();

    await db.schema
      .createIndex("pithyMatchmakingInvitesInviteeIdx")
      .on("pithyMatchmakingInvites")
      .columns(["inviteeId", "status"])
      .execute();

    await db.schema
      .createTable("pithyMatchmakingFriends")
      .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
      .addColumn("userA", "text", (c) => c.notNull())
      .addColumn("userB", "text", (c) => c.notNull())
      .addColumn("status", "text", (c) => c.notNull())
      .addColumn("requestedBy", "text", (c) => c.notNull())
      .addColumn("createdAt", "integer", (c) => c.notNull())
      .addColumn("updatedAt", "integer", (c) => c.notNull())
      .execute();

    await db.schema
      .createIndex("pithyMatchmakingFriendsPairIdx")
      .on("pithyMatchmakingFriends")
      .columns(["userA", "userB"])
      .unique()
      .execute();

    await db.schema
      .createIndex("pithyMatchmakingFriendsByUserB")
      .on("pithyMatchmakingFriends")
      .columns(["userB"])
      .execute();
  },

  down: async (db: Kysely<unknown>) => {
    await db.schema.dropIndex("pithyMatchmakingFriendsByUserB").execute();
    await db.schema.dropIndex("pithyMatchmakingFriendsPairIdx").execute();
    await db.schema.dropTable("pithyMatchmakingFriends").execute();
    await db.schema.dropIndex("pithyMatchmakingInvitesInviteeIdx").execute();
    await db.schema.dropTable("pithyMatchmakingInvites").execute();
  },
};
