// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { rollbackMigration, runMigrations } from "@pithy-sh/core/src/migrations/runner";
import type { MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import { AUTH_MIGRATION_ORDER, auth_0001_init } from "./0001_init";

/** The auth migration set, as `pithy migrate` composes it for the shared `app` database. */
const SET = {
  database: "app",
  namespace: "auth",
  order: AUTH_MIGRATION_ORDER,
  migrations: { "0001_init": auth_0001_init },
} as const;

const ALL_TABLES = [
  "pithy_auth_accounts",
  "pithy_auth_devices",
  "pithy_auth_jwks",
  "pithy_auth_rate_limit",
  "pithy_auth_rotated_tokens",
  "pithy_auth_sessions",
  "pithy_auth_users",
  "pithy_auth_verifications",
];

function provider(): MigrationProvider {
  const registry = createMigrationRegistry([SET]);
  const found = registry.app;
  if (!found) throw new Error('expected a provider for database "app"');
  return found;
}

async function authTables(): Promise<string[]> {
  const rows = await env.DB.prepare(
    "select name from sqlite_master where type = 'table' and name like 'pithy_auth_%'",
  ).all<{ name: string }>();
  return rows.results.map((row) => row.name).sort();
}

async function authIndexes(): Promise<string[]> {
  const rows = await env.DB.prepare(
    "select name from sqlite_master where type = 'index' and name like 'pithy_auth_%'",
  ).all<{ name: string }>();
  return rows.results.map((row) => row.name).sort();
}

async function sessionColumns(): Promise<string[]> {
  const rows = await env.DB.prepare("select name from pragma_table_info('pithy_auth_sessions')").all<{
    name: string;
  }>();
  return rows.results.map((row) => row.name).sort();
}

beforeEach(async () => {
  for (const table of [...ALL_TABLES, "pithy_migrations", "pithy_migrations_lock"]) {
    await env.DB.prepare(`drop table if exists ${table}`).run();
  }
});

describe("auth_0001_init", () => {
  test("up creates every prefixed table and its indexes, and a user row round-trips on snake_case columns", async () => {
    const results = await runMigrations(env.DB, provider());

    expect(results.map((r) => [r.migrationName, r.direction, r.status])).toEqual([
      ["0300_auth_0001_init", "Up", "Success"],
    ]);
    expect(await authTables()).toEqual(ALL_TABLES);
    // CamelCasePlugin snake-cased the explicit indexes; SQLite's UNIQUE autoindexes are named
    // `sqlite_autoindex_*` and don't match the prefix filter.
    expect(await authIndexes()).toEqual([
      "pithy_auth_accounts_user_id_idx",
      // The two keyset cursors the control-plane admin listings page on, composite and in sort order.
      "pithy_auth_devices_last_seen_at_idx",
      "pithy_auth_rotated_tokens_family_id_idx",
      "pithy_auth_rotated_tokens_rotated_at_idx",
      "pithy_auth_sessions_device_id_idx",
      "pithy_auth_sessions_user_id_idx",
      "pithy_auth_users_created_at_idx",
      "pithy_auth_verifications_identifier_idx",
    ]);
    // The session carries its refresh-token family, and the reuse-detection ledger exists.
    expect(await sessionColumns()).toContain("family_id");

    // Proves the camelCase model fields landed as snake_case columns (the casing the Better-Auth
    // adapter relies on via the shared CamelCasePlugin).
    await env.DB.prepare(
      "insert into pithy_auth_users (id, name, email, email_verified, created_at, updated_at) values (?, ?, ?, ?, ?, ?)",
    )
      .bind("user-1", "Ada", "ada@example.com", 1, "2026-06-19T00:00:00.000Z", "2026-06-19T00:00:00.000Z")
      .run();
    const row = await env.DB.prepare("select email, email_verified from pithy_auth_users where id = ?")
      .bind("user-1")
      .first<{ email: string; email_verified: number }>();
    expect(row).toEqual({ email: "ada@example.com", email_verified: 1 });
  });

  test("a rotated-token ledger row round-trips on snake_case columns", async () => {
    await runMigrations(env.DB, provider());
    await env.DB.prepare(
      "insert into pithy_auth_rotated_tokens (token, family_id, user_id, rotated_at) values (?, ?, ?, ?)",
    )
      .bind("tok-1", "fam-1", "user-1", 1_750_000_000_000)
      .run();
    const row = await env.DB.prepare(
      "select family_id, user_id, rotated_at from pithy_auth_rotated_tokens where token = ?",
    )
      .bind("tok-1")
      .first<{ family_id: string; user_id: string; rotated_at: number }>();
    expect(row).toEqual({ family_id: "fam-1", user_id: "user-1", rotated_at: 1_750_000_000_000 });
  });

  test("the rotated-token primary key rejects a duplicate consumed token", async () => {
    await runMigrations(env.DB, provider());
    const insert = (family: string): Promise<unknown> =>
      env.DB.prepare(
        "insert into pithy_auth_rotated_tokens (token, family_id, user_id, rotated_at) values (?, ?, ?, ?)",
      )
        .bind("dup-token", family, "user-1", 1_750_000_000_000)
        .run();
    await insert("fam-a");
    await expect(insert("fam-b")).rejects.toThrow();
  });

  test("the unique constraint on user email rejects a duplicate", async () => {
    await runMigrations(env.DB, provider());
    const insert = (id: string): Promise<unknown> =>
      env.DB.prepare(
        "insert into pithy_auth_users (id, name, email, created_at, updated_at) values (?, 'x', 'dup@example.com', '2026-06-19T00:00:00.000Z', '2026-06-19T00:00:00.000Z')",
      )
        .bind(id)
        .run();
    await insert("u1");
    await expect(insert("u2")).rejects.toThrow();
  });

  test("down drops every table and index", async () => {
    const p = provider();
    await runMigrations(env.DB, p);

    const results = await rollbackMigration(env.DB, p);

    expect(results.map((r) => [r.migrationName, r.direction, r.status])).toEqual([
      ["0300_auth_0001_init", "Down", "Success"],
    ]);
    expect(await authTables()).toEqual([]);
    expect(await authIndexes()).toEqual([]);
  });
});
