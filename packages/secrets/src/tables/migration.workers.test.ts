// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { rollbackMigration, runMigrations } from "@pithy-sh/core/src/migrations/runner";
import type { Migration, MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import { secrets_0001_init } from "../migrations/0001_init";
import { secrets_0002_tables } from "../migrations/0002_tables";
import { secretTableMigration } from "./migration";

const CREATE = secretTableMigration({
  from: null,
  to: { table: "customer", keys: ["userId", "organizationId"], secrets: ["STRIPE_KEY", "WEBHOOK_SIG"] },
});
const ALTER = secretTableMigration({
  from: { table: "customer", keys: ["userId", "organizationId"], secrets: ["STRIPE_KEY", "WEBHOOK_SIG"] },
  to: {
    table: "customer",
    keys: ["userId", "organizationId", "teamId"],
    secrets: ["STRIPE_KEY", "WEBHOOK_SIG", "API"],
  },
});

/** The kit's own `secrets` set, then an app's generated set ordered after it — the shape `pithy migrate` composes. */
function provider(app: Record<string, Migration>): MigrationProvider {
  const found = createMigrationRegistry([
    {
      database: "secrets",
      namespace: "secrets",
      order: 100,
      migrations: { "0001_init": secrets_0001_init, "0002_tables": secrets_0002_tables },
    },
    { database: "secrets", namespace: "app", order: 9000, migrations: app },
  ]).secrets;
  if (!found) throw new Error('expected a provider for database "secrets"');
  return found;
}

async function sql<T>(query: string, ...binds: unknown[]): Promise<T[]> {
  return (
    await env.SECRETS.prepare(query)
      .bind(...binds)
      .all<T>()
  ).results;
}

async function columns(): Promise<string[]> {
  return (await sql<{ name: string }>("select name from pragma_table_info('pithy_secrets_customer_secrets')")).map(
    (row) => row.name,
  );
}

async function indexes(): Promise<string[]> {
  return (
    await sql<{ name: string }>(
      "select name from sqlite_master where type = 'index' and tbl_name = 'pithy_secrets_customer_secrets' and name not like 'sqlite_%' order by name",
    )
  ).map((row) => row.name);
}

async function registration(): Promise<{ keys: string; secrets: string } | undefined> {
  const [row] = await sql<{ keys: string; secrets: string }>(
    "select keys, secrets from pithy_secrets_tables where name = 'customer'",
  );
  return row;
}

const insert = (userId: string, organizationId: string, name: string): Promise<unknown> =>
  env.SECRETS.prepare(
    "insert into pithy_secrets_customer_secrets (name, encrypted_value, iv, key_version, value_type, created_at, updated_at, user_id, organization_id) values (?, 'c', 'i', 1, 'text', 1, 1, ?, ?)",
  )
    .bind(name, userId, organizationId)
    .run();

beforeEach(async () => {
  for (const table of [
    "pithy_secrets_customer_secrets",
    "pithy_secrets_tables",
    "pithy_secrets_rotations",
    "pithy_secrets_system_secrets",
    "pithy_migrations",
    "pithy_migrations_lock",
  ]) {
    await env.SECRETS.prepare(`drop table if exists ${table}`).run();
  }
});

describe("secretTableMigration — create", () => {
  test("carries the plan it applies, for the next diff to fold", () => {
    expect(CREATE.secretTable).toEqual({
      from: null,
      to: { table: "customer", keys: ["userId", "organizationId"], secrets: ["STRIPE_KEY", "WEBHOOK_SIG"] },
    });
  });

  test("creates the base columns plus the key columns, an owner index and an index per key", async () => {
    await runMigrations(env.SECRETS, provider({ "0001_customer_init": CREATE }));
    expect(await columns()).toEqual([
      "id",
      "name",
      "encrypted_value",
      "iv",
      "key_version",
      "value_type",
      "created_at",
      "updated_at",
      "user_id",
      "organization_id",
    ]);
    expect(await indexes()).toEqual([
      "pithy_secrets_customer_secrets_organization_id_idx",
      "pithy_secrets_customer_secrets_owner_idx",
      "pithy_secrets_customer_secrets_user_id_idx",
    ]);
  });

  test("is unique on the keys and the name", async () => {
    await runMigrations(env.SECRETS, provider({ "0001_customer_init": CREATE }));
    await insert("u1", "o1", "STRIPE_KEY");
    await insert("u1", "o1", "WEBHOOK_SIG");
    await insert("u2", "o1", "STRIPE_KEY");
    await expect(insert("u1", "o1", "STRIPE_KEY")).rejects.toThrow();
  });

  test("registers the table in pithy_secrets_tables", async () => {
    await runMigrations(env.SECRETS, provider({ "0001_customer_init": CREATE }));
    expect(await registration()).toEqual({
      keys: '["userId","organizationId"]',
      secrets: '["STRIPE_KEY","WEBHOOK_SIG"]',
    });
  });

  test("down unregisters the table and drops it", async () => {
    const p = provider({ "0001_customer_init": CREATE });
    await runMigrations(env.SECRETS, p);
    const [result] = await rollbackMigration(env.SECRETS, p);
    expect(result?.migrationName).toBe("9000_app_0001_customer_init");
    expect(await registration()).toBeUndefined();
    expect(await columns()).toEqual([]);
  });
});

describe("secretTableMigration — alter", () => {
  test("adds the key column, widens the owner index and updates the registration", async () => {
    await runMigrations(env.SECRETS, provider({ "0001_customer_init": CREATE }));
    await insert("u1", "o1", "STRIPE_KEY");
    await runMigrations(env.SECRETS, provider({ "0001_customer_init": CREATE, "0002_customer_team_id": ALTER }));

    expect(await columns()).toContain("team_id");
    expect(await indexes()).toEqual([
      "pithy_secrets_customer_secrets_organization_id_idx",
      "pithy_secrets_customer_secrets_owner_idx",
      "pithy_secrets_customer_secrets_team_id_idx",
      "pithy_secrets_customer_secrets_user_id_idx",
    ]);
    expect(await registration()).toEqual({
      keys: '["userId","organizationId","teamId"]',
      secrets: '["STRIPE_KEY","WEBHOOK_SIG","API"]',
    });
    // A row written before the key existed holds the empty string there, so its bound context is unchanged.
    const [row] = await sql<{ team_id: string }>("select team_id from pithy_secrets_customer_secrets");
    expect(row).toEqual({ team_id: "" });
  });

  test("down restores the previous shape and registration", async () => {
    const p = provider({ "0001_customer_init": CREATE, "0002_customer_team_id": ALTER });
    await runMigrations(env.SECRETS, p);
    const [result] = await rollbackMigration(env.SECRETS, p);
    expect(result?.migrationName).toBe("9000_app_0002_customer_team_id");
    expect(await columns()).not.toContain("team_id");
    expect(await indexes()).toEqual([
      "pithy_secrets_customer_secrets_organization_id_idx",
      "pithy_secrets_customer_secrets_owner_idx",
      "pithy_secrets_customer_secrets_user_id_idx",
    ]);
    expect(await registration()).toEqual({
      keys: '["userId","organizationId"]',
      secrets: '["STRIPE_KEY","WEBHOOK_SIG"]',
    });
  });

  test("refuses a plan that drops or reorders a key, rather than writing it", () => {
    expect(() =>
      secretTableMigration({
        from: { table: "customer", keys: ["userId", "organizationId"], secrets: ["A"] },
        to: { table: "customer", keys: ["userId"], secrets: ["A"] },
      }),
    ).toThrow(/organizationId/);
    expect(() =>
      secretTableMigration({
        from: { table: "customer", keys: ["userId"], secrets: ["A"] },
        to: { table: "other", keys: ["userId"], secrets: ["A"] },
      }),
    ).toThrow(/one table/);
  });
});
