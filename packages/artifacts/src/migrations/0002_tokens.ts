// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { type Kysely, sql } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * Creates `pithy_artifacts_tokens` and `pithy_artifacts_revocations`, and indexes repositories for paging.
 *
 * **A token record names who a token was minted for**, which Cloudflare's own metadata never does: id, scope, state,
 * created and expiry, and no holder. Keyed on the token id Cloudflare assigns, with the repository and the user beside
 * it. There is no column for the plaintext, so there is nowhere to write one. `(repo, expires_at)` serves both the
 * read of one repository's tokens and the prune of the records that have outlived their token.
 *
 * **A revocation record is a spent idempotency key**, keyed per connection so two management clients can never spend
 * each other's. It holds what the first call did, so a replay answers the same and changes nothing.
 *
 * **And it marks when recording began**: one row, `pithy:records-began`, stamped by the database at the moment this
 * runs. The kit minted tokens before this migration and recorded none of them, so a listed token older than the mark
 * is `unknown`, never one minted outside Pithy. The id is written out rather than imported, because a migration is
 * history and must not move when a constant does.
 *
 * `(created_at, name)` on repositories is the keyset the control-plane listing pages on, newest first.
 */
export const artifacts_0002_tokens: Migration = {
  up: async (db: Kysely<unknown>) => {
    await db.schema
      .createTable("pithyArtifactsTokens")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("repo", "text", (c) => c.notNull())
      .addColumn("userId", "text", (c) => c.notNull())
      .addColumn("scope", "text", (c) => c.notNull())
      .addColumn("source", "text", (c) => c.notNull())
      .addColumn("createdAt", "integer", (c) => c.notNull())
      .addColumn("expiresAt", "integer", (c) => c.notNull())
      .execute();
    await db.schema
      .createIndex("pithyArtifactsTokensRepoExpiresIdx")
      .on("pithyArtifactsTokens")
      .columns(["repo", "expiresAt"])
      .execute();
    // The database's clock, in ms-epoch like every SQLiteDate column; second precision is enough for a boundary.
    const now = sql<number>`cast(strftime('%s', 'now') as integer) * 1000`;
    await (db as Kysely<{ pithyArtifactsTokens: Record<string, unknown> }>)
      .insertInto("pithyArtifactsTokens")
      .values({
        id: "pithy:records-began",
        repo: "",
        userId: "",
        scope: "read",
        source: "create",
        createdAt: now,
        expiresAt: now,
      })
      .execute();

    await db.schema
      .createTable("pithyArtifactsRevocations")
      .addColumn("connectionId", "text", (c) => c.notNull())
      .addColumn("idempotencyKey", "text", (c) => c.notNull())
      .addColumn("kind", "text", (c) => c.notNull())
      .addColumn("repo", "text", (c) => c.notNull())
      .addColumn("tokenId", "text")
      .addColumn("reason", "text", (c) => c.notNull())
      .addColumn("revoked", "integer", (c) => c.notNull())
      .addColumn("createdAt", "integer", (c) => c.notNull())
      .addPrimaryKeyConstraint("pithyArtifactsRevocationsPk", ["connectionId", "idempotencyKey"])
      .execute();

    await db.schema
      .createIndex("pithyArtifactsReposCreatedIdx")
      .on("pithyArtifactsRepos")
      .columns(["createdAt", "name"])
      .execute();
  },

  down: async (db: Kysely<unknown>) => {
    await db.schema.dropIndex("pithyArtifactsReposCreatedIdx").execute();
    await db.schema.dropTable("pithyArtifactsRevocations").execute();
    await db.schema.dropIndex("pithyArtifactsTokensRepoExpiresIdx").execute();
    await db.schema.dropTable("pithyArtifactsTokens").execute();
  },
};
