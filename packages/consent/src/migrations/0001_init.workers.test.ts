// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { consent_0001_init } from "./0001_init";

// A bare Kysely over the D1 binding — the migration operates on raw DDL, so no schema is needed.
function db(): Kysely<unknown> {
  return createDatabase(env.DB, {}) as unknown as Kysely<unknown>;
}

/** Everything 0001 creates, as it appears in SQLite's catalog: tables, indexes and triggers. */
async function catalog(): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE name LIKE 'pithy_consent_%' ORDER BY name",
  ).all<{ name: string }>();
  return results.map((r) => r.name);
}

beforeEach(async () => {
  for (const table of ["pithy_consent_records", "pithy_consent_documents", "pithy_consent_merges"]) {
    await env.DB.exec(`DROP TABLE IF EXISTS ${table}`);
  }
});

describe("consent_0001_init", () => {
  test("up creates the three tables, their indexes, and the append-only triggers", async () => {
    await consent_0001_init.up(db());
    expect(await catalog()).toEqual([
      "pithy_consent_documents",
      "pithy_consent_documents_no_delete",
      "pithy_consent_documents_no_update",
      "pithy_consent_merges",
      "pithy_consent_merges_no_delete",
      "pithy_consent_merges_no_update",
      "pithy_consent_merges_user_idx",
      "pithy_consent_merges_visitor_idx",
      "pithy_consent_records",
      "pithy_consent_records_no_delete",
      "pithy_consent_records_no_update",
      "pithy_consent_records_purpose_idx",
      "pithy_consent_records_subject_idx",
    ]);
  });

  test("down is the exact inverse — nothing of the migration survives", async () => {
    await consent_0001_init.up(db());
    await consent_0001_init.down?.(db());
    expect(await catalog()).toEqual([]);
  });

  test("up then down then up again is clean (rollback is re-runnable)", async () => {
    await consent_0001_init.up(db());
    await consent_0001_init.down?.(db());
    await consent_0001_init.up(db());
    expect(await catalog()).toContain("pithy_consent_records");
  });

  test("a visitor merges once", async () => {
    await consent_0001_init.up(db());
    const merge = (id: string) =>
      `INSERT INTO pithy_consent_merges (id, visitor_id, user_id, merged_at) VALUES ('${id}', 'v1', 'u1', 1)`;
    await env.DB.exec(merge("m1"));
    await expect(env.DB.exec(merge("m2"))).rejects.toThrow(/UNIQUE/);
  });
});
