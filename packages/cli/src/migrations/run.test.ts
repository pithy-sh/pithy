import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { D1Database } from "@cloudflare/workers-types";
import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import type { Migration } from "kysely/migration";
import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { countPendingMigrations, dropCapabilityTables, migrateProject } from "./run";

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

  describe("dropCapabilityTables", () => {
    test("reverses just the capability's migrations against local D1, and is idempotent", async () => {
      const capabilities = [appCapability()];
      await migrateProject({ capabilities, projectDir: dir, env: "dev" });

      const runs = await dropCapabilityTables({ capability: appCapability(), projectDir: dir, env: "dev" });
      expect(runs[0]?.results.map((r) => [r.migrationName, r.direction, r.status])).toEqual([
        ["1000_app_0001_things", "Down", "Success"],
      ]);

      // The table and its ledger row are gone — a second drop finds nothing to do.
      const again = await dropCapabilityTables({ capability: appCapability(), projectDir: dir, env: "dev" });
      expect(again[0]?.results).toEqual([]);
    });
  });

  describe("countPendingMigrations", () => {
    test("counts unapplied migrations, and drops to zero once migrated", async () => {
      const capabilities = [appCapability()];

      expect(await countPendingMigrations({ capabilities, projectDir: dir, env: "dev" })).toBe(1);

      await migrateProject({ capabilities, projectDir: dir, env: "dev" });
      expect(await countPendingMigrations({ capabilities, projectDir: dir, env: "dev" })).toBe(0);
    });

    test("an empty registry has nothing pending", async () => {
      expect(await countPendingMigrations({ capabilities: [], projectDir: dir, env: "dev" })).toBe(0);
    });
  });

  describe("remote environments", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    async function writeStagingConfig(databaseId: string | null): Promise<void> {
      const d1 = databaseId ? [{ binding: "DB", database_id: databaseId }] : [];
      await writeFile(
        join(dir, "wrangler.jsonc"),
        JSON.stringify({ d1_databases: [], env: { staging: { d1_databases: d1 } } }),
      );
    }

    async function writeCreds(): Promise<void> {
      await writeFile(join(dir, ".dev.vars"), "CLOUDFLARE_ACCOUNT_ID=acct-1\nCLOUDFLARE_API_TOKEN=tok-1\n");
    }

    test("resolves the env's database_id, applies, is idempotent, and rolls back over the REST driver", async () => {
      await writeStagingConfig("remote-staging-id");
      await writeCreds();

      // The REST-backed D1 is substituted with an in-memory Miniflare D1 — issue #24's client is
      // tested separately; here we assert the remote *orchestration* (id resolution, creds, ordering).
      const miniflare = new Miniflare({
        modules: true,
        script: "export default {};",
        d1Databases: { REMOTE: "remote-staging-id" },
      });
      const remote = (await miniflare.getD1Database("REMOTE")) as unknown as D1Database;
      const resolved: { binding: string; databaseId: string }[] = [];
      const opts = {
        capabilities: [appCapability()],
        projectDir: dir,
        env: "staging",
        remoteD1: (args: { binding: string; databaseId: string }): D1Database => {
          resolved.push(args);
          return remote;
        },
      };

      try {
        const first = await migrateProject(opts);
        expect(first[0]?.database).toBe("app");
        expect(first[0]?.results.map((r) => [r.migrationName, r.direction, r.status])).toEqual([
          ["1000_app_0001_things", "Up", "Success"],
        ]);
        // The remote id came from env.staging.d1_databases, not the (empty) top-level block.
        expect(resolved).toEqual([{ binding: "DB", databaseId: "remote-staging-id" }]);

        const second = await migrateProject(opts);
        expect(second[0]?.results).toEqual([]);

        const rolledBack = await migrateProject({ ...opts, rollback: true });
        expect(rolledBack[0]?.results.map((r) => [r.migrationName, r.direction, r.status])).toEqual([
          ["1000_app_0001_things", "Down", "Success"],
        ]);
      } finally {
        await miniflare.dispose();
      }
    });

    test("an empty registry is a no-op even remotely — no creds required", async () => {
      const runs = await migrateProject({ capabilities: [], projectDir: dir, env: "production" });
      expect(runs).toEqual([]);
    });

    test("missing CF credentials fail with an actionable error", async () => {
      vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "");
      vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
      await writeStagingConfig("remote-staging-id");

      const failure = await migrateProject({
        capabilities: [appCapability()],
        projectDir: dir,
        env: "staging",
      }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(PithyError);
      expect((failure as PithyError).payload.message).toMatch(/credentials/i);
    });

    test("a binding with no remote database_id fails with an actionable error", async () => {
      await writeStagingConfig(null);
      await writeCreds();

      const failure = await migrateProject({
        capabilities: [appCapability()],
        projectDir: dir,
        env: "staging",
        remoteD1: (): D1Database => {
          throw new Error("must not resolve a D1 when the id is missing");
        },
      }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(PithyError);
      expect((failure as PithyError).payload.message).toMatch(/database_id|DB/);
    });
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
