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

/** The auth set as `pithy migrate` composes it, so `0007` runs where it will: last. */
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

describe("auth_0007_erasure_record", () => {
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

  test("up adds a deletion's mode and due instant, nullable, and a row carrying them round-trips", async () => {
    await runMigrations(env.DB, provider());
    expect(await lifecycleColumns()).toEqual(expect.arrayContaining(["mode", "purge_after"]));
    expect(await indexNames()).toEqual(
      expect.arrayContaining(["pithy_auth_user_lifecycle_created_at_idx", "pithy_auth_user_lifecycle_purge_after_idx"]),
    );
    await env.DB.prepare(
      "insert into pithy_auth_user_lifecycle (user_id, action, actor_type, mode, purge_after, created_at) values ('u1', 'deleted', 'control-plane', 'hard', 5, 5)",
    ).run();
    await env.DB.prepare(
      "insert into pithy_auth_user_lifecycle (user_id, action, actor_type, created_at) values ('u2', 'purge_failed', 'system', 1)",
    ).run();
    const rows = await authDatabase(env.DB).selectFrom("pithyAuthUserLifecycle").selectAll().orderBy("id").execute();
    const parsed = rows.map((row) => UserLifecycleEvent.parse(row));
    expect(parsed.map((row) => [row.action, row.mode, row.purgeAfter?.getTime() ?? null])).toEqual([
      ["deleted", "hard", 5],
      ["purge_failed", null, null],
    ]);
  });

  test("down takes the columns and indexes away, the history stays, and up again is clean", async () => {
    await runMigrations(env.DB, provider());
    await env.DB.prepare(
      "insert into pithy_auth_user_lifecycle (user_id, action, actor_type, created_at) values ('u1', 'deleted', 'system', 1)",
    ).run();
    await rollbackMigration(env.DB, provider());
    expect(await lifecycleColumns()).not.toContain("mode");
    expect(await lifecycleColumns()).not.toContain("purge_after");
    expect(await indexNames()).not.toContain("pithy_auth_user_lifecycle_created_at_idx");
    const left = await env.DB.prepare("select count(*) as n from pithy_auth_user_lifecycle").first<{ n: number }>();
    expect(left?.n).toBe(1);
    await runMigrations(env.DB, provider());
    expect(await lifecycleColumns()).toContain("purge_after");
  });
});
