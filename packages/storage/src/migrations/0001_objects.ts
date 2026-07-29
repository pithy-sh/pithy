import { type Kysely, sql } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * The storage tables: stored objects, and the revocable share links that point at them.
 *
 * camelCase identifiers; `CamelCasePlugin` snake-cases them in the DDL. `down` is the tested inverse,
 * dropping indexes before their tables and the child table before its parent.
 *
 * Three constraints carry weight.
 *
 * `key` is `UNIQUE`. Keys are server-derived UUIDs, so a collision should be impossible — which is
 * exactly why the database should say so. If one ever appears, the insert fails rather than two rows
 * quietly sharing one object's bytes and one deletion orphaning the other.
 *
 * `status` and `visibility` are `CHECK`ed against their enums. The Zod schemas already validate on the
 * way in, but the database is the last line: a hand-run `UPDATE` during an incident cannot leave a row
 * in a state the code has no branch for, and `visibility` in particular is an authorization input.
 *
 * The shares foreign key is `ON DELETE CASCADE`. A share link to a deleted object is not merely stale,
 * it is a dangling authorization; letting the database remove it means no delete path can forget to.
 */
export const storage_0001_objects: Migration = {
  up: async (db: Kysely<unknown>): Promise<void> => {
    await db.schema
      .createTable("pithyStorageObjects")
      // Text, not autoincrement: the id is in every route path, and a sequential id is an enumeration oracle.
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("key", "text", (c) => c.notNull().unique())
      .addColumn("path", "text", (c) => c.notNull())
      .addColumn("ownerId", "text")
      .addColumn("contentType", "text", (c) => c.notNull())
      .addColumn("size", "integer")
      .addColumn("visibility", "text", (c) => c.notNull().defaultTo("private"))
      .addColumn("checksum", "text")
      .addColumn("status", "text", (c) => c.notNull().defaultTo("pending"))
      .addColumn("uploadId", "text")
      .addColumn("createdAt", "integer", (c) => c.notNull())
      .addColumn("updatedAt", "integer", (c) => c.notNull())
      .addCheckConstraint("pithyStorageObjectsVisibility", sql`visibility IN ('private', 'public')`)
      .addCheckConstraint("pithyStorageObjectsStatus", sql`status IN ('pending', 'stored', 'failed')`)
      .execute();

    // The owner's file list, by path prefix. Left-prefixed on owner_id so a scoped `LIKE 'prefix%'`
    // walks one owner's slice of the index rather than the whole table.
    await db.schema
      .createIndex("pithyStorageObjectsOwnerPathIdx")
      .on("pithyStorageObjects")
      .columns(["ownerId", "path"])
      .execute();

    // The quota sum and the orphan sweep both read `WHERE status = ? AND ...`; status leads so both
    // land on the same index, and created_at trails it so the sweep's age scan is a range, not a filter.
    await db.schema
      .createIndex("pithyStorageObjectsStatusIdx")
      .on("pithyStorageObjects")
      .columns(["status", "createdAt"])
      .execute();

    await db.schema
      .createTable("pithyStorageShares")
      // The token IS the credential, so it is the key — a lookup is a primary-key hit, not a scan.
      .addColumn("token", "text", (c) => c.primaryKey())
      .addColumn("objectId", "text", (c) => c.notNull())
      .addColumn("expiresAt", "integer")
      .addColumn("revokedAt", "integer")
      .addColumn("createdAt", "integer", (c) => c.notNull())
      .addForeignKeyConstraint("pithyStorageSharesObjectFk", ["objectId"], "pithyStorageObjects", ["id"], (fk) =>
        fk.onDelete("cascade"),
      )
      .execute();

    // Revoking every share on an object, and listing an owner's shares for one file.
    await db.schema.createIndex("pithyStorageSharesObjectIdx").on("pithyStorageShares").columns(["objectId"]).execute();
  },
  down: async (db: Kysely<unknown>): Promise<void> => {
    await db.schema.dropIndex("pithyStorageSharesObjectIdx").execute();
    await db.schema.dropTable("pithyStorageShares").execute();
    await db.schema.dropIndex("pithyStorageObjectsStatusIdx").execute();
    await db.schema.dropIndex("pithyStorageObjectsOwnerPathIdx").execute();
    await db.schema.dropTable("pithyStorageObjects").execute();
  },
};
