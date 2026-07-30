// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { rollbackMigration, runMigrations } from "@pithy-sh/core/src/migrations/runner";
import type { MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import { secrets_0001_init } from "./0001_init";

/** The secrets capability's migration set, as `pithy migrate` composes it for the SECRETS database. */
const SET = {
  database: "secrets",
  namespace: "secrets",
  order: 100,
  migrations: { "0001_init": secrets_0001_init },
} as const;

function provider(): MigrationProvider {
  const registry = createMigrationRegistry([SET]);
  const found = registry.secrets;
  if (!found) throw new Error('expected a provider for database "secrets"');
  return found;
}

async function secretsTables(): Promise<string[]> {
  const rows = await env.SECRETS.prepare(
    "select name from sqlite_master where type = 'table' and name like 'pithy_secrets_%'",
  ).all<{ name: string }>();
  return rows.results.map((row) => row.name).sort();
}

beforeEach(async () => {
  for (const table of [
    "pithy_secrets_rotations",
    "pithy_secrets_system_secrets",
    "pithy_migrations",
    "pithy_migrations_lock",
  ]) {
    await env.SECRETS.prepare(`drop table if exists ${table}`).run();
  }
});

describe("secrets_0001_init", () => {
  test("up creates both prefixed tables and they are queryable", async () => {
    const results = await runMigrations(env.SECRETS, provider());

    expect(results.map((r) => [r.migrationName, r.direction, r.status])).toEqual([
      ["0100_secrets_0001_init", "Up", "Success"],
    ]);
    expect(await secretsTables()).toEqual(["pithy_secrets_rotations", "pithy_secrets_system_secrets"]);

    // The columns exist: a full row round-trips through the secrets table.
    await env.SECRETS.prepare(
      "insert into pithy_secrets_system_secrets (name, encrypted_value, iv, key_version, value_type, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)",
    )
      .bind("auth-signing-key", "cipher", "iv", 1, "text", 1000, 1000)
      .run();
    const row = await env.SECRETS.prepare(
      "select key_version, value_type from pithy_secrets_system_secrets where name = ?",
    )
      .bind("auth-signing-key")
      .first<{ key_version: number; value_type: string }>();
    expect(row).toEqual({ key_version: 1, value_type: "text" });
  });

  test("the unique index on name rejects a duplicate secret", async () => {
    await runMigrations(env.SECRETS, provider());
    const insert = (): Promise<unknown> =>
      env.SECRETS.prepare(
        "insert into pithy_secrets_system_secrets (name, encrypted_value, iv, key_version, value_type, created_at, updated_at) values ('dup', 'c', 'i', 1, 'text', 1, 1)",
      ).run();
    await insert();
    await expect(insert()).rejects.toThrow();
  });

  test("down drops both tables", async () => {
    const p = provider();
    await runMigrations(env.SECRETS, p);

    const results = await rollbackMigration(env.SECRETS, p);

    expect(results.map((r) => [r.migrationName, r.direction, r.status])).toEqual([
      ["0100_secrets_0001_init", "Down", "Success"],
    ]);
    expect(await secretsTables()).toEqual([]);
  });
});
