// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { ArtifactsNameTakenError, ArtifactsNotFoundError } from "../error/errors";
import { type ArtifactsGrant, ArtifactsGrantRecord, type ArtifactsOwnerKind, ArtifactsRepoRecord } from "./records";
import { ARTIFACTS_GRANTS_TABLE, ARTIFACTS_REPOS_TABLE, type ArtifactsDatabase } from "./tables";

/** A repository a person may see, and the grant they hold on it — `null` where they own it. */
export interface VisibleRepo {
  /** The repository. */
  repo: ArtifactsRepoRecord;
  /** The caller's grant, or `null` when they are its owner. */
  grant: ArtifactsGrant | null;
}

/**
 * The only reader and writer of `pithy_artifacts_repos` and `pithy_artifacts_grants`. Reads decode through the
 * table's Zod object and writes encode through it, so a raw `0/1` or epoch never appears here.
 */
export interface ArtifactsStore {
  /** Record a new repository. A second one under the same owner and display name is `artifacts/name_taken`. */
  insertRepo(record: ArtifactsRepoRecord): Promise<void>;
  /** A repository by its physical name, or `undefined`. */
  getRepo(name: string): Promise<ArtifactsRepoRecord | undefined>;
  /** Delete a repository's row and every grant on it. */
  deleteRepo(name: string): Promise<void>;
  /** Every repository one owner holds, newest display name order. */
  listOwned(kind: ArtifactsOwnerKind, ownerId: string): Promise<ArtifactsRepoRecord[]>;
  /** Whether an owner already holds a repository with this display name. */
  displayNameTaken(kind: ArtifactsOwnerKind, ownerId: string, displayName: string): Promise<boolean>;
  /** What a person owns, then what they are granted. Never a listing of the namespace. */
  listVisible(userId: string): Promise<VisibleRepo[]>;
  /** A person's grant on a repository. A value the catalog does not know is refused, never asserted. */
  getGrant(repo: string, userId: string): Promise<ArtifactsGrantRecord | undefined>;
  /** Make or change a person's grant. */
  setGrant(repo: string, userId: string, grant: ArtifactsGrant, at: Date): Promise<void>;
  /** Take a person's grant away. Resolves whether there was one. */
  removeGrant(repo: string, userId: string): Promise<boolean>;
}

/** Whether a D1 failure is a UNIQUE or PRIMARY KEY constraint, the one write failure this store translates. */
function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed|PRIMARY KEY/i.test(error.message);
}

export function artifactsStore(db: ArtifactsDatabase): ArtifactsStore {
  return {
    async insertRepo(record) {
      try {
        await db
          .insertInto(ARTIFACTS_REPOS_TABLE)
          .values(ArtifactsRepoRecord.encode(record) as never)
          .execute();
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        throw new ArtifactsNameTakenError(
          { message: "A repository with that name already exists.", detail: `${record.ownerKind}:${record.ownerId}` },
          { cause: error },
        );
      }
    },

    async getRepo(name) {
      const row = await db.selectFrom(ARTIFACTS_REPOS_TABLE).selectAll().where("name", "=", name).executeTakeFirst();
      return row ? ArtifactsRepoRecord.parse(row) : undefined;
    },

    async deleteRepo(name) {
      await db.deleteFrom(ARTIFACTS_GRANTS_TABLE).where("repo", "=", name).execute();
      await db.deleteFrom(ARTIFACTS_REPOS_TABLE).where("name", "=", name).execute();
    },

    async listOwned(kind, ownerId) {
      const rows = await db
        .selectFrom(ARTIFACTS_REPOS_TABLE)
        .selectAll()
        .where("ownerKind", "=", kind)
        .where("ownerId", "=", ownerId)
        .orderBy("displayName")
        .orderBy("name")
        .execute();
      return rows.map((row) => ArtifactsRepoRecord.parse(row));
    },

    async displayNameTaken(kind, ownerId, displayName) {
      const row = await db
        .selectFrom(ARTIFACTS_REPOS_TABLE)
        .select("name")
        .where("ownerKind", "=", kind)
        .where("ownerId", "=", ownerId)
        .where("displayName", "=", displayName)
        .executeTakeFirst();
      return row !== undefined;
    },

    async listVisible(userId) {
      const owned = await db
        .selectFrom(ARTIFACTS_REPOS_TABLE)
        .selectAll()
        .where("ownerKind", "=", "user")
        .where("ownerId", "=", userId)
        .orderBy("displayName")
        .orderBy("name")
        .execute();
      const granted = await db
        .selectFrom(ARTIFACTS_GRANTS_TABLE)
        .innerJoin(ARTIFACTS_REPOS_TABLE, `${ARTIFACTS_REPOS_TABLE}.name`, `${ARTIFACTS_GRANTS_TABLE}.repo`)
        .selectAll(ARTIFACTS_REPOS_TABLE)
        .select(`${ARTIFACTS_GRANTS_TABLE}.grant`)
        .where(`${ARTIFACTS_GRANTS_TABLE}.userId`, "=", userId)
        .orderBy(`${ARTIFACTS_REPOS_TABLE}.displayName`)
        .orderBy(`${ARTIFACTS_REPOS_TABLE}.name`)
        .execute();
      const visible: VisibleRepo[] = owned.map((row) => ({ repo: ArtifactsRepoRecord.parse(row), grant: null }));
      const seen = new Set(visible.map((entry) => entry.repo.name));
      for (const row of granted) {
        const { grant, ...repo } = row as typeof row & { grant: unknown };
        // A value the catalog does not know grants nothing: decoded and refused, never asserted.
        const decoded = ArtifactsGrantRecord.shape.grant.safeParse(grant);
        const record = ArtifactsRepoRecord.parse(repo);
        if (!decoded.success || seen.has(record.name)) continue;
        visible.push({ repo: record, grant: decoded.data });
      }
      return visible;
    },

    async getGrant(repo, userId) {
      const row = await db
        .selectFrom(ARTIFACTS_GRANTS_TABLE)
        .selectAll()
        .where("repo", "=", repo)
        .where("userId", "=", userId)
        .executeTakeFirst();
      if (!row) return undefined;
      const decoded = ArtifactsGrantRecord.safeParse(row);
      // Refused as the repository not existing, for the reason a role the catalog does not know is refused as the
      // organization not existing: whatever is in that column, the answer to "may this person act" is no.
      if (!decoded.success) {
        throw new ArtifactsNotFoundError({
          detail: `grant of user ${userId} on repository ${repo} holds a value outside read and write`,
        });
      }
      return decoded.data;
    },

    async setGrant(repo, userId, grant, at) {
      const record = ArtifactsGrantRecord.encode({ repo, userId, grant, createdAt: at, updatedAt: at });
      await db
        .insertInto(ARTIFACTS_GRANTS_TABLE)
        .values(record as never)
        .onConflict((oc) =>
          oc.columns(["repo", "userId"]).doUpdateSet({
            grant: record.grant,
            updatedAt: record.updatedAt,
          } as never),
        )
        .execute();
    },

    async removeGrant(repo, userId) {
      const result = await db
        .deleteFrom(ARTIFACTS_GRANTS_TABLE)
        .where("repo", "=", repo)
        .where("userId", "=", userId)
        .executeTakeFirst();
      return Number(result.numDeletedRows) > 0;
    },
  };
}
