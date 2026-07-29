import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { D1Database } from "@cloudflare/workers-types";
import { type Capability, defineCapability } from "@pithy-sh/core/src/capability/capability";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import type { Migration } from "kysely/migration";
import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  countPendingMigrations,
  dropCapabilityTables,
  migrateProject,
  previewReset,
  resetProject,
  type WorkerScope,
} from "./run";

describe("migrateProject", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-migrate-"));
    await mkdir(join(dir, "apps", "api"), { recursive: true });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** The project's one worker, `apps/api`, composing `capabilities`. */
  function api(capabilities: Capability[]): WorkerScope {
    return { name: "api", dir: join(dir, "apps", "api"), capabilities };
  }

  /** A second worker, `apps/<name>`, so the fan-out has something to fan out over. */
  async function worker(name: string, capabilities: Capability[]): Promise<WorkerScope> {
    const workerDir = join(dir, "apps", name);
    await mkdir(workerDir, { recursive: true });
    return { name, dir: workerDir, capabilities };
  }

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

  /** A second capability, on its own binding by default — the other worker's registry. */
  function multiplayerCapability(binding = "COLLAB_DB") {
    return defineCapability({
      name: "multiplayer",
      requiredBindings: [],
      databases: {
        collab: {
          binding,
          tables: {},
          migrations: { "0001_rooms": createTable("rooms") },
          migrationOrder: 500,
        },
      },
    });
  }

  test("an empty registry reports the worker with no databases", async () => {
    const runs = await migrateProject({ projectDir: dir, workers: [api([])], env: "dev" });
    expect(runs).toEqual([{ worker: "api", databases: [] }]);
  });

  test("runs, persists, and rolls back against local D1", async () => {
    const workers = [api([appCapability()])];

    const first = await migrateProject({ projectDir: dir, workers, env: "dev" });
    expect(first).toHaveLength(1);
    expect(first[0]?.worker).toBe("api");
    expect(first[0]?.databases[0]?.database).toBe("app");
    expect(first[0]?.databases[0]?.binding).toBe("DB");
    expect(first[0]?.databases[0]?.results.map((r) => [r.migrationName, r.direction, r.status])).toEqual([
      ["1000_app_0001_things", "Up", "Success"],
    ]);

    // State persisted under the project root's .wrangler/state: a second run is a no-op.
    const second = await migrateProject({ projectDir: dir, workers, env: "dev" });
    expect(second[0]?.databases[0]?.results).toEqual([]);

    // --rollback steps the latest back.
    const rolledBack = await migrateProject({ projectDir: dir, workers, env: "dev", rollback: true });
    expect(rolledBack[0]?.databases[0]?.results.map((r) => [r.migrationName, r.direction, r.status])).toEqual([
      ["1000_app_0001_things", "Down", "Success"],
    ]);
  });

  describe("fan-out over workers", () => {
    test("runs each worker's own registry, reported per worker", async () => {
      const workers = [api([appCapability()]), await worker("collab", [multiplayerCapability()])];

      const runs = await migrateProject({ projectDir: dir, workers, env: "dev" });
      expect(runs.map((run) => run.worker)).toEqual(["api", "collab"]);
      expect(runs[0]?.databases[0]?.results.map((r) => r.migrationName)).toEqual(["1000_app_0001_things"]);
      expect(runs[1]?.databases[0]?.binding).toBe("COLLAB_DB");
      expect(runs[1]?.databases[0]?.results.map((r) => r.migrationName)).toEqual(["0500_multiplayer_0001_rooms"]);
      // Separate bindings, so nothing is shared.
      expect(runs.flatMap((run) => run.databases.map((database) => database.sharedWith))).toEqual([
        undefined,
        undefined,
      ]);
    });

    test("--worker narrows the fan-out to one worker", async () => {
      const workers = [api([appCapability()]), await worker("collab", [multiplayerCapability()])];

      const runs = await migrateProject({ projectDir: dir, workers, env: "dev", worker: "collab" });
      expect(runs.map((run) => run.worker)).toEqual(["collab"]);
      expect(runs[0]?.databases[0]?.results.map((r) => r.migrationName)).toEqual(["0500_multiplayer_0001_rooms"]);

      // The unnamed worker's own migration never ran — it is still pending.
      expect(await countPendingMigrations({ projectDir: dir, workers, env: "dev", worker: "api" })).toBe(1);
    });

    test("an unknown --worker fails with an actionable error naming the known workers", async () => {
      const workers = [api([appCapability()])];
      const failure = await migrateProject({ projectDir: dir, workers, env: "dev", worker: "nope" }).catch(
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(PithyError);
      expect((failure as PithyError).payload.action).toMatch(/api/);
    });

    describe("a database two workers share", () => {
      test("migrates once when both compose the same capability", async () => {
        // Workers share a resource by declaring the same binding, so both `DB` entries are one D1.
        const workers = [api([appCapability()]), await worker("collab", [appCapability()])];

        const runs = await migrateProject({ projectDir: dir, workers, env: "dev" });
        // One run, credited to the worker that declared it — not once per worker.
        expect(runs[0]?.databases[0]?.results.map((r) => r.migrationName)).toEqual(["1000_app_0001_things"]);
        expect(runs[1]?.databases[0]?.results).toEqual([]);
        // Both rows name the other worker, so the report says the database is shared.
        expect(runs[0]?.databases[0]?.sharedWith).toEqual(["collab"]);
        expect(runs[1]?.databases[0]?.sharedWith).toEqual(["api"]);

        // Counted once, too — not once per worker.
        expect(await countPendingMigrations({ projectDir: dir, workers, env: "dev" })).toBe(0);
      });

      test("merges both workers' capabilities into one run, each credited with its own", async () => {
        const workers = [api([appCapability()]), await worker("collab", [multiplayerCapability("DB")])];

        const runs = await migrateProject({ projectDir: dir, workers, env: "dev" });
        expect(runs[0]?.databases[0]?.results.map((r) => r.migrationName)).toEqual(["1000_app_0001_things"]);
        expect(runs[1]?.databases[0]?.results.map((r) => r.migrationName)).toEqual(["0500_multiplayer_0001_rooms"]);

        // Both tables landed in the one shared local D1, and nothing is pending afterwards.
        expect(await countPendingMigrations({ projectDir: dir, workers, env: "dev" })).toBe(0);
        const mf = new Miniflare({
          modules: true,
          script: "export default {};",
          d1Databases: { DB: "DB" },
          d1Persist: join(dir, ".wrangler", "state", "v3", "d1"),
        });
        try {
          const tables = await (await mf.getD1Database("DB"))
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
            .all<{ name: string }>();
          expect(tables.results.map((row) => row.name)).toEqual(expect.arrayContaining(["rooms", "things"]));
        } finally {
          await mf.dispose();
        }
      });

      test("refuses two different capabilities wearing one namespace on a shared binding", async () => {
        const other = defineCapability({
          name: "app",
          requiredBindings: [],
          databases: {
            app: {
              binding: "DB",
              tables: {},
              migrations: { "0001_widgets": createTable("widgets") },
              migrationOrder: 1000,
            },
          },
        });
        const workers = [api([appCapability()]), await worker("collab", [other])];

        const failure = await migrateProject({ projectDir: dir, workers, env: "dev" }).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(PithyError);
        expect((failure as PithyError).payload.message).toMatch(/different migrations/i);
      });

      test("refuses two different capabilities whose migration keys also collide", async () => {
        // The likeliest instance of the misconfiguration: both workers' app capability is named "app"
        // and both name their first migration "0001_init" — the canonical first key. Identity is the
        // migration's body, so a matching key name must not be mistaken for a matching migration:
        // deduping here would drop collab's set silently and never create `widgets`.
        const cap = (table: string): Capability =>
          defineCapability({
            name: "app",
            requiredBindings: [],
            databases: {
              app: {
                binding: "DB",
                tables: {},
                migrations: { "0001_init": createTable(table) },
                migrationOrder: 1000,
              },
            },
          });
        const workers = [api([cap("things")]), await worker("collab", [cap("widgets")])];

        const failure = await migrateProject({ projectDir: dir, workers, env: "dev" }).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(PithyError);
        expect((failure as PithyError).payload.message).toMatch(/different migrations/i);
      });

      test("still dedupes one capability composed twice, in two distinct capability objects", async () => {
        // A capability ships module-level migration objects, so composing it into two workers yields two
        // distinct capabilities pointing at the same migrations. Identity is the migration, not the
        // capability object — this must still migrate once, however strict the collision test gets.
        expect(appCapability()).not.toBe(appCapability());
        const workers = [api([appCapability()]), await worker("collab", [appCapability()])];

        const runs = await migrateProject({ projectDir: dir, workers, env: "dev" });
        expect(runs[0]?.databases[0]?.results.map((r) => r.migrationName)).toEqual(["1000_app_0001_things"]);
        expect(runs[1]?.databases[0]?.results).toEqual([]);
      });

      test("a run narrowed to one worker still presents the whole shared registry", async () => {
        // The ledger of a shared D1 records both workers' migrations. A provider covering only the
        // named worker's namespaces reads as corrupted state to kysely and aborts the run — which is
        // every `pithy add`/`remove`/`upgrade --migrate`, since they always scope to one worker.
        const workers = [api([appCapability()]), await worker("collab", [multiplayerCapability("DB")])];
        await migrateProject({ projectDir: dir, workers, env: "dev" });

        const runs = await migrateProject({ projectDir: dir, workers, env: "dev", worker: "api" });
        expect(runs.map((run) => run.worker)).toEqual(["api"]);
        expect(runs[0]?.databases[0]?.results).toEqual([]);
        // The report still names the worker it shares the database with.
        expect(runs[0]?.databases[0]?.sharedWith).toEqual(["collab"]);
      });

      test("a narrowed run applies the shared database as a whole, crediting only its own", async () => {
        const workers = [api([appCapability()]), await worker("collab", [multiplayerCapability("DB")])];

        const runs = await migrateProject({ projectDir: dir, workers, env: "dev", worker: "api" });
        // api is credited with its own migration alone — collab's is applied, never misattributed.
        expect(runs[0]?.databases[0]?.results.map((r) => r.migrationName)).toEqual(["1000_app_0001_things"]);

        // Both tables landed: a shared database migrates as a whole, or the ledger diverges from it.
        const mf = new Miniflare({
          modules: true,
          script: "export default {};",
          d1Databases: { DB: "DB" },
          d1Persist: join(dir, ".wrangler", "state", "v3", "d1"),
        });
        try {
          const tables = await (await mf.getD1Database("DB"))
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
            .all<{ name: string }>();
          expect(tables.results.map((row) => row.name)).toEqual(expect.arrayContaining(["rooms", "things"]));
        } finally {
          await mf.dispose();
        }

        // And the ledger is consistent: the full fan-out that follows has nothing left to do.
        const full = await migrateProject({ projectDir: dir, workers, env: "dev" });
        expect(full.flatMap((run) => run.databases.flatMap((database) => database.results))).toEqual([]);
      });
    });

    test("workers keep their bindings but share the project's local state directory", async () => {
      // Each worker's wrangler.jsonc names the same database, in its own directory. Persistence is
      // project-scoped, so both resolve to one local store — not one file per worker.
      const workers = [api([appCapability()]), await worker("collab", [appCapability()])];
      for (const target of workers) {
        await writeFile(
          join(target.dir, "wrangler.jsonc"),
          JSON.stringify({ d1_databases: [{ binding: "DB", database_name: "shared-db" }] }),
        );
      }

      await migrateProject({ projectDir: dir, workers, env: "dev" });

      const mf = new Miniflare({
        modules: true,
        script: "export default {};",
        d1Databases: { DB: "shared-db" },
        d1Persist: join(dir, ".wrangler", "state", "v3", "d1"),
      });
      try {
        const row = await (await mf.getD1Database("DB"))
          .prepare("SELECT count(*) AS n FROM things")
          .first<{ n: number }>();
        expect(row?.n).toBe(0); // the table exists in the shared store
      } finally {
        await mf.dispose();
      }
    });
  });

  describe("dropCapabilityTables", () => {
    test("reverses just the capability's migrations against local D1, and is idempotent", async () => {
      const workerDir = join(dir, "apps", "api");
      await migrateProject({ projectDir: dir, workers: [api([appCapability()])], env: "dev" });

      const runs = await dropCapabilityTables({
        capability: appCapability(),
        workerDir,
        persistRoot: dir,
        env: "dev",
      });
      expect(runs[0]?.results.map((r) => [r.migrationName, r.direction, r.status])).toEqual([
        ["1000_app_0001_things", "Down", "Success"],
      ]);

      // The table and its ledger row are gone — a second drop finds nothing to do.
      const again = await dropCapabilityTables({
        capability: appCapability(),
        workerDir,
        persistRoot: dir,
        env: "dev",
      });
      expect(again[0]?.results).toEqual([]);
    });
  });

  describe("resetProject", () => {
    test("rolls every migration back then forward, leaving the ledger consistent", async () => {
      const workers = [api([appCapability()])];
      await migrateProject({ projectDir: dir, workers, env: "dev" });
      expect(await countPendingMigrations({ projectDir: dir, workers, env: "dev" })).toBe(0);

      const runs = await resetProject({ projectDir: dir, workers, env: "dev" });
      expect(runs).toHaveLength(1);
      expect(runs[0]?.databases[0]?.database).toBe("app");
      expect(runs[0]?.databases[0]?.binding).toBe("DB");
      expect(runs[0]?.databases[0]?.results.map((r) => [r.migrationName, r.direction, r.status])).toEqual([
        ["1000_app_0001_things", "Down", "Success"],
        ["1000_app_0001_things", "Up", "Success"],
      ]);

      // The ledger is consistent afterwards: nothing pending, and a following plain migrate is a no-op.
      expect(await countPendingMigrations({ projectDir: dir, workers, env: "dev" })).toBe(0);
      const again = await migrateProject({ projectDir: dir, workers, env: "dev" });
      expect(again[0]?.databases[0]?.results).toEqual([]);
    });

    test("destroys existing rows — a full reset, not a per-row merge", async () => {
      const workers = [api([appCapability()])];
      await migrateProject({ projectDir: dir, workers, env: "dev" });

      const d1Persist = join(dir, ".wrangler", "state", "v3", "d1");
      let mf = new Miniflare({ modules: true, script: "export default {};", d1Databases: { DB: "DB" }, d1Persist });
      try {
        await (await mf.getD1Database("DB")).prepare("INSERT INTO things (id) VALUES (1)").run();
      } finally {
        await mf.dispose();
      }

      await resetProject({ projectDir: dir, workers, env: "dev" });

      mf = new Miniflare({ modules: true, script: "export default {};", d1Databases: { DB: "DB" }, d1Persist });
      try {
        const count = await (await mf.getD1Database("DB"))
          .prepare("SELECT count(*) AS n FROM things")
          .first<{ n: number }>();
        expect(count?.n).toBe(0);
      } finally {
        await mf.dispose();
      }
    });

    test("an empty registry is a no-op", async () => {
      expect(await resetProject({ projectDir: dir, workers: [api([])], env: "dev" })).toEqual([
        { worker: "api", databases: [] },
      ]);
    });
  });

  describe("previewReset", () => {
    test("counts the registry's migrations per database, with no backend access", async () => {
      const preview = await previewReset({ projectDir: dir, workers: [api([appCapability()])], env: "dev" });
      expect(preview).toEqual([{ database: "app", binding: "DB", migrations: 1 }]);
    });

    test("previews a database two workers share once, with their merged count", async () => {
      const workers = [api([appCapability()]), await worker("collab", [multiplayerCapability("DB")])];
      expect(await previewReset({ projectDir: dir, workers, env: "dev" })).toEqual([
        { database: "app", binding: "DB", migrations: 2 },
      ]);
    });

    test("an empty registry previews nothing", async () => {
      expect(await previewReset({ projectDir: dir, workers: [api([])], env: "dev" })).toEqual([]);
    });
  });

  describe("countPendingMigrations", () => {
    test("counts unapplied migrations, and drops to zero once migrated", async () => {
      const workers = [api([appCapability()])];

      expect(await countPendingMigrations({ projectDir: dir, workers, env: "dev" })).toBe(1);

      await migrateProject({ projectDir: dir, workers, env: "dev" });
      expect(await countPendingMigrations({ projectDir: dir, workers, env: "dev" })).toBe(0);
    });

    test("an empty registry has nothing pending", async () => {
      expect(await countPendingMigrations({ projectDir: dir, workers: [api([])], env: "dev" })).toBe(0);
    });
  });

  describe("remote environments", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    async function writeStagingConfig(databaseId: string | null): Promise<void> {
      const d1 = databaseId ? [{ binding: "DB", database_id: databaseId }] : [];
      await writeFile(
        join(dir, "apps", "api", "wrangler.jsonc"),
        JSON.stringify({ d1_databases: [], env: { staging: { d1_databases: d1 } } }),
      );
    }

    /** The one repo-wide `.dev.vars` lives at the project root, not in a worker's directory. */
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
        projectDir: dir,
        workers: [api([appCapability()])],
        env: "staging",
        remoteD1: (args: { binding: string; databaseId: string }): D1Database => {
          resolved.push(args);
          return remote;
        },
      };

      try {
        const first = await migrateProject(opts);
        expect(first[0]?.databases[0]?.database).toBe("app");
        expect(first[0]?.databases[0]?.results.map((r) => [r.migrationName, r.direction, r.status])).toEqual([
          ["1000_app_0001_things", "Up", "Success"],
        ]);
        // The remote id came from env.staging.d1_databases, not the (empty) top-level block.
        expect(resolved).toEqual([{ binding: "DB", databaseId: "remote-staging-id" }]);

        const second = await migrateProject(opts);
        expect(second[0]?.databases[0]?.results).toEqual([]);

        const rolledBack = await migrateProject({ ...opts, rollback: true });
        expect(rolledBack[0]?.databases[0]?.results.map((r) => [r.migrationName, r.direction, r.status])).toEqual([
          ["1000_app_0001_things", "Down", "Success"],
        ]);
      } finally {
        await miniflare.dispose();
      }
    });

    test("two workers pointing at one remote database_id resolve a single client", async () => {
      await writeStagingConfig("remote-staging-id");
      const collab = await worker("collab", [multiplayerCapability("DB")]);
      await writeFile(
        join(collab.dir, "wrangler.jsonc"),
        JSON.stringify({ env: { staging: { d1_databases: [{ binding: "DB", database_id: "remote-staging-id" }] } } }),
      );

      const miniflare = new Miniflare({
        modules: true,
        script: "export default {};",
        d1Databases: { REMOTE: "remote-staging-id" },
      });
      try {
        const remote = (await miniflare.getD1Database("REMOTE")) as unknown as D1Database;
        const resolved: { binding: string; databaseId: string }[] = [];
        const runs = await migrateProject({
          projectDir: dir,
          workers: [api([appCapability()]), collab],
          env: "staging",
          remoteD1: (args): D1Database => {
            resolved.push(args);
            return remote;
          },
        });
        expect(resolved).toEqual([{ binding: "DB", databaseId: "remote-staging-id" }]);
        expect(runs[0]?.databases[0]?.results.map((r) => r.migrationName)).toEqual(["1000_app_0001_things"]);
        expect(runs[1]?.databases[0]?.results.map((r) => r.migrationName)).toEqual(["0500_multiplayer_0001_rooms"]);
      } finally {
        await miniflare.dispose();
      }
    });

    test("an empty registry is a no-op even remotely — no creds required", async () => {
      const runs = await migrateProject({ projectDir: dir, workers: [api([])], env: "production" });
      expect(runs).toEqual([{ worker: "api", databases: [] }]);
    });

    test("a worker with no env stanza fails with an actionable error naming it", async () => {
      await writeFile(join(dir, "apps", "api", "wrangler.jsonc"), JSON.stringify({ d1_databases: [] }));
      const failure = await migrateProject({
        projectDir: dir,
        workers: [api([appCapability()])],
        env: "staging",
      }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(PithyError);
      expect((failure as PithyError).payload.message).toMatch(/api: .*env\.staging/);
    });

    test("missing CF credentials fail with an actionable error", async () => {
      vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "");
      vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
      await writeStagingConfig("remote-staging-id");

      const failure = await migrateProject({
        projectDir: dir,
        workers: [api([appCapability()])],
        env: "staging",
      }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(PithyError);
      expect((failure as PithyError).payload.message).toMatch(/credentials/i);
    });

    test("an injected remote D1 needs no ambient CF credentials", async () => {
      // Substituting the network client is the whole point of the `remoteD1` seam, so it must not
      // demand `CLOUDFLARE_*` — a regression guard for the CI-only failure where these were unset.
      vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "");
      vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
      await writeStagingConfig("remote-staging-id");

      const miniflare = new Miniflare({
        modules: true,
        script: "export default {};",
        d1Databases: { REMOTE: "remote-staging-id" },
      });
      try {
        const remote = (await miniflare.getD1Database("REMOTE")) as unknown as D1Database;
        const runs = await migrateProject({
          projectDir: dir,
          workers: [api([appCapability()])],
          env: "staging",
          remoteD1: () => remote,
        });
        expect(runs[0]?.databases[0]?.results.map((r) => [r.migrationName, r.direction, r.status])).toEqual([
          ["1000_app_0001_things", "Up", "Success"],
        ]);
      } finally {
        await miniflare.dispose();
      }
    });

    test("a binding with no remote database_id fails with an actionable error", async () => {
      await writeStagingConfig(null);
      await writeCreds();

      const failure = await migrateProject({
        projectDir: dir,
        workers: [api([appCapability()])],
        env: "staging",
        remoteD1: (): D1Database => {
          throw new Error("must not resolve a D1 when the id is missing");
        },
      }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(PithyError);
      expect((failure as PithyError).payload.message).toMatch(/database_id|DB/);
    });
  });

  test("refuses two databases in one worker that share a binding — their stores would collide", async () => {
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
    await expect(migrateProject({ projectDir: dir, workers: [api([cap])], env: "dev" })).rejects.toThrow(
      /share|bound to/i,
    );
  });
});
