// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { storage_0001_objects } from "./0001_objects";

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
