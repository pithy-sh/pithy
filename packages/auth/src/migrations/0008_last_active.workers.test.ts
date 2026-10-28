// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { rollbackMigration, runMigrations } from "@pithy-sh/core/src/migrations/runner";
import type { MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import { authDatabase } from "../data/tables";
import { AUTH_MIGRATION_ORDER } from "./0001_init";
import { AUTH_MIGRATIONS } from "./set";

/** The auth set as `pithy migrate` composes it, through `upTo` when named, so a row can predate `0008`. */
function provider(upTo?: keyof typeof AUTH_MIGRATIONS): MigrationProvider {
  const keys = Object.keys(AUTH_MIGRATIONS) as (keyof typeof AUTH_MIGRATIONS)[];
  const kept = upTo === undefined ? keys : keys.slice(0, keys.indexOf(upTo) + 1);
  const found = createMigrationRegistry([
    {
      database: "app",
      namespace: "auth",
      order: AUTH_MIGRATION_ORDER,
      migrations: Object.fromEntries(kept.map((key) => [key, AUTH_MIGRATIONS[key]])),
    },
  ]).app;
  if (!found) throw new Error('expected a provider for database "app"');
  return found;
}

async function userColumns(): Promise<string[]> {
  const rows = await env.DB.prepare("select name from pragma_table_info('pithy_auth_users')").all<{ name: string }>();
  return rows.results.map((row) => row.name);
}

describe("auth_0008_last_active", () => {
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

  test("up adds the column and stamps every existing account with the migration's instant", async () => {
    await runMigrations(env.DB, provider("0007_erasure_record"));
    await env.DB.prepare(
      "insert into pithy_auth_users (id, name, email, email_verified, created_at, updated_at) values ('u1', 'Sam', 'u1@test.com', 1, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')",
    ).run();
    const before = Date.now();
    await runMigrations(env.DB, provider());
    expect(await userColumns()).toContain("last_active_at");
    const row = await authDatabase(env.DB)
      .selectFrom("pithyAuthUsers")
      .select("lastActiveAt")
      .where("id", "=", "u1")
      .executeTakeFirst();
    // Whole seconds, from SQLite's own clock.
    expect(Number(row?.lastActiveAt)).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000);
  });

  test("down takes the column and its index away, the account stays, and up again is clean", async () => {
    await runMigrations(env.DB, provider());
    await env.DB.prepare(
      "insert into pithy_auth_users (id, name, email, email_verified, created_at, updated_at) values ('u1', 'Sam', 'u1@test.com', 1, 'x', 'x')",
    ).run();
    await rollbackMigration(env.DB, provider());
    expect(await userColumns()).not.toContain("last_active_at");
    const left = await env.DB.prepare("select count(*) as n from pithy_auth_users").first<{ n: number }>();
    expect(left?.n).toBe(1);
    await runMigrations(env.DB, provider());
    expect(await userColumns()).toContain("last_active_at");
  });
});
