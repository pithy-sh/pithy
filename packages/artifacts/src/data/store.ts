// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { decodeCursor, pageLimit, toPage } from "@pithy-sh/core/src/data/cursor";
import { ArtifactsNameTakenError, ArtifactsNotFoundError } from "../error/errors";
import {
  type ArtifactsGrant,
  ArtifactsGrantRecord,
  type ArtifactsOwnerKind,
  ArtifactsRepoRecord,
  ArtifactsRevocationRecord,
  ArtifactsTokenRecord,
  TOKEN_RECORDS_BEGAN_ID,
} from "./records";
import {
  ARTIFACTS_GRANTS_TABLE,
  ARTIFACTS_REPOS_TABLE,
  ARTIFACTS_REVOCATIONS_TABLE,
  ARTIFACTS_TOKENS_TABLE,
  type ArtifactsDatabase,
} from "./tables";

/** A repository a person may see, and the grant they hold on it — `null` where they own it. */
export interface VisibleRepo {
  /** The repository. */
  repo: ArtifactsRepoRecord;
  /** The caller's grant, or `null` when they are its owner. */
  grant: ArtifactsGrant | null;
}

/** One keyset page of repositories, and where the next one resumes. */
export interface RepoPage {
  /** The rows, newest first. */
  items: ArtifactsRepoRecord[];
  /** The cursor for the next page, or null at the end. Opaque; hand it back verbatim. */
  nextCursor: string | null;
}

/**
 * The only reader and writer of the capability's tables. Reads decode through the
 * table's Zod object and writes encode through it, so a raw `0/1` or epoch never appears here.
 */
export interface ArtifactsStore {
  /** Record a new repository. A second one under the same owner and display name is `artifacts/name_taken`. */
  insertRepo(record: ArtifactsRepoRecord): Promise<void>;
  /** A repository by its physical name, or `undefined`. */
  getRepo(name: string): Promise<ArtifactsRepoRecord | undefined>;
  /** Delete a repository's row, every grant on it, and every token record. */
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
  /** Every grant on a repository, by user id. A value the catalog does not know is left out, never asserted. */
  listGrants(repo: string): Promise<ArtifactsGrantRecord[]>;
  /** Every repository the kit knows, newest first, a keyset page at a time. A malformed cursor is a first page. */
  listRepos(query: { cursor?: string; limit?: number }): Promise<RepoPage>;
  /** Record tokens the kit minted. Never their plaintext. A second record of one id is refused. */
  recordTokens(records: readonly ArtifactsTokenRecord[]): Promise<void>;
  /** Every token record on a repository, oldest first. */
  tokenRecords(repo: string): Promise<ArtifactsTokenRecord[]>;
  /**
   * The ids of a repository's token records that expire after `now`, oldest first: every token the kit handed out
   * that could still be live. Revoke-all revokes these by id, because the listing cannot be trusted to reach them.
   */
  unexpiredTokenIds(repo: string, now: Date): Promise<string[]>;
  /** When this database began recording tokens, or `undefined` when the mark `0002_tokens` writes is missing. */
  tokenRecordsBegan(): Promise<Date | undefined>;
  /** Drop a repository's records of tokens that expired before `before`. */
  pruneTokens(repo: string, before: Date): Promise<void>;
  /** The revocation a connection made under a key, or `undefined` when the key is unspent. */
  getRevocation(connectionId: string, idempotencyKey: string): Promise<ArtifactsRevocationRecord | undefined>;
  /** Spend a key. Resolves false, writing nothing, when the connection already spent it. */
  insertRevocation(record: ArtifactsRevocationRecord): Promise<boolean>;
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
      await db.deleteFrom(ARTIFACTS_TOKENS_TABLE).where("repo", "=", name).execute();
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

    async listGrants(repo) {
      const rows = await db
        .selectFrom(ARTIFACTS_GRANTS_TABLE)
        .selectAll()
        .where("repo", "=", repo)
        .orderBy("userId")
        .execute();
      const grants: ArtifactsGrantRecord[] = [];
      for (const row of rows) {
        // A value the catalog does not know grants nothing, so it is not reported as a grant.
        const decoded = ArtifactsGrantRecord.safeParse(row);
        if (decoded.success) grants.push(decoded.data);
      }
      return grants;
    },

    async listRepos(query) {
      const limit = pageLimit(query.limit);
      const cursor = decodeCursor(query.cursor);
      let selection = db
        .selectFrom(ARTIFACTS_REPOS_TABLE)
        .selectAll()
        .orderBy("createdAt", "desc")
        .orderBy("name", "desc")
        // One more than asked for: the extra row answers "is there another page" without a COUNT.
        .limit(limit + 1);
      // A cursor that is not one of ours — wrong types, a hand-built guess — is a first page, never an error.
      if (cursor && typeof cursor.sort === "number" && typeof cursor.id === "string") {
        const sort = ArtifactsRepoRecord.shape.createdAt.encode(new Date(cursor.sort));
        const { id } = cursor;
        selection = selection.where((eb) =>
          eb.or([eb("createdAt", "<", sort), eb.and([eb("createdAt", "=", sort), eb("name", "<", id)])]),
        );
      }
      const rows = await selection.execute();
      return toPage(
        rows.map((row) => ArtifactsRepoRecord.parse(row)),
        limit,
        // The cursor is the wire's, not a column: a ms-epoch a client hands back verbatim.
        (repo) => ({ sort: repo.createdAt.getTime(), id: repo.name }),
      );
    },

    async recordTokens(records) {
      if (records.length === 0) return;
      await db
        .insertInto(ARTIFACTS_TOKENS_TABLE)
        .values(records.map((record) => ArtifactsTokenRecord.encode(record)) as never)
        .execute();
    },

    async tokenRecords(repo) {
      const rows = await db
        .selectFrom(ARTIFACTS_TOKENS_TABLE)
        .selectAll()
        .where("repo", "=", repo)
        .orderBy("createdAt")
        .orderBy("id")
        .execute();
      return rows.map((row) => ArtifactsTokenRecord.parse(row));
    },

    async unexpiredTokenIds(repo, now) {
      const rows = await db
        .selectFrom(ARTIFACTS_TOKENS_TABLE)
        .select("id")
        .where("repo", "=", repo)
        .where("expiresAt", ">", ArtifactsTokenRecord.shape.expiresAt.encode(now))
        .orderBy("createdAt")
        .orderBy("id")
        .execute();
      return rows.map((row) => row.id);
    },

    async tokenRecordsBegan() {
      const row = await db
        .selectFrom(ARTIFACTS_TOKENS_TABLE)
        .select("createdAt")
        .where("id", "=", TOKEN_RECORDS_BEGAN_ID)
        .executeTakeFirst();
      return row ? ArtifactsTokenRecord.shape.createdAt.parse(row.createdAt) : undefined;
    },

    async pruneTokens(repo, before) {
      await db
        .deleteFrom(ARTIFACTS_TOKENS_TABLE)
        .where("repo", "=", repo)
        .where("expiresAt", "<", ArtifactsTokenRecord.shape.expiresAt.encode(before))
        .execute();
    },

    async getRevocation(connectionId, idempotencyKey) {
      const row = await db
        .selectFrom(ARTIFACTS_REVOCATIONS_TABLE)
        .selectAll()
        .where("connectionId", "=", connectionId)
        .where("idempotencyKey", "=", idempotencyKey)
        .executeTakeFirst();
      return row ? ArtifactsRevocationRecord.parse(row) : undefined;
    },

    async insertRevocation(record) {
      // The primary key decides the winner: of two concurrent spends of one key, exactly one row is written.
      const inserted = await db
        .insertInto(ARTIFACTS_REVOCATIONS_TABLE)
        .values(ArtifactsRevocationRecord.encode(record) as never)
        .onConflict((oc) => oc.columns(["connectionId", "idempotencyKey"]).doNothing())
        .returning("idempotencyKey")
        .executeTakeFirst();
      return inserted !== undefined;
    },
  };
}
