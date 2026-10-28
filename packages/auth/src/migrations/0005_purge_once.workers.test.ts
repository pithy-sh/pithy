// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { rollbackMigration, runMigrations } from "@pithy-sh/core/src/migrations/runner";
import type { MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import { authDatabase } from "../data/tables";
import { UserLifecycleEvent } from "../data/userLifecycle";
import { AUTH_MIGRATION_ORDER } from "./0001_init";
import { AUTH_MIGRATIONS } from "./set";

/** The auth set as `pithy migrate` composes it, so `0005` runs where it will: last. */
function provider(): MigrationProvider {
  const found = createMigrationRegistry([
    { database: "app", namespace: "auth", order: AUTH_MIGRATION_ORDER, migrations: AUTH_MIGRATIONS },
  ]).app;
  if (!found) throw new Error('expected a provider for database "app"');
  return found;
}

async function lifecycleColumns(): Promise<string[]> {
  const rows = await env.DB.prepare("select name from pragma_table_info('pithy_auth_user_lifecycle')").all<{
    name: string;
  }>();
  return rows.results.map((row) => row.name);
}

async function indexNames(): Promise<string[]> {
  const rows = await env.DB.prepare(
    "select name from sqlite_master where type = 'index' and tbl_name = 'pithy_auth_user_lifecycle'",
  ).all<{ name: string }>();
  return rows.results.map((row) => row.name);
}

const insert = (userId: string, action: string) =>
  env.DB.prepare(
    "insert into pithy_auth_user_lifecycle (user_id, action, actor_type, created_at) values (?, ?, 'system', 1)",
  )
    .bind(userId, action)
    .run();

describe("auth_0005_purge_once", () => {
  beforeEach(async () => {
    for (const table of [
      "pithy_auth_accounts",
      "pithy_auth_devices",
      "pithy_auth_jwks",
      "pithy_auth_rate_limit",
      "pithy_auth_rotated_tokens",
      "pithy_auth_sessions",
      "pithy_auth_user_lifecycle",
      "pithy_auth_verification_outcomes",
      "pithy_auth_users",
      "pithy_auth_verifications",
      "pithy_migrations",
      "pithy_migrations_lock",
    ]) {
      await env.DB.prepare(`drop table if exists ${table}`).run();
    }
  });

  test("up adds a nullable notify column, and a row carrying it round-trips through the schema", async () => {
    await runMigrations(env.DB, provider());
    expect(await lifecycleColumns()).toContain("notify");
    await env.DB.prepare(
      "insert into pithy_auth_user_lifecycle (user_id, action, actor_type, notify, created_at) values ('u1', 'deleted', 'control-plane', 0, 1)",
    ).run();
    await insert("u2", "deleted");
    const rows = await authDatabase(env.DB).selectFrom("pithyAuthUserLifecycle").selectAll().orderBy("id").execute();
    expect(rows.map((row) => UserLifecycleEvent.parse(row).notify)).toEqual([false, null]);
  });

  test("an account takes one purged row, and only one — every other action repeats freely", async () => {
    await runMigrations(env.DB, provider());
    await insert("u1", "purged");
    await expect(insert("u1", "purged")).rejects.toThrow(/UNIQUE/);
    await insert("u2", "purged");
    for (let i = 0; i < 3; i += 1) await insert("u1", "purge_step");
    const count = await env.DB.prepare(
      "select count(*) as n from pithy_auth_user_lifecycle where user_id = 'u1' and action = 'purged'",
    ).first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  test("down takes the index and the column away, and the history before it stays", async () => {
    await runMigrations(env.DB, provider());
    await insert("u1", "deleted");
    // `0007` and `0006` sit above it in the chain, so they come down first.
    await rollbackMigration(env.DB, provider());
    await rollbackMigration(env.DB, provider());
    await rollbackMigration(env.DB, provider());
    await rollbackMigration(env.DB, provider());
    expect(await lifecycleColumns()).not.toContain("notify");
    expect(await indexNames()).not.toContain("pithy_auth_user_lifecycle_purged_once_idx");
    const left = await env.DB.prepare("select count(*) as n from pithy_auth_user_lifecycle").first<{ n: number }>();
    expect(left?.n).toBe(1);
    // Up again is clean: the inverse is exact.
    await runMigrations(env.DB, provider());
    expect(await lifecycleColumns()).toContain("notify");
    expect(await indexNames()).toContain("pithy_auth_user_lifecycle_purged_once_idx");
  });
});
