// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { rollbackMigration, runMigrations } from "@pithy-sh/core/src/migrations/runner";
import type { MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import { secretsMigrations } from "./secretsMigrations";

/** The secrets capability's whole chain, as `pithy migrate` composes it. */
function provider(): MigrationProvider {
  const found = createMigrationRegistry([
    { database: "secrets", namespace: "secrets", order: 100, migrations: { ...secretsMigrations } },
  ]).secrets;
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
    "pithy_secrets_reencryptions",
    "pithy_secrets_tables",
    "pithy_secrets_rotations",
    "pithy_secrets_system_secrets",
    "pithy_migrations",
    "pithy_migrations_lock",
  ]) {
    await env.SECRETS.prepare(`drop table if exists ${table}`).run();
  }
});

describe("secrets_0003_reencryptions", () => {
  test("up appends the re-encryption record after 0002, keyed by secret, dependent and holder", async () => {
    const results = await runMigrations(env.SECRETS, provider());
    expect(results.map((r) => [r.migrationName, r.status])).toEqual([
      ["0100_secrets_0001_init", "Success"],
      ["0100_secrets_0002_tables", "Success"],
      ["0100_secrets_0003_reencryptions", "Success"],
    ]);
    expect(await secretsTables()).toContain("pithy_secrets_reencryptions");
    const insert = (holder: string, version: string): Promise<unknown> =>
      env.SECRETS.prepare(
        "insert into pithy_secrets_reencryptions (name, dependent, holder, version, fingerprint, observed_at) values ('auth-session-secret', 'auth-jwks', ?, ?, 'ab', 1)",
      )
        .bind(holder, version)
        .run();
    await insert("DB", "2");
    await expect(insert("DB", "3")).rejects.toThrow();
    // A second database holding the same dependent is its own row.
    await insert("COLLAB_DB", "2");
  });

  test("down drops it and leaves the earlier tables alone", async () => {
    const p = provider();
    await runMigrations(env.SECRETS, p);
    const [result] = await rollbackMigration(env.SECRETS, p);
    expect(result?.migrationName).toBe("0100_secrets_0003_reencryptions");
    expect(await secretsTables()).toEqual([
      "pithy_secrets_rotations",
      "pithy_secrets_system_secrets",
      "pithy_secrets_tables",
    ]);
  });
});
