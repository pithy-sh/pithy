// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import type { MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import { rollbackThrough } from "../test-utils/rollbackThrough";
import { AUTH_MIGRATION_ORDER } from "./0001_init";
import { AUTH_MIGRATIONS } from "./set";

function provider(): MigrationProvider {
  const found = createMigrationRegistry([
    { database: "app", namespace: "auth", order: AUTH_MIGRATION_ORDER, migrations: AUTH_MIGRATIONS },
  ]).app;
  if (!found) throw new Error('expected a provider for database "app"');
  return found;
}

async function tables(): Promise<string[]> {
  const rows = await env.DB.prepare("select name from sqlite_master where type in ('table', 'index')").all<{
    name: string;
  }>();
  return rows.results.map((row) => row.name);
}

async function columns(): Promise<string[]> {
  const rows = await env.DB.prepare("select name from pragma_table_info('pithy_auth_app_attest_keys')").all<{
    name: string;
  }>();
  return rows.results.map((row) => row.name).sort();
}

describe("auth_0010_app_attest_keys", () => {
  beforeEach(async () => {
    for (const row of (
      await env.DB.prepare("select name from sqlite_master where type = 'table' and name like 'pithy_%'").all<{
        name: string;
      }>()
    ).results) {
      await env.DB.prepare(`drop table if exists ${row.name}`).run();
    }
  });

  test("up creates the key table", async () => {
    await runMigrations(env.DB, provider());
    expect(await tables()).toContain("pithy_auth_app_attest_keys");
    expect(await columns()).toEqual(
      ["app_id", "counter", "created_at", "environment", "id", "last_used_at", "public_key"].sort(),
    );
  });

  test("down takes it away, leaves the challenges, and up again is clean", async () => {
    await runMigrations(env.DB, provider());
    await rollbackThrough(env.DB, provider(), "0010_app_attest_keys");
    const names = await tables();
    expect(names).not.toContain("pithy_auth_app_attest_keys");
    expect(names).toContain("pithy_auth_attestation_challenges");
    await runMigrations(env.DB, provider());
    expect(await tables()).toContain("pithy_auth_app_attest_keys");
  });
});
