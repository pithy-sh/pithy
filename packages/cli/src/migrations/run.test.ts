import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import type { Migration } from "kysely/migration";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { migrateProject } from "./run";

describe("migrateProject", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-migrate-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const createTable = (name: string): Migration => ({
    up: async (db) => {
      await db.schema
        .createTable(name)
        .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
        .execute();
    },
    down: async (db) => {
      await db.schema.dropTable(name).execute();
    },
  });
  const createThings = createTable("things");

  function appCapability() {
    return defineCapability({
      name: "app",
      requiredBindings: [],
      databases: {
        app: { binding: "DB", tables: {}, migrations: { "0001_things": createThings }, migrationOrder: 1000 },
      },
    });
  }

  test("an empty registry reports no database runs", async () => {
    const runs = await migrateProject({ capabilities: [], projectDir: dir, env: "dev" });
    expect(runs).toEqual([]);
  });

  test("runs, persists, and rolls back against local D1", async () => {
    const capabilities = [appCapability()];

    const first = await migrateProject({ capabilities, projectDir: dir, env: "dev" });
    expect(first).toHaveLength(1);
    expect(first[0]?.database).toBe("app");
    expect(first[0]?.binding).toBe("DB");
    expect(first[0]?.results.map((r) => [r.migrationName, r.direction, r.status])).toEqual([
      ["1000_app_0001_things", "Up", "Success"],
    ]);

    // State persisted under .wrangler/state: a second run is a no-op.
    const second = await migrateProject({ capabilities, projectDir: dir, env: "dev" });
    expect(second[0]?.results).toEqual([]);

    // --rollback steps the latest back.
    const rolledBack = await migrateProject({ capabilities, projectDir: dir, env: "dev", rollback: true });
    expect(rolledBack[0]?.results.map((r) => [r.migrationName, r.direction, r.status])).toEqual([
      ["1000_app_0001_things", "Down", "Success"],
    ]);
  });

  test("remote environments are a Phase 1 follow-up and say so", async () => {
    await expect(migrateProject({ capabilities: [], projectDir: dir, env: "staging" })).rejects.toThrow(PithyError);
  });

  test("refuses two databases that share one binding — their stores would collide", async () => {
    // `app` and `cache` both bound to DB with *different* tables: without a guard
    // both runs succeed against one physical store, silently sharing data and
    // kysely bookkeeping. The guard must reject this before running anything.
    const cap = defineCapability({
      name: "app",
      requiredBindings: [],
      databases: {
        app: { binding: "DB", tables: {}, migrations: { "0001_things": createThings }, migrationOrder: 100 },
        cache: {
          binding: "DB",
          tables: {},
          migrations: { "0001_widgets": createTable("widgets") },
          migrationOrder: 200,
        },
      },
    });
    await expect(migrateProject({ capabilities: [cap], projectDir: dir, env: "dev" })).rejects.toThrow(
      /share|bound to/i,
    );
  });
});
