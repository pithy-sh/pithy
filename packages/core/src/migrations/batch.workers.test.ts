// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { D1Database, D1PreparedStatement, D1Result } from "@cloudflare/workers-types";
import { sql } from "kysely";
import type { Migration, MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import { InternalError } from "../error/pithyError";
import { createMigrationRegistry } from "./registry";
import { dropMigrations, resetMigrations, rollbackMigration, runMigrations } from "./runner";

/**
 * These tests are about **how many times the runner talks to D1**, and what a failure leaves behind
 * when it talks once. Both are invisible to a test that only asserts the resulting schema — which is
 * exactly why the per-statement cost survived to be 78% of an adopter's suite (#368).
 */

/** Round trips to D1, counted at the binding: one per executed statement, one per batch. */
interface RoundTrips {
  /** Single statements executed on their own — every one a hop. */
  single: number;
  /** `d1.batch()` calls — one hop each, whatever they carry. */
  batch: number;
  /** Statements carried inside those batches, for asserting a batch is not secretly empty. */
  batched: number;
}

/**
 * A binding that counts round trips. `prepare` and `bind` are local — the adopter lane that filed
 * #368 measured `prepare` at 2ms and refuted its own hypothesis — so only the terminal calls count.
 */
function counting(database: D1Database): { db: D1Database; trips: RoundTrips } {
  const trips: RoundTrips = { single: 0, batch: 0, batched: 0 };
  const countTerminals = <T extends object>(target: T): T =>
    new Proxy(target, {
      get(inner, property) {
        const value = Reflect.get(inner, property);
        if (typeof value !== "function") return value;
        if (property === "bind") {
          return (...parameters: unknown[]) => countTerminals(value.apply(inner, parameters) as object);
        }
        if (property === "all" || property === "run" || property === "first" || property === "raw") {
          return (...parameters: unknown[]) => {
            trips.single += 1;
            return value.apply(inner, parameters);
          };
        }
        return value.bind(inner);
      },
    });

  const db = new Proxy(database, {
    get(target, property, receiver) {
      if (property === "prepare") {
        return (statement: string) => countTerminals(target.prepare(statement));
      }
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]): Promise<D1Result[]> => {
          trips.batch += 1;
          trips.batched += statements.length;
          return target.batch(statements);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db, trips };
}

function providerFor(registry: Record<string, MigrationProvider>, database: string): MigrationProvider {
  const provider = registry[database];
  if (!provider) throw new Error(`expected a provider for database "${database}"`);
  return provider;
}

/** Six statements: three tables, three indexes. One migration, and so one round trip. */
const sixStatements: Migration = {
  up: async (db) => {
    for (const name of ["alpha", "beta", "gamma"]) {
      await db.schema
        .createTable(name)
        .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
        .addColumn("label", "text", (c) => c.notNull())
        .execute();
      await db.schema.createIndex(`${name}Label`).on(name).column("label").execute();
    }
  },
  down: async (db) => {
    for (const name of ["gamma", "beta", "alpha"]) {
      await db.schema.dropIndex(`${name}Label`).execute();
      await db.schema.dropTable(name).execute();
    }
  },
};

const createDelta: Migration = {
  up: async (db) => {
    await db.schema
      .createTable("delta")
      .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
      .execute();
  },
  down: async (db) => {
    await db.schema.dropTable("delta").execute();
  },
};

const APP_TABLES = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"];

async function tableNames(): Promise<string[]> {
  const rows = await env.DB.prepare(
    `select name from sqlite_master where type = 'table' and name in (${APP_TABLES.map((t) => `'${t}'`).join(", ")})`,
  ).all<{ name: string }>();
  return rows.results.map((row) => row.name).sort();
}

async function ledgerNames(): Promise<string[]> {
  const rows = await env.DB.prepare(
    "select name from sqlite_master where type = 'table' and name = 'pithy_migrations'",
  ).all<{ name: string }>();
  if (rows.results.length === 0) return [];
  const applied = await env.DB.prepare("select name from pithy_migrations order by name").all<{ name: string }>();
  return applied.results.map((row) => row.name);
}

beforeEach(async () => {
  for (const table of [...APP_TABLES, "pithy_migrations", "pithy_migrations_lock"]) {
    await env.DB.prepare(`drop table if exists ${table}`).run();
  }
});

describe("one round trip per migration", () => {
  test("a six-statement migration applies in one batch, not six hops", async () => {
    const { db, trips } = counting(env.DB);
    const registry = createMigrationRegistry([
      { database: "app", namespace: "core", order: 0, migrations: { "0001_six": sixStatements } },
    ]);

    await runMigrations(db, providerFor(registry, "app"));

    // The whole migration body: one hop carrying all six statements.
    expect(trips.batch).toBe(1);
    expect(trips.batched).toBe(6);
    expect(await tableNames()).toEqual(["alpha", "beta", "gamma"]);
  });

  test("two migrations are two batches — never one, whatever it would save", async () => {
    const { db, trips } = counting(env.DB);
    const registry = createMigrationRegistry([
      {
        database: "app",
        namespace: "core",
        order: 0,
        migrations: { "0001_six": sixStatements, "0002_delta": createDelta },
      },
    ]);

    await runMigrations(db, providerFor(registry, "app"));

    // A batch is a transaction. Merging two migrations into one would make a partial chain
    // unrepresentable in the ledger, which is worse than slow.
    expect(trips.batch).toBe(2);
    expect(trips.batched).toBe(7);
    expect(await ledgerNames()).toEqual(["0000_core_0001_six", "0000_core_0002_delta"]);
  });

  test("`down` gets the same treatment — a rollback is one batch too", async () => {
    const registry = createMigrationRegistry([
      { database: "app", namespace: "core", order: 0, migrations: { "0001_six": sixStatements } },
    ]);
    const provider = providerFor(registry, "app");
    await runMigrations(env.DB, provider);

    const { db, trips } = counting(env.DB);
    await rollbackMigration(db, provider);

    expect(trips.batch).toBe(1);
    expect(trips.batched).toBe(6);
    expect(await tableNames()).toEqual([]);
  });

  test("a full reset is one batch down and one batch up, not twelve hops", async () => {
    const registry = createMigrationRegistry([
      { database: "app", namespace: "core", order: 0, migrations: { "0001_six": sixStatements } },
    ]);
    const provider = providerFor(registry, "app");
    await runMigrations(env.DB, provider);

    const { db, trips } = counting(env.DB);
    await resetMigrations(db, provider);

    // The per-test drop-and-rebuild an adopter pays: two hops for twelve statements.
    expect(trips.batch).toBe(2);
    expect(trips.batched).toBe(12);
    expect(await tableNames()).toEqual(["alpha", "beta", "gamma"]);
  });

  test("`pithy remove --drop` batches its capability's down as well", async () => {
    const registry = createMigrationRegistry([
      { database: "app", namespace: "core", order: 0, migrations: { "0001_six": sixStatements } },
    ]);
    const provider = providerFor(registry, "app");
    await runMigrations(env.DB, provider);

    const { db, trips } = counting(env.DB);
    await dropMigrations(db, provider);

    expect(trips.batch).toBe(1);
    expect(trips.batched).toBe(6);
    expect(await tableNames()).toEqual([]);
    expect(await ledgerNames()).toEqual([]);
  });
});

describe("failure semantics", () => {
  /** Five good statements, then one D1 refuses. The failure is at execution, not compilation. */
  const failsHalfway: Migration = {
    up: async (db) => {
      await db.schema
        .createTable("alpha")
        .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
        .execute();
      await db.schema.createIndex("alphaId").on("alpha").column("id").execute();
      await db.schema
        .createTable("beta")
        .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
        .execute();
      await db.schema.createIndex("betaId").on("beta").column("id").execute();
      await db.schema
        .createTable("gamma")
        .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
        .execute();
      // There is no such table. D1 rejects the statement, and with it the batch.
      await db.schema.createIndex("nowhereId").on("nowhere").column("id").execute();
    },
    down: async (db) => {
      await db.schema.dropTable("gamma").execute();
      await db.schema.dropTable("beta").execute();
      await db.schema.dropTable("alpha").execute();
    },
  };

  test("a migration that fails partway applies nothing of itself — the batch is the unit", async () => {
    const registry = createMigrationRegistry([
      { database: "app", namespace: "core", order: 0, migrations: { "0001_halfway": failsHalfway } },
    ]);

    await expect(runMigrations(env.DB, providerFor(registry, "app"))).rejects.toBeInstanceOf(InternalError);

    // **This is the behavior change.** One statement per round trip left `alpha`, `beta` and `gamma`
    // behind with no ledger row — a half-applied migration, the thing a chain exists to prevent.
    // Under `batch` the transaction rolls back and the database is untouched.
    expect(await tableNames()).toEqual([]);
    expect(await ledgerNames()).toEqual([]);
  });

  test("a failure still names the migration, the binding, and what D1 actually said", async () => {
    const registry = createMigrationRegistry([
      { database: "app", namespace: "core", order: 0, migrations: { "0001_halfway": failsHalfway } },
    ]);

    const failure: unknown = await runMigrations(env.DB, providerFor(registry, "app"), {
      binding: "DB",
      database: "app",
    }).catch((error: unknown) => error);

    const error = failure as InternalError;
    // The reason has to survive batching: it is the actionable half, and `detail` is never rendered.
    expect(error.payload.message).toContain('Couldn\'t apply "0000_core_0001_halfway" on DB.');
    expect(error.payload.message).toContain("nowhere");
    expect(error.payload.action).toBe("Fix the migration. Run pithy migrate again.");
  });

  test("earlier migrations stay applied and stay recorded — nothing crosses the boundary", async () => {
    const registry = createMigrationRegistry([
      {
        database: "app",
        namespace: "core",
        order: 0,
        migrations: { "0001_delta": createDelta, "0002_halfway": failsHalfway },
      },
    ]);

    const failure: unknown = await runMigrations(env.DB, providerFor(registry, "app"), {
      binding: "DB",
      database: "app",
    }).catch((error: unknown) => error);

    // Unchanged from before batching: the chain is applied migration by migration, and a failure
    // stops it where it stands. Only what is *inside* one migration became atomic.
    expect(await tableNames()).toEqual(["delta"]);
    expect(await ledgerNames()).toEqual(["0000_core_0001_delta"]);
    expect((failure as InternalError).payload.detail).toContain('Applied before the failure: "0000_core_0001_delta".');
  });

  test("a body that throws before touching D1 sends nothing at all", async () => {
    const { db, trips } = counting(env.DB);
    const registry = createMigrationRegistry([
      {
        database: "app",
        namespace: "core",
        order: 0,
        migrations: {
          "0001_boom": {
            up: async () => {
              throw new Error("boom");
            },
            down: async () => {},
          },
        },
      },
    ]);

    await expect(runMigrations(db, providerFor(registry, "app"))).rejects.toBeInstanceOf(InternalError);

    expect(trips.batch).toBe(0);
    expect(await ledgerNames()).toEqual([]);
  });
});

describe("statements that carry a result are never queued", () => {
  /**
   * DDL, then a write, then more DDL, then a read of the write. A queued statement's result is
   * returned before it has run, so anything with a result to carry has to flush and go on its own —
   * and the read must see everything written before it.
   */
  const readsItsOwnWrites: Migration = {
    up: async (db) => {
      await db.schema
        .createTable("epsilon")
        .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
        .addColumn("label", "text", (c) => c.notNull())
        .execute();
      await db.schema.createIndex("epsilonLabel").on("epsilon").column("label").execute();

      // Not DDL: flushes the two above, then runs on its own.
      await sql`insert into epsilon (label) values ('seed')`.execute(db);

      // Reads what the insert wrote — the ordering guarantee, in the one place it can break.
      const seeded = await sql<{ n: number }>`select count(*) as n from epsilon`.execute(db);
      if (seeded.rows[0]?.n !== 1) throw new Error(`expected the seed row, saw ${seeded.rows[0]?.n}`);

      await db.schema
        .createTable("zeta")
        .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
        .execute();
    },
    down: async (db) => {
      await db.schema.dropTable("zeta").execute();
      await db.schema.dropIndex("epsilonLabel").execute();
      await db.schema.dropTable("epsilon").execute();
    },
  };

  test("a read inside a migration sees the writes before it, and the DDL after it still lands", async () => {
    const { db, trips } = counting(env.DB);
    const registry = createMigrationRegistry([
      { database: "app", namespace: "core", order: 0, migrations: { "0001_mixed": readsItsOwnWrites } },
    ]);

    await runMigrations(db, providerFor(registry, "app"));

    // Two runs of consecutive DDL, so two batches — plus the insert and the select on their own.
    expect(trips.batch).toBe(2);
    expect(trips.batched).toBe(3);
    expect(await tableNames()).toEqual(["epsilon", "zeta"]);
    const rows = await env.DB.prepare("select label from epsilon").all<{ label: string }>();
    expect(rows.results.map((row) => row.label)).toEqual(["seed"]);
  });

  test("a queued statement never answers for one that has not run — an unflushed read would see nothing", async () => {
    // The gate above passes vacuously if the insert were queued and the select returned `[]`; it
    // would throw instead. This states the same thing from the other side: the row is really there
    // when the migration ends, and the ledger recorded the migration that put it there.
    const registry = createMigrationRegistry([
      { database: "app", namespace: "core", order: 0, migrations: { "0001_mixed": readsItsOwnWrites } },
    ]);
    await runMigrations(env.DB, providerFor(registry, "app"));

    expect(await ledgerNames()).toEqual(["0000_core_0001_mixed"]);
  });
});
