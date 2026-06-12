import { env } from "cloudflare:test";
import type { Migration, MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import { InternalError } from "../error/pithyError";
import { createMigrationRegistry } from "./registry";
import { rollbackMigration, runMigrations } from "./runner";

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

beforeEach(async () => {
  // Each test starts from a blank slate: no app tables, no Kysely migration state.
  for (const table of ["widgets", "things", "kysely_migration", "kysely_migration_lock"]) {
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
