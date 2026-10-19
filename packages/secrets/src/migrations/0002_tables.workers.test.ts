// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { rollbackMigration, runMigrations } from "@pithy-sh/core/src/migrations/runner";
import type { MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import { secrets_0001_init } from "./0001_init";
import { secrets_0002_tables } from "./0002_tables";

/** The secrets capability's migration set as `pithy migrate` composes it — `0001` untouched, `0002` appended. */
const SET = {
  database: "secrets",
  namespace: "secrets",
  order: 100,
  migrations: { "0001_init": secrets_0001_init, "0002_tables": secrets_0002_tables },
} as const;

function provider(): MigrationProvider {
  const found = createMigrationRegistry([SET]).secrets;
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
    "pithy_secrets_tables",
    "pithy_secrets_rotations",
    "pithy_secrets_system_secrets",
    "pithy_migrations",
    "pithy_migrations_lock",
  ]) {
    await env.SECRETS.prepare(`drop table if exists ${table}`).run();
  }
});

describe("secrets_0002_tables", () => {
  test("up appends the registry of declared tables after 0001", async () => {
    const results = await runMigrations(env.SECRETS, provider());
    expect(results.map((r) => [r.migrationName, r.status])).toEqual([
      ["0100_secrets_0001_init", "Success"],
      ["0100_secrets_0002_tables", "Success"],
    ]);
    expect(await secretsTables()).toEqual([
      "pithy_secrets_rotations",
      "pithy_secrets_system_secrets",
      "pithy_secrets_tables",
    ]);

    await env.SECRETS.prepare(
      "insert into pithy_secrets_tables (name, keys, secrets, created_at, updated_at) values (?, ?, ?, ?, ?)",
    )
      .bind("customer", '["userId","organizationId"]', '["STRIPE_KEY"]', 1, 1)
      .run();
    const row = await env.SECRETS.prepare("select keys from pithy_secrets_tables where name = ?")
      .bind("customer")
      .first<{ keys: string }>();
    expect(row).toEqual({ keys: '["userId","organizationId"]' });
  });

  test("a table registers once — the name is the key", async () => {
    await runMigrations(env.SECRETS, provider());
    const insert = (): Promise<unknown> =>
      env.SECRETS.prepare(
        "insert into pithy_secrets_tables (name, keys, secrets, created_at, updated_at) values ('customer', '[]', '[]', 1, 1)",
      ).run();
    await insert();
    await expect(insert()).rejects.toThrow();
  });

  test("down drops the registry and leaves 0001's tables alone", async () => {
    const p = provider();
    await runMigrations(env.SECRETS, p);
    const [result] = await rollbackMigration(env.SECRETS, p);
    expect(result?.migrationName).toBe("0100_secrets_0002_tables");
    expect(await secretsTables()).toEqual(["pithy_secrets_rotations", "pithy_secrets_system_secrets"]);
  });
});
