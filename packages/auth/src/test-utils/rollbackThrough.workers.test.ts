// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import { beforeEach, describe, expect, test } from "vitest";
import { AUTH_MIGRATION_ORDER } from "../migrations/0001_init";
import { AUTH_MIGRATIONS } from "../migrations/set";
import { rollbackThrough } from "./rollbackThrough";

function provider() {
  const found = createMigrationRegistry([
    { database: "app", namespace: "auth", order: AUTH_MIGRATION_ORDER, migrations: AUTH_MIGRATIONS },
  ]).app;
  if (!found) throw new Error("no provider");
  return found;
}

async function applied(): Promise<string[]> {
  const rows = await env.DB.prepare("select name from pithy_migrations order by name").all<{ name: string }>();
  return rows.results.map((row) => row.name);
}

beforeEach(async () => {
  const rows = await env.DB.prepare("select name from sqlite_master where type = 'table' and name like 'pithy_%'").all<{
    name: string;
  }>();
  for (const row of rows.results) await env.DB.prepare(`drop table if exists ${row.name}`).run();
  await runMigrations(env.DB, provider());
});

describe("rollbackThrough", () => {
  test("undoes the named migration and everything after it, and nothing before it", async () => {
    await rollbackThrough(env.DB, provider(), "0007_erasure_record");
    const names = await applied();
    expect(names.some((name) => name.endsWith("auth_0006_verification_outcomes"))).toBe(true);
    expect(names.some((name) => name.endsWith("auth_0007_erasure_record"))).toBe(false);
    expect(names.some((name) => name.endsWith("auth_0009_attestation_challenges"))).toBe(false);
  });

  test("refuses a migration that is not applied", async () => {
    await rollbackThrough(env.DB, provider(), "0008_last_active");
    await expect(rollbackThrough(env.DB, provider(), "0008_last_active")).rejects.toThrow(/not applied/);
  });
});
