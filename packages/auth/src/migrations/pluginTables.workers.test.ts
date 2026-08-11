// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { rollbackMigration, runMigrations } from "@pithy-sh/core/src/migrations/runner";
import { admin } from "better-auth/plugins/admin";
import { organization } from "better-auth/plugins/organization";
import type { MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import { AUTH_MIGRATION_ORDER, auth_0001_init } from "./0001_init";
import { authPluginPlan } from "./pluginTables";

/**
 * The derived migrations against a real D1, composed exactly as `pithy migrate` composes them: the
 * auth namespace's `0001_init` plus whatever the adopter's plugin list implies, in one ordered
 * provider. A green unit diff proves the plan; only this proves the DDL runs — and that `down` puts
 * the schema back, which is the half a create-only migration gets away with until someone rolls back.
 */
function provider(plugins: Parameters<typeof authPluginPlan>[0]): MigrationProvider {
  const registry = createMigrationRegistry([
    {
      database: "app",
      namespace: "auth",
      order: AUTH_MIGRATION_ORDER,
      migrations: { "0001_init": auth_0001_init, ...authPluginPlan(plugins).migrations },
    },
  ]);
  const found = registry.app;
  if (!found) throw new Error('expected a provider for database "app"');
  return found;
}

const KIT_TABLES = [
  "pithy_auth_accounts",
  "pithy_auth_devices",
  "pithy_auth_jwks",
  "pithy_auth_rate_limit",
  "pithy_auth_rotated_tokens",
  "pithy_auth_sessions",
  "pithy_auth_users",
  "pithy_auth_verifications",
];

const PLUGIN_TABLES = ["organization", "member", "invitation"];

async function tables(): Promise<string[]> {
  const rows = await env.DB.prepare(
    "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name not like '\\_cf\\_%' escape '\\' and name not like 'pithy_migrations%'",
  ).all<{ name: string }>();
  return rows.results.map((row) => row.name).sort();
}

async function columns(table: string): Promise<string[]> {
  const rows = await env.DB.prepare(`select name from pragma_table_info('${table}')`).all<{ name: string }>();
  return rows.results.map((row) => row.name).sort();
}

async function indexes(): Promise<string[]> {
  const rows = await env.DB.prepare(
    "select name from sqlite_master where type = 'index' and name not like 'sqlite_%'",
  ).all<{ name: string }>();
  return rows.results.map((row) => row.name).sort();
}

beforeEach(async () => {
  for (const table of [...KIT_TABLES, ...PLUGIN_TABLES, "pithy_migrations", "pithy_migrations_lock"]) {
    await env.DB.prepare(`drop table if exists ${table}`).run();
  }
});

describe("a plugin's tables through pithy migrate", () => {
  test("organization's tables and its session column are created, keyed as one ledger entry", async () => {
    const results = await runMigrations(env.DB, provider([organization()]));

    expect(results.map((r) => [r.migrationName, r.status])).toEqual([
      ["0300_auth_0001_init", "Success"],
      ["0300_auth_0002_plugin_organization", "Success"],
    ]);
    expect(await tables()).toEqual([...KIT_TABLES, "invitation", "member", "organization"].sort());
    // The half that is not a table: the plugin writes the active organisation onto the session.
    expect(await columns("pithy_auth_sessions")).toContain("active_organization_id");
    expect(await indexes()).toContain("organization_slug_idx");
  });

  test("the created tables take a row on their snake_cased columns", async () => {
    await runMigrations(env.DB, provider([organization()]));

    await env.DB.prepare("insert into organization (id, name, slug, created_at) values (?, ?, ?, ?)")
      .bind("org-1", "Acme", "acme", "2026-06-19T00:00:00.000Z")
      .run();
    await env.DB.prepare("insert into member (id, organization_id, user_id, role, created_at) values (?, ?, ?, ?, ?)")
      .bind("mem-1", "org-1", "user-1", "owner", "2026-06-19T00:00:00.000Z")
      .run();

    const row = await env.DB.prepare("select organization_id, role from member where id = ?")
      .bind("mem-1")
      .first<{ organization_id: string; role: string }>();
    expect(row).toEqual({ organization_id: "org-1", role: "owner" });
  });

  test("the unique slug is enforced", async () => {
    await runMigrations(env.DB, provider([organization()]));
    const insert = (id: string): Promise<unknown> =>
      env.DB.prepare("insert into organization (id, name, slug, created_at) values (?, 'x', 'dup', 'now')")
        .bind(id)
        .run();
    await insert("org-a");
    await expect(insert("org-b")).rejects.toThrow();
  });

  test("down puts the schema back exactly — tables gone, the session column gone, indexes gone", async () => {
    const p = provider([organization()]);
    await runMigrations(env.DB, p);
    const before = await columns("pithy_auth_sessions");

    const results = await rollbackMigration(env.DB, p);

    expect(results.map((r) => [r.migrationName, r.direction, r.status])).toEqual([
      ["0300_auth_0002_plugin_organization", "Down", "Success"],
    ]);
    expect(await tables()).toEqual(KIT_TABLES);
    expect(await columns("pithy_auth_sessions")).toEqual(before.filter((c) => c !== "active_organization_id"));
    expect(await indexes()).not.toContain("organization_slug_idx");
  });

  test("a column-only plugin widens the kit's tables and down narrows them again", async () => {
    const p = provider([admin()]);
    await runMigrations(env.DB, p);

    expect(await columns("pithy_auth_users")).toEqual(expect.arrayContaining(["role", "banned", "ban_expires"]));
    expect(await columns("pithy_auth_sessions")).toContain("impersonated_by");
    // A widened table still takes a row: the added columns are nullable, so the kit's own inserts,
    // which know nothing about the plugin, keep working.
    await env.DB.prepare(
      "insert into pithy_auth_users (id, name, email, created_at, updated_at) values ('u1', 'Ada', 'ada@example.com', 'now', 'now')",
    ).run();

    await rollbackMigration(env.DB, p);
    expect(await columns("pithy_auth_users")).not.toContain("banned");
  });

  test("two plugins are two ledger entries, and one step back leaves the other's schema standing", async () => {
    const p = provider([organization(), admin()]);
    const results = await runMigrations(env.DB, p);

    // One entry per plugin, keyed by its id and sorted within the auth namespace — the config's own
    // order is deliberately not the ledger's, so inserting a plugin never renames an applied entry.
    expect(results.map((r) => r.migrationName)).toEqual([
      "0300_auth_0001_init",
      "0300_auth_0002_plugin_admin",
      "0300_auth_0002_plugin_organization",
    ]);

    await rollbackMigration(env.DB, p);
    expect(await tables()).toEqual(KIT_TABLES);
    expect(await columns("pithy_auth_users")).toContain("banned");
  });
});
