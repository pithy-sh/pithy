// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { type Kysely, sql } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * The organization a stored file belongs to, and the middle visibility level.
 *
 * **`organizationId` is added beside the existing `ownerId`**, nullable and in the same terms: the
 * organization the owner was acting for when the file was written, or null when none was. Existing rows
 * get null, which is true of them — nothing recorded one.
 *
 * **`visibility` gains `organization`, and in SQLite a `CHECK` cannot be altered.** So the objects table is
 * rebuilt: a new table with the new constraint, every row copied across, the old one dropped, the new one
 * renamed into its place. The shares table is rebuilt beside it, in the order that keeps its foreign key
 * honest — a `DROP TABLE` of a parent runs an implicit `DELETE`, and with `ON DELETE CASCADE` that would
 * take every share link with it. So the new shares table points at the new objects table from the start,
 * the old shares go before the old objects, nothing references the old objects when they are dropped, and
 * the rename carries the foreign key across to the new name. Not one share is lost, and the tests count.
 *
 * **Indexed the way the reads ask.** The existing `(ownerId, path)` and `(status, createdAt)` indexes come
 * back with the table, and two join them: `(ownerId, createdAt)` and `(organizationId, createdAt)`, so
 * *this owner's files over a window* and *this organization's* are each one index range.
 *
 * `down` is the tested inverse: the same rebuild the other way. A row at `organization` goes back to
 * `private` — the narrower level, so an inverse can never publish a file — and `organizationId` is
 * dropped.
 */

const OBJECTS = "pithyStorageObjects";
const OBJECTS_NEXT = "pithyStorageObjectsNext";
const SHARES = "pithyStorageShares";
const SHARES_NEXT = "pithyStorageSharesNext";

/** The columns both shapes of the objects table share, in the order they were declared. */
const SHARED_COLUMNS = [
  "id",
  "key",
  "path",
  "ownerId",
  "contentType",
  "size",
  "visibility",
  "checksum",
  "status",
  "uploadId",
  "createdAt",
  "updatedAt",
] as const;

/** Every column of the shares table. */
const SHARE_COLUMNS = ["token", "objectId", "expiresAt", "revokedAt", "createdAt"] as const;

/** A comma-separated list of column references, snake-cased by the `CamelCasePlugin`. */
function columnList(columns: readonly string[]) {
  return sql.join(columns.map((column) => sql.ref(column)));
}

/** Create an objects table under `name`, with or without the organization column and level. */
async function createObjects(db: Kysely<unknown>, name: string, withOrganization: boolean): Promise<void> {
  let table = db.schema
    .createTable(name)
    // Text, not autoincrement: the id is in every route path, and a sequential id is an enumeration oracle.
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("key", "text", (c) => c.notNull().unique())
    .addColumn("path", "text", (c) => c.notNull())
    .addColumn("ownerId", "text");
  if (withOrganization) table = table.addColumn("organizationId", "text");
  await table
    .addColumn("contentType", "text", (c) => c.notNull())
    .addColumn("size", "integer")
    .addColumn("visibility", "text", (c) => c.notNull().defaultTo("private"))
    .addColumn("checksum", "text")
    .addColumn("status", "text", (c) => c.notNull().defaultTo("pending"))
    .addColumn("uploadId", "text")
    .addColumn("createdAt", "integer", (c) => c.notNull())
    .addColumn("updatedAt", "integer", (c) => c.notNull())
    .addCheckConstraint(
      "pithyStorageObjectsVisibility",
      withOrganization
        ? sql`visibility IN ('private', 'organization', 'public')`
        : sql`visibility IN ('private', 'public')`,
    )
    .addCheckConstraint("pithyStorageObjectsStatus", sql`status IN ('pending', 'stored', 'failed')`)
    .execute();
}

/** Create a shares table under `name`, pointing at the objects table `parent`. */
async function createShares(db: Kysely<unknown>, name: string, parent: string): Promise<void> {
  await db.schema
    .createTable(name)
    // The token IS the credential, so it is the key — a lookup is a primary-key hit, not a scan.
    .addColumn("token", "text", (c) => c.primaryKey())
    .addColumn("objectId", "text", (c) => c.notNull())
    .addColumn("expiresAt", "integer")
    .addColumn("revokedAt", "integer")
    .addColumn("createdAt", "integer", (c) => c.notNull())
    .addForeignKeyConstraint("pithyStorageSharesObjectFk", ["objectId"], parent, ["id"], (fk) => fk.onDelete("cascade"))
    .execute();
}

/** The indexes the objects table carries in both shapes. */
async function createObjectIndexes(db: Kysely<unknown>, withOrganization: boolean): Promise<void> {
  await db.schema.createIndex("pithyStorageObjectsOwnerPathIdx").on(OBJECTS).columns(["ownerId", "path"]).execute();
  await db.schema.createIndex("pithyStorageObjectsStatusIdx").on(OBJECTS).columns(["status", "createdAt"]).execute();
  await db.schema.createIndex("pithyStorageSharesObjectIdx").on(SHARES).columns(["objectId"]).execute();
  if (!withOrganization) return;
  await db.schema
    .createIndex("pithyStorageObjectsOwnerCreatedIdx")
    .on(OBJECTS)
    .columns(["ownerId", "createdAt"])
    .execute();
  await db.schema
    .createIndex("pithyStorageObjectsOrganizationCreatedIdx")
    .on(OBJECTS)
    .columns(["organizationId", "createdAt"])
    .execute();
}

/** Drop the indexes the objects table carries in one of its two shapes — the inverse of `createObjectIndexes`. */
async function dropObjectIndexes(db: Kysely<unknown>, withOrganization: boolean): Promise<void> {
  if (withOrganization) {
    await db.schema.dropIndex("pithyStorageObjectsOrganizationCreatedIdx").execute();
    await db.schema.dropIndex("pithyStorageObjectsOwnerCreatedIdx").execute();
  }
  await db.schema.dropIndex("pithyStorageSharesObjectIdx").execute();
  await db.schema.dropIndex("pithyStorageObjectsStatusIdx").execute();
  await db.schema.dropIndex("pithyStorageObjectsOwnerPathIdx").execute();
}

/**
 * Rebuild both tables into a new shape, copying every row. `visibility` is the expression the copied
 * visibility is read through — the column itself going up, a narrowing going down.
 */
async function rebuild(
  db: Kysely<unknown>,
  withOrganization: boolean,
  visibility: ReturnType<typeof sql>,
): Promise<void> {
  await createObjects(db, OBJECTS_NEXT, withOrganization);
  const copied = SHARED_COLUMNS.filter((column) => column !== "visibility");
  await sql`insert into ${sql.table(OBJECTS_NEXT)} (${columnList(copied)}, ${sql.ref("visibility")}) select ${columnList(copied)}, ${visibility} from ${sql.table(OBJECTS)}`.execute(
    db,
  );

  await createShares(db, SHARES_NEXT, OBJECTS_NEXT);
  await sql`insert into ${sql.table(SHARES_NEXT)} (${columnList(SHARE_COLUMNS)}) select ${columnList(SHARE_COLUMNS)} from ${sql.table(SHARES)}`.execute(
    db,
  );

  // The old tables' indexes first, by name, as every other migration's inverse drops them: their names are
  // the ones the rebuilt tables take.
  await dropObjectIndexes(db, !withOrganization);
  // Children first: once the old shares are gone, nothing references the old objects, so dropping them
  // cascades into nothing.
  await db.schema.dropTable(SHARES).execute();
  await db.schema.dropTable(OBJECTS).execute();
  // Renaming the parent rewrites the new shares' foreign key to the name it now has.
  await db.schema.alterTable(OBJECTS_NEXT).renameTo(OBJECTS).execute();
  await db.schema.alterTable(SHARES_NEXT).renameTo(SHARES).execute();
  await createObjectIndexes(db, withOrganization);
}

export const storage_0002_ownership: Migration = {
  up: async (db: Kysely<unknown>): Promise<void> => {
    await rebuild(db, true, sql.ref("visibility"));
  },
  down: async (db: Kysely<unknown>): Promise<void> => {
    await rebuild(
      db,
      false,
      sql`case when ${sql.ref("visibility")} = 'organization' then 'private' else ${sql.ref("visibility")} end`,
    );
  },
};
