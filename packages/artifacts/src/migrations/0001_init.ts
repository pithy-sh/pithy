// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * Creates `pithy_artifacts_repos` and `pithy_artifacts_grants`.
 *
 * A repository's primary key is its physical name, which is unique in the namespace by construction. The unique
 * `(owner_kind, owner_id, display_name)` index is what lets two owners both hold a repository displayed as `docs`
 * while one owner cannot hold two. A grant is keyed on `(repo, user_id)`: one grant per person per repository, and
 * the `user_id` index serves "what may this person see".
 */
export const artifacts_0001_init: Migration = {
  up: async (db: Kysely<unknown>) => {
    await db.schema
      .createTable("pithyArtifactsRepos")
      .addColumn("name", "text", (c) => c.primaryKey())
      .addColumn("displayName", "text", (c) => c.notNull())
      .addColumn("ownerKind", "text", (c) => c.notNull())
      .addColumn("ownerId", "text", (c) => c.notNull())
      .addColumn("remoteAccess", "integer", (c) => c.notNull())
      .addColumn("createdAt", "integer", (c) => c.notNull())
      .addColumn("updatedAt", "integer", (c) => c.notNull())
      .execute();
    await db.schema
      .createIndex("pithyArtifactsReposOwnerDisplayIdx")
      .on("pithyArtifactsRepos")
      .columns(["ownerKind", "ownerId", "displayName"])
      .unique()
      .execute();

    await db.schema
      .createTable("pithyArtifactsGrants")
      .addColumn("repo", "text", (c) => c.notNull())
      .addColumn("userId", "text", (c) => c.notNull())
      .addColumn("grant", "text", (c) => c.notNull())
      .addColumn("createdAt", "integer", (c) => c.notNull())
      .addColumn("updatedAt", "integer", (c) => c.notNull())
      .addPrimaryKeyConstraint("pithyArtifactsGrantsPk", ["repo", "userId"])
      .execute();
    await db.schema.createIndex("pithyArtifactsGrantsUserIdx").on("pithyArtifactsGrants").column("userId").execute();
  },

  down: async (db: Kysely<unknown>) => {
    await db.schema.dropIndex("pithyArtifactsGrantsUserIdx").execute();
    await db.schema.dropTable("pithyArtifactsGrants").execute();
    await db.schema.dropIndex("pithyArtifactsReposOwnerDisplayIdx").execute();
    await db.schema.dropTable("pithyArtifactsRepos").execute();
  },
};
