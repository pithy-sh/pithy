// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { D1Database } from "@cloudflare/workers-types";
import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { sql } from "kysely";
import type { Migration } from "kysely/migration";
import { describe, expect, test, vi } from "vitest";
import { migrateProject } from "../migrations/run";
import { createTable, migrateHarness, multiplayerCapability, withLocalD1 } from "../test-utils/migrateHarness";
import { runBackup } from "./backup";
import { BackupManifest, BackupMigrations, parseSchemaSql } from "./files";
import { runRestore } from "./restore";

/**
 * `pithy backup` and `pithy restore` end to end against real local D1 (#848): a database with foreign keys,
 * every SQLite value type, an adopter table made outside the migrations with its own index and trigger, and
 * an adopter FTS5 table under no kit pattern with a trigger writing into it. Backed up, restored into a
 * fresh database, and compared table for table, row for row.
 */

const PROJECT = "acme";
const KIT = "9.9.9";

/** Parent and child tables, the child referencing the parent. */
const relations: Migration = {
  up: async (db) => {
    await sql`CREATE TABLE things (id integer primary key, name text, weight real, data blob, note text)`.execute(db);
    await sql`CREATE TABLE parts (id integer primary key, thing_id integer not null references things(id), label text)`.execute(
      db,
    );
  },
  down: async (db) => {
    await sql`DROP TABLE parts`.execute(db);
    await sql`DROP TABLE things`.execute(db);
  },
};

/** The app capability: `a_parts`' keys sort first, so only reference order loads `things` ahead of it. */
function app(extra: Record<string, Migration> = {}) {
  return defineCapability({
    name: "app",
    requiredBindings: [],
    databases: {
      app: { binding: "DB", tables: {}, migrations: { "0001_relations": relations, ...extra }, migrationOrder: 1000 },
    },
  });
}

/** Every table's rows, ordered, for the round-trip comparison. Bookkeeping, `_cf_` and shadow tables aside. */
async function snapshot(db: D1Database): Promise<Record<string, unknown[]>> {
  const tables = ["things", "parts", "notes", "notes_log"];
  const out: Record<string, unknown[]> = {};
  for (const table of tables) {
    out[table] = (
      await db
        .prepare(`SELECT *, typeof(${table === "things" ? "weight" : "rowid"}) AS t FROM ${table} ORDER BY rowid`)
        .all()
    ).results;
  }
  return out;
}

/** Fill the source database: kit rows, hand-made adopter objects, and an adopter FTS5 table. */
async function populate(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare(
      "INSERT INTO things (id, name, weight, data, note) VALUES (1, 'it''s', 0.1, x'00ff', 'two\nlines\r\nhere')",
    ),
    db.prepare("INSERT INTO things (id, name, weight, data, note) VALUES (2, NULL, 3.0, NULL, NULL)"),
    db.prepare("INSERT INTO parts (id, thing_id, label) VALUES (1, 2, 'wheel'), (2, 1, 'bolt')"),
    db.prepare("CREATE TABLE notes (id integer primary key, body text)"),
    db.prepare("CREATE TABLE notes_log (note_id integer)"),
    db.prepare("CREATE INDEX notes_body ON notes(body)"),
    db.prepare("CREATE TRIGGER notes_logged AFTER INSERT ON notes BEGIN INSERT INTO notes_log VALUES (NEW.id); END"),
    db.prepare("CREATE VIRTUAL TABLE notes_index USING fts5(body)"),
    db.prepare(
      "CREATE TRIGGER notes_indexed AFTER INSERT ON notes BEGIN INSERT INTO notes_index(body) VALUES (NEW.body); END",
    ),
    db.prepare("INSERT INTO notes (id, body) VALUES (1, 'hello'), (2, 'world')"),
  ]);
}

/**
 * A D1 that, the first time a page of `table` is read, deletes `doomed` once that page is in hand — a row
 * deleted from the live database between two of the backup's page reads.
 */
function deletingBetweenPages(db: D1Database, table: string, doomed: string): D1Database {
  let fired = false;
  const passThrough = <T extends object>(target: T, override: (prop: string | symbol) => unknown): T =>
    new Proxy(target, {
      get(inner, prop) {
        const replaced = override(prop);
        if (replaced !== undefined) return replaced;
        const value = Reflect.get(inner, prop);
        return typeof value === "function" ? value.bind(inner) : value;
      },
    });
  return passThrough(db, (prop) => {
    if (prop !== "prepare") return undefined;
    return (query: string) => {
      const statement = db.prepare(query);
      if (fired || !query.includes(`FROM "${table}"`) || !query.includes("LIMIT")) return statement;
      return passThrough(statement, (inner) =>
        inner === "all"
          ? async () => {
              const page = await statement.all();
              fired = true;
              await db.prepare(doomed).run();
              return page;
            }
          : undefined,
      );
    };
  });
}

/** The refusal a run ends in. Fails the test when it ends any other way. */
async function refusal(run: Promise<unknown>): Promise<PithyError> {
  const caught = await run.then(
    () => undefined,
    (error: unknown) => error,
  );
  if (!(caught instanceof PithyError)) throw new Error(`expected a PithyError, got ${String(caught)}`);
  return caught;
}

describe("pithy backup and restore", () => {
  const h = migrateHarness();

  async function source(extra?: Record<string, Migration>): Promise<{ output: string }> {
    const workers = [h.api([app(extra)])];
    await migrateProject({ projectDir: h.projectDir, project: PROJECT, account: null, env: "dev", workers });
    await withLocalD1(h.projectDir, "DB", populate);
    const output = join(h.projectDir, "backups", "one");
    await runBackup({
      projectDir: h.projectDir,
      project: PROJECT,
      account: null,
      env: "dev",
      workers,
      output,
      kitVersion: KIT,
    });
    return { output };
  }

  test("writes the four files, with migrations, rows only, and only what no migration made", async () => {
    const { output } = await source();
    const dir = join(output, "DB");
    const migrations = BackupMigrations.parse(JSON.parse(await readFile(join(dir, "migrations.json"), "utf8")));
    expect(migrations).toMatchObject({
      kitVersion: KIT,
      project: PROJECT,
      binding: "DB",
      database: "app",
      applied: ["1000_app_0001_relations"],
    });

    const data = await readFile(join(dir, "data.sql"), "utf8");
    expect(data).not.toMatch(/CREATE/);
    expect(data).not.toMatch(/pithy_migrations|_cf_|notes_index/);
    expect(data.indexOf('INSERT INTO "things"')).toBeLessThan(data.indexOf('INSERT INTO "parts"'));

    const schema = parseSchemaSql(await readFile(join(dir, "schema.sql"), "utf8"));
    expect(schema.map((one) => [one.phase, one.name])).toEqual([
      ["before", "notes"],
      ["before", "notes_log"],
      ["after", "notes_body"],
      ["after", "notes_logged"],
    ]);

    const manifest = BackupManifest.parse(JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")));
    expect(manifest.tables).toEqual(
      expect.arrayContaining([
        { name: "things", rows: 2 },
        { name: "parts", rows: 2 },
        { name: "notes", rows: 2 },
        { name: "notes_log", rows: 2 },
      ]),
    );
    expect(manifest.virtualTables).toEqual([
      { name: "notes_index", sql: "CREATE VIRTUAL TABLE notes_index USING fts5(body)" },
    ]);
    expect(
      manifest.leftOut
        .filter((entry) => entry.reason === "shadow")
        .every((entry) => entry.name.startsWith("notes_index_")),
    ).toBe(true);
    expect(manifest.skippedTriggers.map((one) => one.name)).toEqual(["notes_indexed"]);
    expect(manifest.restorable).toBe(true);
  });

  test("restores into a fresh database that matches the original, table for table and row for row", async () => {
    const { output } = await source();
    const workers = [h.api([app()])];
    const restored = await runRestore({
      projectDir: h.projectDir,
      project: PROJECT,
      account: null,
      env: "dev",
      workers,
      input: output,
      kitVersion: KIT,
      recovery: async () => "recovery",
    });
    expect(restored).toEqual([
      {
        binding: "DB",
        database: "app",
        target: "recovery",
        migrations: 1,
        tables: 4,
        rows: 8,
        rebuilt: [{ name: "notes_index", how: "recreated-empty" }],
      },
    ]);
    const before = await withLocalD1(h.projectDir, "DB", snapshot);
    const after = await withLocalD1(h.projectDir, "recovery", snapshot);
    // Loading fired no trigger: `notes_log` holds the two rows the source's trigger wrote, not four.
    expect(after).toEqual(before);
    await withLocalD1(h.projectDir, "recovery", async (db) => {
      // The adopter's index is back, empty, and its trigger with it.
      expect((await db.prepare("SELECT count(*) AS n FROM notes_index").first<{ n: number }>())?.n).toBe(0);
      await db.prepare("INSERT INTO notes (id, body) VALUES (3, 'again')").run();
      expect((await db.prepare("SELECT count(*) AS n FROM notes_index").first<{ n: number }>())?.n).toBe(1);
      expect((await db.prepare("SELECT count(*) AS n FROM notes_log").first<{ n: number }>())?.n).toBe(3);
    });
  });

  test("a trigger a migration made stays out of the way while the rows load, and is back after", async () => {
    const audited: Migration = {
      up: async (db) => {
        await sql`CREATE TABLE audit (thing_id integer)`.execute(db);
        await sql`CREATE TRIGGER things_audit AFTER INSERT ON things BEGIN INSERT INTO audit VALUES (NEW.id); END`.execute(
          db,
        );
      },
      down: async (db) => {
        await sql`DROP TABLE audit`.execute(db);
      },
    };
    const { output } = await source({ "0002_audit": audited });
    await runRestore({
      projectDir: h.projectDir,
      project: PROJECT,
      account: null,
      env: "dev",
      workers: [h.api([app({ "0002_audit": audited })])],
      input: output,
      kitVersion: KIT,
      recovery: async () => "recovery",
    });
    await withLocalD1(h.projectDir, "recovery", async (db) => {
      // Two rows, as the source holds: the restored rows fired nothing.
      expect((await db.prepare("SELECT count(*) AS n FROM audit").first<{ n: number }>())?.n).toBe(2);
      await db.prepare("INSERT INTO things (id) VALUES (9)").run();
      expect((await db.prepare("SELECT count(*) AS n FROM audit").first<{ n: number }>())?.n).toBe(3);
    });
  });

  test("refuses a database that holds a table, names it, and writes nothing", async () => {
    const { output } = await source();
    const error = await refusal(
      runRestore({
        projectDir: h.projectDir,
        project: PROJECT,
        account: null,
        env: "dev",
        workers: [h.api([app()])],
        input: output,
        kitVersion: KIT,
      }),
    );
    expect(error.payload.code).toBe("core/conflict");
    expect(error.message).toContain("things");
  });

  test("refuses a backup whose migrations differ, in either direction, naming both versions and the keys", async () => {
    const { output } = await source();
    const ahead = await refusal(
      runRestore({
        projectDir: h.projectDir,
        project: PROJECT,
        account: null,
        env: "dev",
        workers: [h.api([app({ "0002_more": createTable("more") })])],
        input: output,
        kitVersion: "10.0.0",
        recovery: async () => "recovery",
      }),
    );
    expect(ahead.message).toContain("kit 9.9.9 and this is 10.0.0");
    expect(ahead.message).toContain("Only here: 1000_app_0002_more.");

    const behind = await refusal(
      runRestore({
        projectDir: h.projectDir,
        project: PROJECT,
        account: null,
        env: "dev",
        workers: [
          h.api([
            defineCapability({
              name: "app",
              requiredBindings: [],
              databases: { app: { binding: "DB", tables: {}, migrations: {}, migrationOrder: 1000 } },
            }),
          ]),
        ],
        input: output,
        kitVersion: "1.0.0",
        recovery: async () => "recovery",
      }),
    );
    expect(behind.message).toContain("Only in the backup: 1000_app_0001_relations.");
    await withLocalD1(h.projectDir, "recovery", async (db) => {
      const tables = await db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%'")
        .all();
      expect(tables.results).toEqual([]);
    });
  });

  test("a row over D1's statement limit keeps the files, marks them unrestorable, and restore refuses them", async () => {
    const workers = [h.api([app()])];
    await migrateProject({ projectDir: h.projectDir, project: PROJECT, account: null, env: "dev", workers });
    await withLocalD1(h.projectDir, "DB", async (db) => {
      await db.prepare("INSERT INTO things (id, name) VALUES (1, 'small'), (2, ?)").bind("x".repeat(120_000)).run();
    });
    const output = join(h.projectDir, "big");
    const [report] = await runBackup({
      projectDir: h.projectDir,
      project: PROJECT,
      account: null,
      env: "dev",
      workers,
      output,
      kitVersion: KIT,
    });
    expect(report?.restorable).toBe(false);
    expect(report?.oversized).toEqual([{ file: "data.sql", line: 4, table: "things", bytes: expect.any(Number) }]);
    const lines = (await readFile(join(output, "DB", "data.sql"), "utf8")).split("\n");
    expect(lines[3]).toContain("x".repeat(1000));

    const error = await refusal(
      runRestore({
        projectDir: h.projectDir,
        project: PROJECT,
        account: null,
        env: "dev",
        workers,
        input: output,
        kitVersion: KIT,
        recovery: async () => "recovery",
      }),
    );
    expect(error.message).toContain("data.sql line 4");
    expect(error.payload.action).toContain("Time Travel");
  });

  test("a 60 KB text of many lines, a long support reply, stays restorable and comes back exact", async () => {
    const workers = [h.api([app()])];
    await migrateProject({ projectDir: h.projectDir, project: PROJECT, account: null, env: "dev", workers });
    // About 60 KB over 3,000 line breaks, CRLF and LF both: written as hex it would be twice that, over D1's
    // limit, and written as a chain of `||` per break it would pass SQLite's expression depth.
    const reply = Array.from({ length: 3000 }, (_, i) => `line ${i} of the reply ~${i % 2 === 0 ? "\r\n" : "\n"}`).join(
      "",
    );
    expect(reply.length).toBeGreaterThan(55_000);
    await withLocalD1(h.projectDir, "DB", async (db) => {
      await db.prepare("INSERT INTO things (id, note) VALUES (1, ?)").bind(reply).run();
    });
    const output = join(h.projectDir, "long");
    const [report] = await runBackup({
      projectDir: h.projectDir,
      project: PROJECT,
      account: null,
      env: "dev",
      workers,
      output,
      kitVersion: KIT,
    });
    expect(report).toMatchObject({ restorable: true, oversized: [] });

    const [restored] = await runRestore({
      projectDir: h.projectDir,
      project: PROJECT,
      account: null,
      env: "dev",
      workers,
      input: output,
      kitVersion: KIT,
      recovery: async () => "recovery",
    });
    expect(restored).toMatchObject({ target: "recovery", rows: 1 });
    const back = await withLocalD1(h.projectDir, "recovery", async (db) =>
      db.prepare("SELECT note FROM things WHERE id = 1").first<{ note: string }>(),
    );
    expect(back?.note).toBe(reply);
  });

  test("one folder per database the Workers bind, and --binding narrows it to one", async () => {
    const workers = [h.api([app(), multiplayerCapability()])];
    await migrateProject({ projectDir: h.projectDir, project: PROJECT, account: null, env: "dev", workers });
    const all = await runBackup({
      projectDir: h.projectDir,
      project: PROJECT,
      account: null,
      env: "dev",
      workers,
      output: join(h.projectDir, "all"),
      kitVersion: KIT,
    });
    expect(all.map((one) => one.folder).sort()).toEqual(["COLLAB_DB", "DB"]);
    for (const folder of ["COLLAB_DB", "DB"]) {
      for (const file of ["migrations.json", "data.sql", "schema.sql", "manifest.json"]) {
        await expect(readFile(join(h.projectDir, "all", folder, file), "utf8")).resolves.toBeTypeOf("string");
      }
    }
    const one = await runBackup({
      projectDir: h.projectDir,
      project: PROJECT,
      account: null,
      env: "dev",
      workers,
      binding: "COLLAB_DB",
      output: join(h.projectDir, "one"),
      kitVersion: KIT,
    });
    expect(one.map((entry) => entry.folder)).toEqual(["COLLAB_DB"]);
  });

  test("a remote environment backs up and restores through the REST seam, into the recovery database's id", async () => {
    // Staging reaches D1 through the remote driver. The seam stands in for `@pithy-sh/cloudflare`'s REST
    // client with two in-memory databases, keyed by the ids the stanza and the recovery lookup answer.
    await writeFile(
      join(h.projectDir, "apps", "api", "wrangler.jsonc"),
      JSON.stringify({
        d1_databases: [{ binding: "DB" }],
        env: { staging: { d1_databases: [{ binding: "DB", database_id: "staging-id" }] } },
      }),
    );
    const { convertV4MiniflareOptions, Miniflare } = await import("miniflare");
    const mf = new Miniflare(
      convertV4MiniflareOptions({ modules: true, script: "export default {};", d1Databases: { A: "a", B: "b" } }),
    );
    try {
      const databases: Record<string, D1Database> = {
        "staging-id": (await mf.getD1Database("A")) as unknown as D1Database,
        "recovery-id": (await mf.getD1Database("B")) as unknown as D1Database,
      };
      const remoteD1 = ({ databaseId }: { databaseId: string }): D1Database => {
        const found = databases[databaseId];
        if (found === undefined) throw new Error(`no database ${databaseId}`);
        return found;
      };
      const workers = [h.api([app()])];
      const scope = { projectDir: h.projectDir, project: PROJECT, account: null, env: "staging", workers, remoteD1 };
      await migrateProject(scope);
      await populate(databases["staging-id"] as D1Database);
      const output = join(h.projectDir, "remote");
      const audit = vi.fn(async () => {});
      const [backed] = await runBackup({ ...scope, output, kitVersion: KIT, audit });
      expect(backed).toMatchObject({ binding: "DB", tables: 4, rows: 8, restorable: true });
      // Every row left the account, so the trail says who took them, from where. Never what they hold.
      expect(audit.mock.calls).toEqual([
        [
          {
            action: "backup/exported",
            outcome: "success",
            severity: "warning",
            resourceType: "environment",
            resourceId: "staging",
            metadata: {
              databases: [{ binding: "DB", database: "app", id: "staging-id", tables: 4, rows: 8, restorable: true }],
            },
          },
        ],
      ]);
      audit.mockClear();
      const migrations = BackupMigrations.parse(
        JSON.parse(await readFile(join(output, "DB", "migrations.json"), "utf8")),
      );
      expect(migrations).toMatchObject({ env: "staging", source: "staging-id" });

      const [restored] = await runRestore({
        ...scope,
        input: output,
        kitVersion: KIT,
        recovery: async () => "recovery-id",
        audit,
      });
      expect(restored).toMatchObject({ target: "recovery-id", rows: 8 });
      expect(audit.mock.calls).toEqual([
        [
          {
            action: "restore/loaded",
            outcome: "success",
            severity: "critical",
            resourceType: "environment",
            resourceId: "staging",
            metadata: {
              databases: [{ binding: "DB", database: "app", target: "recovery-id", tables: 4, rows: 8 }],
              recovery: "recovery-id",
            },
          },
        ],
      ]);
      expect(await snapshot(databases["recovery-id"] as D1Database)).toEqual(
        await snapshot(databases["staging-id"] as D1Database),
      );
    } finally {
      await mf.dispose();
    }
  });

  test("a restore refused before it writes records nothing: an audit row would land in the database it checks", async () => {
    const { output } = await source();
    const audit = vi.fn(async () => {});
    await refusal(
      runRestore({
        projectDir: h.projectDir,
        project: PROJECT,
        account: null,
        env: "dev",
        workers: [h.api([app()])],
        input: output,
        kitVersion: KIT,
        audit,
      }),
    );
    expect(audit).not.toHaveBeenCalled();
  });

  test("a backup that fails part way records the failure", async () => {
    await writeFile(
      join(h.projectDir, "apps", "api", "wrangler.jsonc"),
      JSON.stringify({
        d1_databases: [{ binding: "DB" }],
        env: { staging: { d1_databases: [{ binding: "DB", database_id: "staging-id" }] } },
      }),
    );
    const { convertV4MiniflareOptions, Miniflare } = await import("miniflare");
    const mf = new Miniflare(
      convertV4MiniflareOptions({ modules: true, script: "export default {};", d1Databases: { A: "a" } }),
    );
    try {
      const db = (await mf.getD1Database("A")) as unknown as D1Database;
      const workers = [h.api([app()])];
      const scope = { projectDir: h.projectDir, project: PROJECT, account: null, env: "staging", workers };
      await migrateProject({ ...scope, remoteD1: () => db });
      // The rows' first page read fails, the way a dropped connection would.
      const failing = new Proxy(db, {
        get(inner, prop) {
          if (prop !== "prepare") return Reflect.get(inner, prop).bind?.(inner) ?? Reflect.get(inner, prop);
          return (query: string) => {
            if (query.includes("LIMIT")) throw new Error("D1 went away");
            return inner.prepare(query);
          };
        },
      });
      const audit = vi.fn(async () => {});
      await expect(
        runBackup({
          ...scope,
          remoteD1: () => failing,
          output: join(h.projectDir, "broken"),
          kitVersion: KIT,
          audit,
        }),
      ).rejects.toThrow("D1 went away");
      expect(audit.mock.calls).toEqual([
        [
          {
            action: "backup/exported",
            outcome: "failure",
            severity: "warning",
            resourceType: "environment",
            resourceId: "staging",
            metadata: { databases: [{ binding: "DB", database: "app", id: "staging-id" }] },
          },
        ],
      ]);
    } finally {
      await mf.dispose();
    }
  });

  test("a backup never writes into a directory that already holds one", async () => {
    const { output } = await source();
    await expect(
      runBackup({
        projectDir: h.projectDir,
        project: PROJECT,
        account: null,
        env: "dev",
        workers: [h.api([app()])],
        output,
        kitVersion: KIT,
      }),
    ).rejects.toThrow(/already holds files/);
  });

  test("a mismatched backup is refused before --database resolves, so no recovery database is made", async () => {
    const { output } = await source();
    const recovery = vi.fn(async () => "recovery");
    const error = await refusal(
      runRestore({
        projectDir: h.projectDir,
        project: PROJECT,
        account: null,
        env: "dev",
        workers: [h.api([app({ "0002_more": createTable("more") })])],
        input: output,
        kitVersion: "10.0.0",
        recovery,
      }),
    );
    expect(error.payload.code).toBe("core/precondition_failed");
    expect(recovery).not.toHaveBeenCalled();
  });

  test("an unrestorable backup is refused before --database resolves", async () => {
    const workers = [h.api([app()])];
    await migrateProject({ projectDir: h.projectDir, project: PROJECT, account: null, env: "dev", workers });
    await withLocalD1(h.projectDir, "DB", async (db) => {
      await db.prepare("INSERT INTO things (id, name) VALUES (1, ?)").bind("x".repeat(120_000)).run();
    });
    const output = join(h.projectDir, "big");
    await runBackup({
      projectDir: h.projectDir,
      project: PROJECT,
      account: null,
      env: "dev",
      workers,
      output,
      kitVersion: KIT,
    });
    const recovery = vi.fn(async () => "recovery");
    await refusal(
      runRestore({
        projectDir: h.projectDir,
        project: PROJECT,
        account: null,
        env: "dev",
        workers,
        input: output,
        kitVersion: KIT,
        recovery,
      }),
    );
    expect(recovery).not.toHaveBeenCalled();
  });

  test("restores from one database's folder as well as from the backup's root", async () => {
    const { output } = await source();
    const [restored] = await runRestore({
      projectDir: h.projectDir,
      project: PROJECT,
      account: null,
      env: "dev",
      workers: [h.api([app()])],
      input: join(output, "DB"),
      kitVersion: KIT,
      recovery: async () => "recovery",
    });
    expect(restored).toMatchObject({ binding: "DB", target: "recovery", rows: 8 });
  });

  test("refuses a directory that does not exist, and one that holds no backup", async () => {
    const options = {
      projectDir: h.projectDir,
      project: PROJECT,
      account: null,
      env: "dev",
      workers: [h.api([app()])],
      kitVersion: KIT,
    };
    const missing = await refusal(runRestore({ ...options, input: join(h.projectDir, "nowhere") }));
    expect(missing.payload.code).toBe("core/not_found");
    expect(missing.message).toContain("does not exist");
    const empty = join(h.projectDir, "empty");
    await mkdir(join(empty, "stray"), { recursive: true });
    const none = await refusal(runRestore({ ...options, input: empty }));
    expect(none.payload.code).toBe("core/not_found");
    expect(none.message).toContain("holds no backup");
  });

  test("refuses a migrations.json or manifest.json that is not what a backup writes", async () => {
    const { output } = await source();
    const options = {
      projectDir: h.projectDir,
      project: PROJECT,
      account: null,
      env: "dev",
      workers: [h.api([app()])],
      kitVersion: KIT,
      input: output,
    };
    await writeFile(join(output, "DB", "manifest.json"), "{ not json");
    const garbled = await refusal(runRestore(options));
    expect(garbled.payload.code).toBe("validation/invalid_input");
    expect(garbled.message).toContain("manifest.json is not a backup file");
    await writeFile(join(output, "DB", "migrations.json"), JSON.stringify({ format: 999 }));
    const wrong = await refusal(runRestore(options));
    expect(wrong.message).toContain("migrations.json is not a backup file");
  });

  describe("a backup of two databases", () => {
    async function twoDatabases(): Promise<{ output: string; workers: ReturnType<typeof h.api>[] }> {
      const workers = [h.api([app(), multiplayerCapability()])];
      await migrateProject({ projectDir: h.projectDir, project: PROJECT, account: null, env: "dev", workers });
      await withLocalD1(h.projectDir, "DB", populate);
      const output = join(h.projectDir, "two");
      await runBackup({
        projectDir: h.projectDir,
        project: PROJECT,
        account: null,
        env: "dev",
        workers,
        output,
        kitVersion: KIT,
      });
      return { output, workers };
    }

    test("--binding restores only that database", async () => {
      const { output, workers } = await twoDatabases();
      const restored = await runRestore({
        projectDir: h.projectDir,
        project: PROJECT,
        account: null,
        env: "dev",
        workers,
        input: output,
        kitVersion: KIT,
        binding: "DB",
        recovery: async () => "recovery",
      });
      expect(restored.map((one) => [one.binding, one.target])).toEqual([["DB", "recovery"]]);
    });

    test("--binding the backup does not hold is refused, naming the bindings it does", async () => {
      const { output, workers } = await twoDatabases();
      const error = await refusal(
        runRestore({
          projectDir: h.projectDir,
          project: PROJECT,
          account: null,
          env: "dev",
          workers,
          input: output,
          kitVersion: KIT,
          binding: "NOPE",
        }),
      );
      expect(error.payload.code).toBe("core/not_found");
      expect(error.message).toContain("holds no backup of NOPE");
      expect(error.payload.action).toContain("Known: COLLAB_DB, DB.");
    });

    test("--database without --binding is refused, since it restores one database", async () => {
      const { output, workers } = await twoDatabases();
      const recovery = vi.fn(async () => "recovery");
      const error = await refusal(
        runRestore({
          projectDir: h.projectDir,
          project: PROJECT,
          account: null,
          env: "dev",
          workers,
          input: output,
          kitVersion: KIT,
          recovery,
        }),
      );
      expect(error.payload.code).toBe("validation/invalid_input");
      expect(error.message).toContain("--database restores one database");
      expect(recovery).not.toHaveBeenCalled();
    });

    test("a folder whose binding no Worker binds here is refused before --database resolves", async () => {
      const { output } = await twoDatabases();
      const recovery = vi.fn(async () => "recovery");
      const error = await refusal(
        runRestore({
          projectDir: h.projectDir,
          project: PROJECT,
          account: null,
          env: "dev",
          workers: [h.api([app()])],
          input: join(output, "COLLAB_DB"),
          kitVersion: KIT,
          recovery,
        }),
      );
      expect(error.payload.code).toBe("core/not_found");
      expect(error.message).toContain("No database in dev is bound to COLLAB_DB (collab)");
      expect(recovery).not.toHaveBeenCalled();
    });
  });

  describe("two Workers", () => {
    /** A second Worker's own database, on whatever binding it is given. */
    const mail = (binding: string) =>
      defineCapability({
        name: "mail",
        requiredBindings: [],
        databases: {
          mail: { binding, tables: {}, migrations: { "0001_letters": createTable("letters") }, migrationOrder: 1100 },
        },
      });

    /** Point a Worker's `binding` at its own local store, so two Workers' `DB` are two databases. */
    async function bindStore(worker: string, binding: string, id: string): Promise<void> {
      await mkdir(join(h.projectDir, "apps", worker), { recursive: true });
      await writeFile(
        join(h.projectDir, "apps", worker, "wrangler.jsonc"),
        JSON.stringify({ d1_databases: [{ binding, database_id: id }] }),
      );
    }

    async function backUp(workers: Awaited<ReturnType<typeof h.worker>>[], name: string) {
      await migrateProject({ projectDir: h.projectDir, project: PROJECT, account: null, env: "dev", workers });
      const output = join(h.projectDir, name);
      const report = await runBackup({
        projectDir: h.projectDir,
        project: PROJECT,
        account: null,
        env: "dev",
        workers,
        output,
        kitVersion: KIT,
      });
      return { output, report };
    }

    test("--worker restores only the databases that Worker binds, out of a backup of them all", async () => {
      const workers = [h.api([app()]), await h.worker("mailer", [mail("EMAIL_DB")])];
      const { output } = await backUp(workers, "all");
      const restored = await runRestore({
        projectDir: h.projectDir,
        project: PROJECT,
        account: null,
        env: "dev",
        workers,
        worker: "mailer",
        input: output,
        kitVersion: KIT,
        recovery: async () => "recovery",
      });
      expect(restored.map((one) => [one.binding, one.target])).toEqual([["EMAIL_DB", "recovery"]]);
    });

    test("--worker that binds none of the backup's databases is refused, naming the Worker", async () => {
      const workers = [h.api([app()]), await h.worker("mailer", [mail("EMAIL_DB")])];
      const { output } = await backUp(workers, "all");
      const error = await refusal(
        runRestore({
          projectDir: h.projectDir,
          project: PROJECT,
          account: null,
          env: "dev",
          workers,
          worker: "mailer",
          input: join(output, "DB"),
          kitVersion: KIT,
        }),
      );
      expect(error.payload.code).toBe("core/not_found");
      expect(error.message).toContain("mailer");
    });

    test("two databases on one binding get a folder each, and each restores its own rows", async () => {
      await bindStore("api", "DB", "app-store");
      await bindStore("mailer", "DB", "mail-store");
      const workers = [h.api([app()]), await h.worker("mailer", [mail("DB")])];
      await migrateProject({ projectDir: h.projectDir, project: PROJECT, account: null, env: "dev", workers });
      await withLocalD1(h.projectDir, "app-store", (db) => db.prepare("INSERT INTO things (id) VALUES (1), (2)").run());
      await withLocalD1(h.projectDir, "mail-store", (db) => db.prepare("INSERT INTO letters (id) VALUES (7)").run());
      const output = join(h.projectDir, "shared");
      const report = await runBackup({
        projectDir: h.projectDir,
        project: PROJECT,
        account: null,
        env: "dev",
        workers,
        output,
        kitVersion: KIT,
      });
      expect(report.map((one) => [one.folder, one.rows]).sort()).toEqual([
        ["DB-app", 2],
        ["DB-mail", 1],
      ]);
      expect(await readFile(join(output, "DB-app", "data.sql"), "utf8")).toContain('INSERT INTO "things"');
      expect(await readFile(join(output, "DB-mail", "data.sql"), "utf8")).toContain('INSERT INTO "letters"');

      const restored = await runRestore({
        projectDir: h.projectDir,
        project: PROJECT,
        account: null,
        env: "dev",
        workers,
        worker: "mailer",
        input: output,
        kitVersion: KIT,
        recovery: async () => "recovery",
      });
      expect(restored.map((one) => [one.binding, one.database, one.rows])).toEqual([["DB", "mail", 1]]);
      const letters = await withLocalD1(h.projectDir, "recovery", (db) =>
        db.prepare("SELECT id FROM letters").all<{ id: number }>(),
      );
      expect(letters.results).toEqual([{ id: 7 }]);
    });

    test("two databases of one name on one binding still get a folder each, and a restore that cannot tell them apart is refused", async () => {
      await bindStore("api", "DB", "one-store");
      await bindStore("mailer", "DB", "two-store");
      const workers = [h.api([app()]), await h.worker("mailer", [app()])];
      const { output, report } = await backUp(workers, "twins");
      const folders = report.map((one) => one.folder);
      expect(new Set(folders).size).toBe(2);
      expect(folders.sort()).toEqual(["DB-app-one-store", "DB-app-two-store"]);

      const recovery = vi.fn(async () => "recovery");
      const error = await refusal(
        runRestore({
          projectDir: h.projectDir,
          project: PROJECT,
          account: null,
          env: "dev",
          workers,
          input: output,
          kitVersion: KIT,
          recovery,
        }),
      );
      expect(error.payload.code).toBe("validation/invalid_input");
      expect(recovery).not.toHaveBeenCalled();

      const [restored] = await runRestore({
        projectDir: h.projectDir,
        project: PROJECT,
        account: null,
        env: "dev",
        workers,
        worker: "mailer",
        input: join(output, "DB-app-two-store"),
        kitVersion: KIT,
        recovery: async () => "recovery",
      });
      expect(restored).toMatchObject({ binding: "DB", database: "app", target: "recovery" });
    });
  });

  test("rows a migration seeds are replaced by the backup's, not added to them", async () => {
    const seeded: Migration = {
      up: async (db) => {
        await sql`INSERT INTO things (id, name) VALUES (5, 'seeded'), (7, 'seeded only')`.execute(db);
      },
      down: async () => {},
    };
    const { output } = await source({ "0002_seed": seeded });
    await runRestore({
      projectDir: h.projectDir,
      project: PROJECT,
      account: null,
      env: "dev",
      workers: [h.api([app({ "0002_seed": seeded })])],
      input: output,
      kitVersion: KIT,
      recovery: async () => "recovery",
    });
    const rows = async (db: D1Database) => (await db.prepare("SELECT id, name FROM things ORDER BY id").all()).results;
    const before = await withLocalD1(h.projectDir, "DB", rows);
    expect(await withLocalD1(h.projectDir, "recovery", rows)).toEqual(before);
  });

  test("a row deleted from the live database between two page reads drops no other row", async () => {
    await writeFile(
      join(h.projectDir, "apps", "api", "wrangler.jsonc"),
      JSON.stringify({
        d1_databases: [{ binding: "DB" }],
        env: { staging: { d1_databases: [{ binding: "DB", database_id: "staging-id" }] } },
      }),
    );
    const { convertV4MiniflareOptions, Miniflare } = await import("miniflare");
    const mf = new Miniflare(
      convertV4MiniflareOptions({ modules: true, script: "export default {};", d1Databases: { A: "a" } }),
    );
    try {
      const raw = (await mf.getD1Database("A")) as unknown as D1Database;
      const workers = [h.api([app()])];
      const scope = { projectDir: h.projectDir, project: PROJECT, account: null, env: "staging", workers };
      await migrateProject({ ...scope, remoteD1: () => raw });
      await raw.batch([
        raw.prepare(
          "INSERT INTO things (id, name) WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 250) SELECT i, 'n' || i FROM n",
        ),
        raw.prepare("CREATE TABLE tags (k text primary key, v integer) WITHOUT ROWID"),
        raw.prepare(
          "INSERT INTO tags (k, v) WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 250) SELECT printf('k%03d', i), i FROM n",
        ),
      ]);
      const live = deletingBetweenPages(
        deletingBetweenPages(raw, "things", "DELETE FROM things WHERE id = 1"),
        "tags",
        "DELETE FROM tags WHERE k = 'k001'",
      );
      const output = join(h.projectDir, "live");
      await runBackup({ ...scope, remoteD1: () => live, output, kitVersion: KIT });
      const manifest = BackupManifest.parse(JSON.parse(await readFile(join(output, "DB", "manifest.json"), "utf8")));
      // Both deleted rows were read before they went; every row after them is still there, once.
      expect(manifest.tables).toEqual(
        expect.arrayContaining([
          { name: "things", rows: 250 },
          { name: "tags", rows: 250 },
        ]),
      );
      const data = await readFile(join(output, "DB", "data.sql"), "utf8");
      expect(data).toContain("(201,'n201',");
      expect(data).toContain("('k201',201)");
    } finally {
      await mf.dispose();
    }
  });

  test("the files hold live rows, so only their owner can read them: folders 0700, files 0600", async () => {
    const { output } = await source();
    const mode = async (path: string): Promise<number> => (await stat(path)).mode & 0o777;
    expect(await mode(output)).toBe(0o700);
    expect(await mode(join(output, "DB"))).toBe(0o700);
    for (const file of ["migrations.json", "data.sql", "schema.sql", "manifest.json"]) {
      expect(await mode(join(output, "DB", file))).toBe(0o600);
    }
  });

  test("an empty directory passed as --output is closed to its owner too", async () => {
    const output = join(h.projectDir, "given");
    await mkdir(output, { mode: 0o755 });
    const workers = [h.api([app()])];
    await migrateProject({ projectDir: h.projectDir, project: PROJECT, account: null, env: "dev", workers });
    await runBackup({
      projectDir: h.projectDir,
      project: PROJECT,
      account: null,
      env: "dev",
      workers,
      output,
      kitVersion: KIT,
    });
    expect((await stat(output)).mode & 0o777).toBe(0o700);
  });
});
