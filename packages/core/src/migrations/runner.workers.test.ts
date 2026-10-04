// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { Migration, MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import { InternalError, ValidationError } from "../error/pithyError";
import { forgetMigrationGroups, readMigrationGroups } from "./groups";
import { createMigrationRegistry, type NamespacedMigrations } from "./registry";
import { RetainedBudget } from "./retained";
import { dropMigrations, readMigrationLedger, reverseMigrationGroup, rollbackMigration, runMigrations } from "./runner";

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

const createGadgets: Migration = {
  up: async (db) => {
    await db.schema
      .createTable("gadgets")
      .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
      .execute();
  },
  down: async (db) => {
    await db.schema.dropTable("gadgets").execute();
  },
};

async function tableNames(): Promise<string[]> {
  const rows = await env.DB.prepare(
    "select name from sqlite_master where type = 'table' and name in ('things', 'widgets', 'gadgets')",
  ).all<{ name: string }>();
  return rows.results.map((row) => row.name).sort();
}

async function migrationTableNames(): Promise<string[]> {
  const rows = await env.DB.prepare(
    "select name from sqlite_master where type = 'table' and name like '%migration%'",
  ).all<{ name: string }>();
  return rows.results.map((row) => row.name).sort();
}

/**
 * `env.DB` with every insert into the group table refused — the transient write error the group-record
 * catch branch exists for. Only that one statement fails: the migrations themselves apply, which is the
 * state that makes the remedy line matter.
 */
function groupWritesFail(): typeof env.DB {
  return new Proxy(env.DB, {
    get(target, property) {
      if (property !== "prepare") {
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (query: string) => {
        if (query.includes("insert into") && query.includes("pithy_migrations_groups")) {
          throw new Error("D1_ERROR: database is locked");
        }
        return target.prepare(query);
      };
    },
  });
}

beforeEach(async () => {
  // Each test starts from a blank slate: no app tables, no migration bookkeeping state.
  for (const table of [
    "gadgets",
    "widgets",
    "things",
    "kysely_migration",
    "kysely_migration_lock",
    "pithy_migrations",
    "pithy_migrations_lock",
    "pithy_migrations_groups",
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
    expect(await migrationTableNames()).toEqual([
      "pithy_migrations",
      "pithy_migrations_groups",
      "pithy_migrations_lock",
    ]);
  });

  test("a capability whose order sorts before an applied one still runs — add-order is not schema-order", async () => {
    // The adopter's sequence: `pithy add email` (200), `pithy add auth` (300), `pithy add audit` (250).
    // The ledger holds 0200 then 0300; audit's 0250 sorts between them. Kysely's ordered mode reads that
    // as corrupted state and refuses every later run, so the composed order — the only order Pithy
    // promises — would depend on the order an adopter happened to type.
    const emailOnly = createMigrationRegistry([
      { database: "app", namespace: "email", order: 200, migrations: { "0001_init": createThings } },
    ]);
    await runMigrations(env.DB, providerFor(emailOnly, "app"));

    const withAuth = createMigrationRegistry([
      { database: "app", namespace: "email", order: 200, migrations: { "0001_init": createThings } },
      { database: "app", namespace: "auth", order: 300, migrations: { "0001_init": createWidgets } },
    ]);
    await runMigrations(env.DB, providerFor(withAuth, "app"));

    const withAudit = createMigrationRegistry([
      { database: "app", namespace: "email", order: 200, migrations: { "0001_init": createThings } },
      { database: "app", namespace: "audit", order: 250, migrations: { "0001_init": createGadgets } },
      { database: "app", namespace: "auth", order: 300, migrations: { "0001_init": createWidgets } },
    ]);
    const results = await runMigrations(env.DB, providerFor(withAudit, "app"));

    expect(results.map((r) => [r.migrationName, r.direction, r.status])).toEqual([
      ["0250_audit_0001_init", "Up", "Success"],
    ]);
    expect(await tableNames()).toEqual(["gadgets", "things", "widgets"]);
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

    const failure: unknown = await runMigrations(env.DB, providerFor(registry, "app"), {
      binding: "DB",
      database: "app",
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(InternalError);
    const error = failure as InternalError;
    // The key, the database, and what the runtime actually said — all in the field that is rendered.
    // `boom` used to live in `detail` alone, which the terminal never prints (#282).
    expect(error.payload.message).toBe('Couldn\'t apply "0000_core_0002_boom" on DB. boom.');
    expect(error.payload.action).toBe("Fix the migration. Run pithy migrate again.");
    // D1 applies migrations non-transactionally, so the error names what stuck.
    expect(error.payload.detail).toBe(
      'Database "app" on binding DB. Applied before the failure: "0000_core_0001_things".',
    );
    expect(error.cause).toBeInstanceOf(Error);

    // D1 has no transactional DDL: the migration before the failure stays applied.
    expect(await tableNames()).toEqual(["things"]);
  });
});

describe("readMigrationLedger", () => {
  test("reports un-run migrations without applying them, and reaches zero once run", async () => {
    const registry = createMigrationRegistry([
      {
        database: "app",
        namespace: "core",
        order: 0,
        migrations: { "0001_things": createThings, "0002_widgets": createWidgets },
      },
    ]);
    const provider = providerFor(registry, "app");

    expect(await readMigrationLedger(env.DB, provider)).toEqual({
      pending: ["0000_core_0001_things", "0000_core_0002_widgets"],
      undeclared: [],
    });
    // Reading is read-only: no tables were created.
    expect(await tableNames()).toEqual([]);

    await runMigrations(env.DB, provider);
    expect(await readMigrationLedger(env.DB, provider)).toEqual({ pending: [], undeclared: [] });
  });

  test("names an applied migration the declaration has dropped — what a pending count cannot see", async () => {
    const both = providerFor(
      createMigrationRegistry([
        {
          database: "app",
          namespace: "core",
          order: 0,
          migrations: { "0001_things": createThings, "0002_widgets": createWidgets },
        },
      ]),
      "app",
    );
    await runMigrations(env.DB, both);

    // The declaration loses one. Nothing is missing from the database, so nothing is pending — and that
    // is exactly the state `pithy doctor` used to call healthy while `migrate` refused to run (#282).
    const fewer = providerFor(
      createMigrationRegistry([
        { database: "app", namespace: "core", order: 0, migrations: { "0001_things": createThings } },
      ]),
      "app",
    );

    expect(await readMigrationLedger(env.DB, fewer)).toEqual({
      pending: [],
      undeclared: ["0000_core_0002_widgets"],
    });
  });

  test("a database with no ledger table has applied nothing and declares everything as pending", async () => {
    const provider = providerFor(
      createMigrationRegistry([
        { database: "app", namespace: "core", order: 0, migrations: { "0001_things": createThings } },
      ]),
      "app",
    );
    expect(await readMigrationLedger(env.DB, provider)).toEqual({ pending: ["0000_core_0001_things"], undeclared: [] });
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
    const results = await dropMigrations(env.DB, {
      database: providerFor(combined, "app"),
      reverse: providerFor(bOnly, "app"),
    });

    expect(results.map((r) => [r.migrationName, r.direction, r.status])).toEqual([
      ["0200_b_0001_widgets", "Down", "Success"],
    ]);
    // "b"'s table is gone; "a"'s table and its ledger row survive.
    expect(await tableNames()).toEqual(["things"]);
    expect(await ledgerNames()).toEqual(["0100_a_0001_things"]);
  });

  test("a drop is counted over the whole database: another capability's retained rows refuse it (#588)", async () => {
    // "a" declares `things` retained; "b" declares nothing and shares the database. Dropping "b" alone used to
    // count what "b" declared — nothing — and run its `down` beside a table holding rows.
    // A `down` of its own, so declaring it retained marks nothing another test in this file composes.
    const keptThings: Migration = { up: createThings.up, down: async (db) => createThings.down?.(db) };
    const a: NamespacedMigrations = {
      database: "app",
      namespace: "a",
      order: 100,
      migrations: { "0001_things": keptThings },
      retained: ["things"],
    };
    const b: NamespacedMigrations = {
      database: "app",
      namespace: "b",
      order: 200,
      migrations: { "0001_widgets": createWidgets },
    };
    const combined = providerFor(createMigrationRegistry([a, b]), "app");
    await runMigrations(env.DB, combined);
    await env.DB.prepare("insert into things (label) values ('kept')").run();
    const bOnly = providerFor(createMigrationRegistry([b]), "app");

    await expect(dropMigrations(env.DB, { database: combined, reverse: bOnly })).rejects.toThrow(
      "Retained 1 row would be dropped: things on this database (1 row).",
    );
    expect(await tableNames()).toEqual(["things", "widgets"]);
    expect(await ledgerNames()).toEqual(["0100_a_0001_things", "0200_b_0001_widgets"]);

    const results = await dropMigrations(env.DB, { database: combined, reverse: bOnly }, undefined, {
      budget: new RetainedBudget(1),
    });
    expect(results.map((r) => r.migrationName)).toEqual(["0200_b_0001_widgets"]);
    expect(await tableNames()).toEqual(["things"]);
  });

  test("a drop refuses to reverse a migration the database's set does not carry", async () => {
    const aOnly = providerFor(
      createMigrationRegistry([
        { database: "app", namespace: "a", order: 100, migrations: { "0001_things": createThings } },
      ]),
      "app",
    );
    const bOnly = providerFor(
      createMigrationRegistry([
        { database: "app", namespace: "b", order: 200, migrations: { "0001_widgets": createWidgets } },
      ]),
      "app",
    );
    await expect(dropMigrations(env.DB, { database: aOnly, reverse: bOnly })).rejects.toThrow(InternalError);
  });

  test("dropping a capability whose migrations were never applied is a no-op", async () => {
    const bOnly = createMigrationRegistry([
      { database: "app", namespace: "b", order: 200, migrations: { "0001_widgets": createWidgets } },
    ]);
    const b = providerFor(bOnly, "app");
    expect(await dropMigrations(env.DB, { database: b, reverse: b })).toEqual([]);
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

    const provider = providerFor(registry, "app");
    const results = await dropMigrations(env.DB, { database: provider, reverse: provider });

    expect(results).toEqual([]); // nothing dropped — no down to run
    expect(await tableNames()).toEqual(["widgets"]); // table stays
    const rows = await env.DB.prepare("select name from pithy_migrations").all<{ name: string }>();
    expect(rows.results.map((r) => r.name)).toEqual(["0200_b_0001_widgets"]); // ledger row stays too
  });
});

describe("runMigrations records the run's group", () => {
  test("records every migration it applied under the caller's group", async () => {
    const registry = createMigrationRegistry([
      {
        database: "app",
        namespace: "core",
        order: 0,
        migrations: { "0001_things": createThings, "0002_widgets": createWidgets },
      },
    ]);

    await runMigrations(env.DB, providerFor(registry, "app"), undefined, { group: "release-7" });

    expect(await readMigrationGroups(env.DB)).toEqual([
      {
        group: "release-7",
        appliedAt: expect.any(Date),
        migrations: ["0000_core_0001_things", "0000_core_0002_widgets"],
      },
    ]);
  });

  test("generates an ISO-8601 timestamp group when the caller names none", async () => {
    const registry = createMigrationRegistry([
      { database: "app", namespace: "core", order: 0, migrations: { "0001_things": createThings } },
    ]);

    await runMigrations(env.DB, providerFor(registry, "app"));

    const groups = await readMigrationGroups(env.DB);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.group).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  test("a no-op run records nothing — there is no migration to belong to a group", async () => {
    const registry = createMigrationRegistry([
      { database: "app", namespace: "core", order: 0, migrations: { "0001_things": createThings } },
    ]);
    const provider = providerFor(registry, "app");
    await runMigrations(env.DB, provider, undefined, { group: "r1" });

    await runMigrations(env.DB, provider, undefined, { group: "r2" });

    expect((await readMigrationGroups(env.DB)).map((entry) => entry.group)).toEqual(["r1"]);
  });

  test("a failed group write names what applied, and promises no retry that would record nothing", async () => {
    const registry = createMigrationRegistry([
      {
        database: "app",
        namespace: "core",
        order: 0,
        migrations: { "0001_things": createThings, "0002_widgets": createWidgets },
      },
    ]);

    const failure: unknown = await runMigrations(
      groupWritesFail(),
      providerFor(registry, "app"),
      { binding: "DB", database: "app" },
      { group: "release-7" },
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(InternalError);
    expect((failure as InternalError).payload.message).toBe(
      "Applied 2 migrations on DB, then couldn't record the group.",
    );
    // Not "run pithy migrate again to record the group": the second run has nothing pending, so it records
    // nothing and exits 0, and the operator reads that as the group having been recorded.
    expect((failure as InternalError).payload.action).toBe(
      "Check the database is writable. A second pithy migrate records nothing for them, so they cannot be reversed by group.",
    );
    // Which is the state the line has to be honest about: the schema is promoted, and nothing groups it.
    expect(await tableNames()).toEqual(["things", "widgets"]);
    expect(await readMigrationGroups(env.DB)).toEqual([]);
  });

  test("a migration failure wins the throw — the group write is not the operator's first problem", async () => {
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

    const failure: unknown = await runMigrations(
      groupWritesFail(),
      providerFor(registry, "app"),
      { binding: "DB", database: "app" },
      { group: "r1" },
    ).catch((error: unknown) => error);

    expect((failure as InternalError).payload.message).toContain('Couldn\'t apply "0000_core_0002_boom" on DB');
    expect(await readMigrationGroups(env.DB)).toEqual([]);
  });

  test("records what applied before a failure, so the retry extends the same group", async () => {
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

    await expect(runMigrations(env.DB, providerFor(registry, "app"), undefined, { group: "r1" })).rejects.toThrow();

    // The migration that stuck is in the group. Otherwise the retry's group would sit on top of an
    // ungrouped migration, and reversing the retry would leave half the release applied.
    expect(await readMigrationGroups(env.DB)).toEqual([
      { group: "r1", appliedAt: expect.any(Date), migrations: ["0000_core_0001_things"] },
    ]);
  });
});

describe("reverseMigrationGroup", () => {
  /** Two migrations in one group, a third in the group above it. */
  async function twoGroups(): Promise<MigrationProvider> {
    const registry = createMigrationRegistry([
      {
        database: "app",
        namespace: "core",
        order: 0,
        migrations: {
          "0001_things": createThings,
          "0002_widgets": createWidgets,
          "0003_gadgets": createGadgets,
        },
      },
    ]);
    const first = createMigrationRegistry([
      { database: "app", namespace: "core", order: 0, migrations: { "0001_things": createThings } },
    ]);
    await runMigrations(env.DB, providerFor(first, "app"), undefined, { group: "r1" });
    const provider = providerFor(registry, "app");
    await runMigrations(env.DB, provider, undefined, { group: "r2" });
    return provider;
  }

  test("reverses every migration in the group, newest first, and nothing outside it", async () => {
    const provider = await twoGroups();

    const results = await reverseMigrationGroup(env.DB, provider, {
      group: "r2",
      migrations: ["0000_core_0003_gadgets", "0000_core_0002_widgets"],
    });

    expect(results.map((r) => [r.migrationName, r.direction, r.status])).toEqual([
      ["0000_core_0003_gadgets", "Down", "Success"],
      ["0000_core_0002_widgets", "Down", "Success"],
    ]);
    // `r1`'s migration stays applied.
    expect(await tableNames()).toEqual(["things"]);
    const applied = await env.DB.prepare("select name from pithy_migrations").all<{ name: string }>();
    expect(applied.results.map((row) => row.name)).toEqual(["0000_core_0001_things"]);
  });

  test("forgets the reversed group's rows, and leaves the group table standing", async () => {
    const provider = await twoGroups();

    await reverseMigrationGroup(env.DB, provider, {
      group: "r2",
      migrations: ["0000_core_0003_gadgets", "0000_core_0002_widgets"],
    });

    expect(await readMigrationGroups(env.DB)).toEqual([
      { group: "r1", appliedAt: expect.any(Date), migrations: ["0000_core_0001_things"] },
    ]);
    // The table is bookkeeping, not a migration: a reversal takes the group's rows and never the table.
    expect(await migrationTableNames()).toContain("pithy_migrations_groups");
  });

  test("refuses a buried group before the first down, naming what is over it", async () => {
    const provider = await twoGroups();

    // `r1` is buried under `r2`. Kysely steps down from the tip, so the first `down` would reverse
    // `r2`'s newest migration — a migration nobody asked about. The CLI pre-flights this across every
    // database in the group; this is the floor under it, and it refuses with nothing moved.
    const failure: unknown = await reverseMigrationGroup(
      env.DB,
      provider,
      { group: "r1", migrations: ["0000_core_0001_things"] },
      { binding: "DB", database: "app" },
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(InternalError);
    expect((failure as InternalError).payload.message).toBe('Group "r1" is not the top of DB\'s chain.');
    expect((failure as InternalError).payload.detail).toContain("Applied over it: r2");
    expect(await tableNames()).toEqual(["gadgets", "things", "widgets"]);
  });

  test("refuses an applied migration no group claims over the group, before the first down", async () => {
    const provider = await twoGroups();
    // An ungrouped migration at the tip — what a reset's re-apply, an older kit, or a failed group write
    // leaves. The group table alone says `r1` is the top; the ledger says `0003_gadgets` is over it, and
    // the ledger is what `migrateDown()` steps. Read from the group table alone, this reversed a migration
    // nobody asked about and explained itself afterwards.
    await forgetMigrationGroups(env.DB, ["0000_core_0002_widgets", "0000_core_0003_gadgets"]);

    const failure: unknown = await reverseMigrationGroup(
      env.DB,
      provider,
      { group: "r1", migrations: ["0000_core_0001_things"] },
      { binding: "DB", database: "app" },
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(InternalError);
    expect((failure as InternalError).payload.message).toBe('Group "r1" is not the top of DB\'s chain.');
    expect((failure as InternalError).payload.detail).toContain(
      "Applied over it: 0000_core_0003_gadgets (ungrouped), 0000_core_0002_widgets (ungrouped)",
    );
    // Nothing came down: every table the two runs created is still there.
    expect(await tableNames()).toEqual(["gadgets", "things", "widgets"]);
  });

  test("reverses what the ledger says the group holds, never what the caller's list claims", async () => {
    const provider = await twoGroups();

    // A step naming a migration from the group below it. The position read is the authority, so `r1`'s
    // migration is not reversed on the caller's word.
    const results = await reverseMigrationGroup(env.DB, provider, {
      group: "r2",
      migrations: ["0000_core_0003_gadgets", "0000_core_0002_widgets", "0000_core_0001_things"],
    });

    expect(results.map((r) => r.migrationName)).toEqual(["0000_core_0003_gadgets", "0000_core_0002_widgets"]);
    expect(await tableNames()).toEqual(["things"]);
  });

  test("reversing a group with nothing left in it is a no-op", async () => {
    const registry = createMigrationRegistry([
      { database: "app", namespace: "core", order: 0, migrations: { "0001_things": createThings } },
    ]);

    const results = await reverseMigrationGroup(env.DB, providerFor(registry, "app"), {
      group: "r1",
      migrations: [],
    });

    expect(results).toEqual([]);
  });

  /** A group whose middle migration has no `down`, and the whole chain's provider. */
  async function groupWithNoDown(): Promise<MigrationProvider> {
    const registry = createMigrationRegistry([
      {
        database: "app",
        namespace: "core",
        order: 0,
        migrations: {
          "0001_things": createThings,
          // No `down`, which `./batch` preserves deliberately: Kysely's `#migrateDown` runs the body and
          // deletes the ledger row only `if (migration.down)`, so this one comes back `NotExecuted`.
          "0002_widgets": { up: createWidgets.up },
          "0003_gadgets": createGadgets,
        },
      },
    ]);
    const first = createMigrationRegistry([
      { database: "app", namespace: "core", order: 0, migrations: { "0001_things": createThings } },
    ]);
    await runMigrations(env.DB, providerFor(first, "app"), undefined, { group: "r1" });
    const provider = providerFor(registry, "app");
    await runMigrations(env.DB, provider, undefined, { group: "r2" });
    return provider;
  }

  test("refuses a group holding a migration with no down, rather than reporting it reversed", async () => {
    const provider = await groupWithNoDown();

    // Kysely hands a `down`-less migration back as `{direction:'Down', status:'NotExecuted'}` — no error,
    // ledger row intact. Counted as reversed, the command exited 0 and printed both names as rolled back
    // while `0002_widgets` was still applied and still carried its group row: the half-undone group this
    // whole mechanism exists to prevent, dressed as a complete success.
    const failure: unknown = await reverseMigrationGroup(
      env.DB,
      provider,
      { group: "r2", migrations: ["0000_core_0003_gadgets", "0000_core_0002_widgets"] },
      { binding: "DB", database: "app" },
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ValidationError);
    expect((failure as ValidationError).payload.message).toBe(
      'Migration "0000_core_0002_widgets" has no down, so group "r2" cannot be reversed on DB.',
    );
    expect((failure as ValidationError).payload.action).toBe(
      "Give 0000_core_0002_widgets a down, then reverse the group again.",
    );
    expect((failure as ValidationError).payload.detail).toContain("Reversed before the refusal:");
    expect((failure as ValidationError).payload.detail).toContain('"0000_core_0003_gadgets"');
    // It is still applied, and so is its group row — the two facts the false success contradicted.
    const applied = await env.DB.prepare("select name from pithy_migrations order by name").all<{ name: string }>();
    expect(applied.results.map((row) => row.name)).toEqual(["0000_core_0001_things", "0000_core_0002_widgets"]);
    expect(await readMigrationGroups(env.DB)).toEqual([
      { group: "r1", appliedAt: expect.any(Date), migrations: ["0000_core_0001_things"] },
      { group: "r2", appliedAt: expect.any(Date), migrations: ["0000_core_0002_widgets"] },
    ]);
  });

  test("names the missing down even when it is the newest in the group, not an ordering fault", async () => {
    const registry = createMigrationRegistry([
      {
        database: "app",
        namespace: "core",
        order: 0,
        migrations: { "0001_things": createThings, "0002_widgets": { up: createWidgets.up } },
      },
    ]);
    const first = createMigrationRegistry([
      { database: "app", namespace: "core", order: 0, migrations: { "0001_things": createThings } },
    ]);
    await runMigrations(env.DB, providerFor(first, "app"), undefined, { group: "r1" });
    const provider = providerFor(registry, "app");
    await runMigrations(env.DB, provider, undefined, { group: "r2" });

    // The tip has no `down`, so the first `migrateDown()` moves nothing and hands the same migration back.
    // Counting it as reversed emptied `remaining`, the second pass could not delete it again, and the
    // throw blamed the chain's order — sending the operator to `pithy doctor` for a problem that was a
    // missing `down` in their own migration.
    const failure: unknown = await reverseMigrationGroup(
      env.DB,
      provider,
      { group: "r2", migrations: ["0000_core_0002_widgets"] },
      { binding: "DB", database: "app" },
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ValidationError);
    expect((failure as ValidationError).payload.message).toBe(
      'Migration "0000_core_0002_widgets" has no down, so group "r2" cannot be reversed on DB.',
    );
    expect((failure as ValidationError).payload.detail).toContain("Nothing was reversed.");
  });

  test("carries the run's consent, so the whole group is reversed under one budget", async () => {
    const provider = await twoGroups();

    await reverseMigrationGroup(
      env.DB,
      provider,
      { group: "r2", migrations: ["0000_core_0003_gadgets", "0000_core_0002_widgets"] },
      { binding: "DB", database: "app" },
      { budget: new RetainedBudget(undefined) },
    );

    // Nothing here is retained, so an empty budget clears both `down`s — one check, one group.
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

  test("forgets the group row of the migration it reversed", async () => {
    const registry = createMigrationRegistry([
      {
        database: "app",
        namespace: "core",
        order: 0,
        migrations: { "0001_things": createThings, "0002_widgets": createWidgets },
      },
    ]);
    const provider = providerFor(registry, "app");
    await runMigrations(env.DB, provider, undefined, { group: "r1" });

    await rollbackMigration(env.DB, provider);

    // A single step is still a step: the group's bookkeeping follows the ledger, or the next rollback
    // would reverse a group it has already half-undone.
    expect(await readMigrationGroups(env.DB)).toEqual([
      { group: "r1", appliedAt: expect.any(Date), migrations: ["0000_core_0001_things"] },
    ]);
  });

  test("rolling back with nothing applied is a no-op", async () => {
    const registry = createMigrationRegistry([
      { database: "app", namespace: "core", order: 0, migrations: { "0001_things": createThings } },
    ]);

    const results = await rollbackMigration(env.DB, providerFor(registry, "app"));

    expect(results).toEqual([]);
  });
});
