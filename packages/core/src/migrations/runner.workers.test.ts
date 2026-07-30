// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { Migration, MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import { InternalError } from "../error/pithyError";
import { createMigrationRegistry } from "./registry";
import { dropMigrations, pendingMigrations, rollbackMigration, runMigrations } from "./runner";

/** The provider for a database name, asserting it was registered (narrows the indexed access). */
function providerFor(registry: Record<string, MigrationProvider>, database: string): MigrationProvider {
  const provider = registry[database];
  if (!provider) throw new Error(`expected a provider for database "${database}"`);
  return provider;
}

const createThings: Migration = {
  up: async (db) => {
    await db.schema
      .createTable("things")
      .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
      .addColumn("label", "text", (c) => c.notNull())
      .execute();
  },
  down: async (db) => {
    await db.schema.dropTable("things").execute();
  },
};

const createWidgets: Migration = {
  up: async (db) => {
    await db.schema
      .createTable("widgets")
      .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
      .execute();
  },
  down: async (db) => {
    await db.schema.dropTable("widgets").execute();
  },
};

async function tableNames(): Promise<string[]> {
  const rows = await env.DB.prepare(
    "select name from sqlite_master where type = 'table' and name in ('things', 'widgets')",
  ).all<{ name: string }>();
  return rows.results.map((row) => row.name).sort();
}

async function migrationTableNames(): Promise<string[]> {
  const rows = await env.DB.prepare(
    "select name from sqlite_master where type = 'table' and name like '%migration%'",
  ).all<{ name: string }>();
  return rows.results.map((row) => row.name).sort();
}

beforeEach(async () => {
  // Each test starts from a blank slate: no app tables, no migration bookkeeping state.
  for (const table of [
    "widgets",
    "things",
    "kysely_migration",
    "kysely_migration_lock",
    "pithy_migrations",
    "pithy_migrations_lock",
  ]) {
    await env.DB.prepare(`drop table if exists ${table}`).run();
  }
});

describe("runMigrations", () => {
  test("runs a registry's migrations to latest against D1", async () => {
    const registry = createMigrationRegistry([
      {
        database: "app",
        namespace: "core",
        order: 0,
        migrations: { "0001_things": createThings, "0002_widgets": createWidgets },
      },
    ]);

    const results = await runMigrations(env.DB, providerFor(registry, "app"));

    expect(results.map((r) => [r.migrationName, r.direction, r.status])).toEqual([
      ["0000_core_0001_things", "Up", "Success"],
      ["0000_core_0002_widgets", "Up", "Success"],
    ]);

    // The tables exist and are queryable.
    const count = await env.DB.prepare("select count(*) as n from things").first<{ n: number }>();
    expect(count?.n).toBe(0);
    expect(await tableNames()).toEqual(["things", "widgets"]);
  });

  test("a second run is a no-op — already-applied migrations stay applied", async () => {
    const registry = createMigrationRegistry([
      { database: "app", namespace: "core", order: 0, migrations: { "0001_things": createThings } },
    ]);
    const provider = providerFor(registry, "app");
    await runMigrations(env.DB, provider);

    const results = await runMigrations(env.DB, provider);

    expect(results).toEqual([]);
    expect(await tableNames()).toEqual(["things"]);
  });

  test("records bookkeeping in pithy_ tables, never the default kysely_migration (adopter collision)", async () => {
    const registry = createMigrationRegistry([
      { database: "app", namespace: "core", order: 0, migrations: { "0001_things": createThings } },
    ]);

    await runMigrations(env.DB, providerFor(registry, "app"));

    // The prefix keeps an adopter's own Kysely migrations on the same D1 from colliding (principle 1).
    expect(await migrationTableNames()).toEqual(["pithy_migrations", "pithy_migrations_lock"]);
  });

  test("an empty provider is a no-op success", async () => {
    const registry = createMigrationRegistry([{ database: "app", namespace: "core", order: 0, migrations: {} }]);

    const results = await runMigrations(env.DB, providerFor(registry, "app"));

    expect(results).toEqual([]);
  });

  test("a failing migration surfaces its error and which key failed", async () => {
    const registry = createMigrationRegistry([
      {
        database: "app",
        namespace: "core",
        order: 0,
        migrations: {
          "0001_things": createThings,
          "0002_boom": {
            up: async () => {
              throw new Error("boom");
            },
            down: async () => {},
          },
        },
      },
    ]);

    const failure: unknown = await runMigrations(env.DB, providerFor(registry, "app")).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(InternalError);
    const error = failure as InternalError;
    expect(error.payload.message).toBe('Couldn\'t apply "0000_core_0002_boom".');
    expect(error.payload.action).toBe("Fix the migration. Run pithy migrate again.");
    // D1 applies migrations non-transactionally, so the error names what stuck.
    expect(error.payload.detail).toBe('boom. Applied before the failure: "0000_core_0001_things".');
    expect(error.cause).toBeInstanceOf(Error);

    // D1 has no transactional DDL: the migration before the failure stays applied.
    expect(await tableNames()).toEqual(["things"]);
  });
});

describe("pendingMigrations", () => {
  test("counts un-run migrations without applying them, and reaches zero once run", async () => {
    const registry = createMigrationRegistry([
      {
        database: "app",
        namespace: "core",
        order: 0,
        migrations: { "0001_things": createThings, "0002_widgets": createWidgets },
      },
    ]);
    const provider = providerFor(registry, "app");

    expect(await pendingMigrations(env.DB, provider)).toBe(2);
    // Counting is read-only: no tables were created.
    expect(await tableNames()).toEqual([]);

    await runMigrations(env.DB, provider);
    expect(await pendingMigrations(env.DB, provider)).toBe(0);
  });
});

describe("dropMigrations", () => {
  /** The applied migration names in the shared ledger, for asserting surgical cleanup. */
  async function ledgerNames(): Promise<string[]> {
    const rows = await env.DB.prepare("select name from pithy_migrations order by name").all<{ name: string }>();
    return rows.results.map((row) => row.name);
  }

  test("drops one capability's migrations, leaving another capability's tables and ledger intact", async () => {
    // Two capabilities share the `app` database; the full registry runs like `pithy migrate` does.
    const combined = createMigrationRegistry([
      { database: "app", namespace: "a", order: 100, migrations: { "0001_things": createThings } },
      { database: "app", namespace: "b", order: 200, migrations: { "0001_widgets": createWidgets } },
    ]);
    await runMigrations(env.DB, providerFor(combined, "app"));
    expect(await tableNames()).toEqual(["things", "widgets"]);

    // Remove capability "b": a single-capability provider drops only its migrations.
    const bOnly = createMigrationRegistry([
      { database: "app", namespace: "b", order: 200, migrations: { "0001_widgets": createWidgets } },
    ]);
    const results = await dropMigrations(env.DB, providerFor(bOnly, "app"));

    expect(results.map((r) => [r.migrationName, r.direction, r.status])).toEqual([
      ["0200_b_0001_widgets", "Down", "Success"],
    ]);
    // "b"'s table is gone; "a"'s table and its ledger row survive.
    expect(await tableNames()).toEqual(["things"]);
    expect(await ledgerNames()).toEqual(["0100_a_0001_things"]);
  });

  test("dropping a capability whose migrations were never applied is a no-op", async () => {
    const bOnly = createMigrationRegistry([
      { database: "app", namespace: "b", order: 200, migrations: { "0001_widgets": createWidgets } },
    ]);
    expect(await dropMigrations(env.DB, providerFor(bOnly, "app"))).toEqual([]);
    expect(await tableNames()).toEqual([]);
  });

  test("a migration with no down is left in place — table and ledger row both kept, not desynced", async () => {
    // An up-only migration (against convention): applied, but not reversible.
    const upOnly: Migration = {
      up: async (db) => {
        await db.schema
          .createTable("widgets")
          .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
          .execute();
      },
    };
    const registry = createMigrationRegistry([
      { database: "app", namespace: "b", order: 200, migrations: { "0001_widgets": upOnly } },
    ]);
    await runMigrations(env.DB, providerFor(registry, "app"));

    const results = await dropMigrations(env.DB, providerFor(registry, "app"));

    expect(results).toEqual([]); // nothing dropped — no down to run
    expect(await tableNames()).toEqual(["widgets"]); // table stays
    const rows = await env.DB.prepare("select name from pithy_migrations").all<{ name: string }>();
    expect(rows.results.map((r) => r.name)).toEqual(["0200_b_0001_widgets"]); // ledger row stays too
  });
});

describe("rollbackMigration", () => {
  test("reverses only the latest migration", async () => {
    const registry = createMigrationRegistry([
      {
        database: "app",
        namespace: "core",
        order: 0,
        migrations: { "0001_things": createThings, "0002_widgets": createWidgets },
      },
    ]);
    const provider = providerFor(registry, "app");
    await runMigrations(env.DB, provider);

    const results = await rollbackMigration(env.DB, provider);

    expect(results.map((r) => [r.migrationName, r.direction, r.status])).toEqual([
      ["0000_core_0002_widgets", "Down", "Success"],
    ]);
    expect(await tableNames()).toEqual(["things"]);
  });

  test("rolling back with nothing applied is a no-op", async () => {
    const registry = createMigrationRegistry([
      { database: "app", namespace: "core", order: 0, migrations: { "0001_things": createThings } },
    ]);

    const results = await rollbackMigration(env.DB, providerFor(registry, "app"));

    expect(results).toEqual([]);
  });
});
