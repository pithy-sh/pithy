// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { storage_0001_objects } from "./0001_objects";
import { storage_0002_ownership } from "./0002_ownership";

const db = () => createDatabase(env.DB, {}) as unknown as Kysely<unknown>;

async function catalog(): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE name LIKE 'pithy_storage_%' ORDER BY name",
  ).all<{ name: string }>();
  return results.map((r) => r.name);
}

beforeEach(async () => {
  for (const t of ["pithy_storage_shares", "pithy_storage_objects"]) {
    await env.DB.exec(`DROP TABLE IF EXISTS ${t}`);
  }
});

/** One valid objects row, so a constraint test differs from a valid insert in exactly one column. */
const insertObject = (columns: string) =>
  env.DB.prepare(
    `INSERT INTO pithy_storage_objects (id, key, path, owner_id, content_type, size, visibility, checksum, status, upload_id, created_at, updated_at) VALUES (${columns})`,
  ).run();

describe("storage_0001_objects", () => {
  test("up creates both tables and the three indexes", async () => {
    await storage_0001_objects.up(db());
    expect(await catalog()).toEqual([
      "pithy_storage_objects",
      "pithy_storage_objects_owner_path_idx",
      "pithy_storage_objects_status_idx",
      "pithy_storage_shares",
      "pithy_storage_shares_object_idx",
    ]);
  });

  test("the visibility and status CHECK constraints are enforced by SQLite itself", async () => {
    await storage_0001_objects.up(db());
    await expect(
      insertObject("'i1','obj/1','a.pdf','u1','application/pdf',1,'unlisted',NULL,'stored',NULL,0,0"),
    ).rejects.toThrow(/CHECK constraint failed/i);
    await expect(
      insertObject("'i2','obj/2','a.pdf','u1','application/pdf',1,'private',NULL,'uploading',NULL,0,0"),
    ).rejects.toThrow(/CHECK constraint failed/i);
  });

  test("the key UNIQUE constraint refuses two rows over one object's bytes", async () => {
    await storage_0001_objects.up(db());
    await insertObject("'i1','obj/1','a.pdf','u1','application/pdf',1,'private',NULL,'stored',NULL,0,0");
    await expect(
      insertObject("'i2','obj/1','b.pdf','u1','application/pdf',1,'private',NULL,'stored',NULL,0,0"),
    ).rejects.toThrow(/UNIQUE constraint failed/i);
  });

  test("down is the exact inverse and up is re-runnable after it", async () => {
    await storage_0001_objects.up(db());
    await storage_0001_objects.down?.(db());
    expect(await catalog()).toEqual([]);
    await storage_0001_objects.up(db());
    expect(await catalog()).toContain("pithy_storage_objects");
  });
});

describe("storage_0002_ownership", () => {
  /** A row as 0001 wrote it, then a share link pointing at it. */
  async function seedReleasedRows(): Promise<void> {
    await insertObject("'i1','obj/1','a.pdf','u1','application/pdf',1,'private',NULL,'stored',NULL,0,0");
    await insertObject("'i2','obj/2','b.pdf','u2','application/pdf',2,'public',NULL,'stored',NULL,0,0");
    await env.DB.prepare(
      "INSERT INTO pithy_storage_shares (token, object_id, expires_at, revoked_at, created_at) VALUES ('t1', 'i1', NULL, NULL, 0)",
    ).run();
  }

  async function columns(table: string): Promise<string[]> {
    const { results } = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
    return results.map((row) => row.name);
  }

  test("up adds the organization column and both time indexes, beside the ones 0001 made", async () => {
    await storage_0001_objects.up(db());
    await storage_0002_ownership.up(db());
    expect(await columns("pithy_storage_objects")).toContain("organization_id");
    expect(await catalog()).toEqual([
      "pithy_storage_objects",
      "pithy_storage_objects_organization_created_idx",
      "pithy_storage_objects_owner_created_idx",
      "pithy_storage_objects_owner_path_idx",
      "pithy_storage_objects_status_idx",
      "pithy_storage_shares",
      "pithy_storage_shares_object_idx",
    ]);
  });

  test("every row and every share link survives the rebuild, with a null organization", async () => {
    await storage_0001_objects.up(db());
    await seedReleasedRows();
    await storage_0002_ownership.up(db());
    const { results } = await env.DB.prepare(
      "SELECT id, owner_id, organization_id, visibility FROM pithy_storage_objects ORDER BY id",
    ).all();
    expect(results).toEqual([
      { id: "i1", owner_id: "u1", organization_id: null, visibility: "private" },
      { id: "i2", owner_id: "u2", organization_id: null, visibility: "public" },
    ]);
    const shares = await env.DB.prepare("SELECT token, object_id FROM pithy_storage_shares").all();
    expect(shares.results).toEqual([{ token: "t1", object_id: "i1" }]);
  });

  test("the middle level is accepted, and a level the code has no branch for still is not", async () => {
    await storage_0001_objects.up(db());
    await storage_0002_ownership.up(db());
    await env.DB.prepare(
      "INSERT INTO pithy_storage_objects (id, key, path, owner_id, organization_id, content_type, size, visibility, checksum, status, upload_id, created_at, updated_at) VALUES ('i3','obj/3','c.pdf','u1','org-a','application/pdf',1,'organization',NULL,'stored',NULL,0,0)",
    ).run();
    await expect(
      env.DB.prepare("UPDATE pithy_storage_objects SET visibility = 'unlisted' WHERE id = 'i3'").run(),
    ).rejects.toThrow(/CHECK constraint failed/i);
  });

  test("the share foreign key still cascades — onto the rebuilt table, not the one it replaced", async () => {
    await storage_0001_objects.up(db());
    await seedReleasedRows();
    await storage_0002_ownership.up(db());
    await env.DB.prepare("DELETE FROM pithy_storage_objects WHERE id = 'i1'").run();
    const shares = await env.DB.prepare("SELECT token FROM pithy_storage_shares").all();
    expect(shares.results).toEqual([]);
  });

  test("down is the inverse: rows and links survive, organization narrows to private, never to public", async () => {
    await storage_0001_objects.up(db());
    await seedReleasedRows();
    await storage_0002_ownership.up(db());
    await env.DB.prepare(
      "UPDATE pithy_storage_objects SET visibility = 'organization', organization_id = 'org-a' WHERE id = 'i1'",
    ).run();
    await storage_0002_ownership.down?.(db());

    expect(await columns("pithy_storage_objects")).not.toContain("organization_id");
    expect(await catalog()).toEqual([
      "pithy_storage_objects",
      "pithy_storage_objects_owner_path_idx",
      "pithy_storage_objects_status_idx",
      "pithy_storage_shares",
      "pithy_storage_shares_object_idx",
    ]);
    const { results } = await env.DB.prepare("SELECT id, visibility FROM pithy_storage_objects ORDER BY id").all();
    expect(results).toEqual([
      { id: "i1", visibility: "private" },
      { id: "i2", visibility: "public" },
    ]);
    expect((await env.DB.prepare("SELECT token FROM pithy_storage_shares").all()).results).toEqual([{ token: "t1" }]);
    // And the old constraint is back: the middle level is refused again.
    await expect(
      env.DB.prepare("UPDATE pithy_storage_objects SET visibility = 'organization' WHERE id = 'i2'").run(),
    ).rejects.toThrow(/CHECK constraint failed/i);
    // Up is re-runnable after it.
    await storage_0002_ownership.up(db());
    expect(await columns("pithy_storage_objects")).toContain("organization_id");
  });
});
