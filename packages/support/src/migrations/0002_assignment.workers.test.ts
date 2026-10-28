// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { rollbackMigration, runMigrations } from "@pithy-sh/core/src/migrations/runner";
import type { MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import { SUPPORT_MIGRATION_ORDER } from "../capability";
import { SUPPORT_MIGRATIONS } from "./set";

/**
 * `0002_assignment` as `pithy migrate` composes it — after `0001`, against the tables `0001` shaped.
 *
 * A `0002` tested alone would be testing something no adopter runs, so this runs the whole set and comes
 * down one step at a time.
 */

function provider(): MigrationProvider {
  const registry = createMigrationRegistry([
    { database: "app", namespace: "support", order: SUPPORT_MIGRATION_ORDER, migrations: SUPPORT_MIGRATIONS },
  ]);
  const found = registry.app;
  if (!found) throw new Error('expected a provider for database "app"');
  return found;
}

async function columns(table: string): Promise<string[]> {
  const rows = await env.DB.prepare(`select name from pragma_table_info('${table}')`).all<{ name: string }>();
  return rows.results.map((row) => row.name).sort();
}

async function supportTables(): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'pithy_support_%' ORDER BY name",
  ).all<{ name: string }>();
  return results.map((row) => row.name);
}

async function indexes(): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'pithy_support_%' ORDER BY name",
  ).all<{ name: string }>();
  return results.map((row) => row.name);
}

beforeEach(async () => {
  for (const table of [
    "pithy_support_search",
    "pithy_support_embeddings",
    "pithy_support_assignments",
    "pithy_support_thread_flags",
    "pithy_support_classifications",
    "pithy_support_attachments",
    "pithy_support_messages",
    "pithy_support_threads",
    "pithy_migrations",
    "pithy_migrations_lock",
  ]) {
    await env.DB.exec(`DROP TABLE IF EXISTS ${table}`);
  }
});

describe("support_0002_assignment", () => {
  test("up adds the four assignee columns to the threads 0001 created, and the history table", async () => {
    await runMigrations(env.DB, provider());
    const threads = await columns("pithy_support_threads");
    for (const column of ["assignee_ref", "assignee_name", "assigned_at", "assigned_by"]) {
      expect(threads).toContain(column);
    }
    expect(await supportTables()).toContain("pithy_support_assignments");
    expect(await columns("pithy_support_assignments")).toEqual(
      [
        "id",
        "thread_id",
        "assignee_ref",
        "assignee_name",
        "previous_ref",
        "previous_name",
        "actor_type",
        "assigned_by",
        "note",
        "created_at",
      ].sort(),
    );
    expect(await indexes()).toEqual(
      expect.arrayContaining(["pithy_support_threads_assignee_idx", "pithy_support_assignments_thread_idx"]),
    );
  });

  test("a thread written before it reads as unassigned", async () => {
    await runMigrations(env.DB, provider());
    await env.DB.prepare(
      `INSERT INTO pithy_support_threads (id, subject, from_address, first_message_at, last_message_at, created_at, updated_at)
       VALUES ('t1', 'Hi', 'ada@example.com', 1, 1, 1, 1)`,
    ).run();
    const row = await env.DB.prepare(
      "SELECT assignee_ref, assignee_name, assigned_at, assigned_by FROM pithy_support_threads WHERE id = 't1'",
    ).first();
    expect(row).toEqual({ assignee_ref: null, assignee_name: null, assigned_at: null, assigned_by: null });
  });

  test("down removes what up added and leaves 0001's tables and columns as they were", async () => {
    await runMigrations(env.DB, provider());
    // 0003 first: it is above this one in the chain.
    await rollbackMigration(env.DB, provider());
    await rollbackMigration(env.DB, provider());
    expect(await supportTables()).toEqual([
      "pithy_support_attachments",
      "pithy_support_classifications",
      "pithy_support_messages",
      "pithy_support_thread_flags",
      "pithy_support_threads",
    ]);
    const threads = await columns("pithy_support_threads");
    for (const column of ["assignee_ref", "assignee_name", "assigned_at", "assigned_by"]) {
      expect(threads).not.toContain(column);
    }
    expect(threads).toContain("archived_by");
    expect(await indexes()).not.toContain("pithy_support_threads_assignee_idx");
    // And 0001 comes down cleanly after it, so the whole chain round-trips.
    await rollbackMigration(env.DB, provider());
    expect(await supportTables()).toEqual([]);
  });
});
