import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { D1Database } from "@cloudflare/workers-types";
import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { Miniflare } from "miniflare";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  appCapability,
  createTable,
  createThings,
  migrateHarness,
  multiplayerCapability,
} from "../test-utils/migrateHarness";
import { countPendingMigrations, dropCapabilityTables, migrateProject, previewReset, resetProject } from "./run";

describe("migrateProject", () => {
  const h = migrateHarness();

  test("an empty registry reports the worker with no databases", async () => {
    const runs = await migrateProject({ projectDir: h.projectDir, workers: [h.api([])], env: "dev" });
    expect(runs).toEqual([{ worker: "api", databases: [] }]);
  });

  test("runs, persists, and rolls back against local D1", async () => {
    const workers = [h.api([appCapability()])];

    const first = await migrateProject({ projectDir: h.projectDir, workers, env: "dev" });
    expect(first).toHaveLength(1);
    expect(first[0]?.worker).toBe("api");
    expect(first[0]?.databases[0]?.database).toBe("app");
    expect(first[0]?.databases[0]?.binding).toBe("DB");
    expect(first[0]?.databases[0]?.results.map((r) => [r.migrationName, r.direction, r.status])).toEqual([
      ["1000_app_0001_things", "Up", "Success"],
    ]);

    // State persisted under the project root's .wrangler/state: a second run is a no-op.
    const second = await migrateProject({ projectDir: h.projectDir, workers, env: "dev" });
    expect(second[0]?.databases[0]?.results).toEqual([]);

    // --rollback steps the latest back.
    const rolledBack = await migrateProject({ projectDir: h.projectDir, workers, env: "dev", rollback: true });
    expect(rolledBack[0]?.databases[0]?.results.map((r) => [r.migrationName, r.direction, r.status])).toEqual([
      ["1000_app_0001_things", "Down", "Success"],
    ]);
  });

  describe("dropCapabilityTables", () => {
    test("reverses just the capability's migrations against local D1, and is idempotent", async () => {
      const workerDir = join(h.projectDir, "apps", "api");
      await migrateProject({ projectDir: h.projectDir, workers: [h.api([appCapability()])], env: "dev" });

      const runs = await dropCapabilityTables({
        capability: appCapability(),
        workerDir,
        persistRoot: h.projectDir,
        env: "dev",
      });
      expect(runs[0]?.results.map((r) => [r.migrationName, r.direction, r.status])).toEqual([
        ["1000_app_0001_things", "Down", "Success"],
      ]);

      // The table and its ledger row are gone — a second drop finds nothing to do.
      const again = await dropCapabilityTables({
        capability: appCapability(),
        workerDir,
        persistRoot: h.projectDir,
        env: "dev",
      });
      expect(again[0]?.results).toEqual([]);
    });
  });

  describe("resetProject", () => {
    test("rolls every migration back then forward, leaving the ledger consistent", async () => {
      const workers = [h.api([appCapability()])];
      await migrateProject({ projectDir: h.projectDir, workers, env: "dev" });
      expect(await countPendingMigrations({ projectDir: h.projectDir, workers, env: "dev" })).toBe(0);

      const runs = await resetProject({ projectDir: h.projectDir, workers, env: "dev" });
      expect(runs).toHaveLength(1);
      expect(runs[0]?.databases[0]?.database).toBe("app");
      expect(runs[0]?.databases[0]?.binding).toBe("DB");
      expect(runs[0]?.databases[0]?.results.map((r) => [r.migrationName, r.direction, r.status])).toEqual([
        ["1000_app_0001_things", "Down", "Success"],
        ["1000_app_0001_things", "Up", "Success"],
      ]);

      // The ledger is consistent afterwards: nothing pending, and a following plain migrate is a no-op.
      expect(await countPendingMigrations({ projectDir: h.projectDir, workers, env: "dev" })).toBe(0);
      const again = await migrateProject({ projectDir: h.projectDir, workers, env: "dev" });
      expect(again[0]?.databases[0]?.results).toEqual([]);
    });

    test("destroys existing rows — a full reset, not a per-row merge", async () => {
      const workers = [h.api([appCapability()])];
      await migrateProject({ projectDir: h.projectDir, workers, env: "dev" });

      const d1Persist = join(h.projectDir, ".wrangler", "state", "v3", "d1");
      let mf = new Miniflare({ modules: true, script: "export default {};", d1Databases: { DB: "DB" }, d1Persist });
      try {
        await (await mf.getD1Database("DB")).prepare("INSERT INTO things (id) VALUES (1)").run();
      } finally {
        await mf.dispose();
      }

      await resetProject({ projectDir: h.projectDir, workers, env: "dev" });

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
      expect(await resetProject({ projectDir: h.projectDir, workers: [h.api([])], env: "dev" })).toEqual([
        { worker: "api", databases: [] },
      ]);
    });
  });

  describe("previewReset", () => {
    test("counts the registry's migrations per database, with no backend access", async () => {
      const preview = await previewReset({ projectDir: h.projectDir, workers: [h.api([appCapability()])], env: "dev" });
      expect(preview).toEqual([{ database: "app", binding: "DB", migrations: 1 }]);
    });

    test("previews a database two workers share once, with their merged count", async () => {
      const workers = [h.api([appCapability()]), await h.worker("collab", [multiplayerCapability("DB")])];
      expect(await previewReset({ projectDir: h.projectDir, workers, env: "dev" })).toEqual([
        { database: "app", binding: "DB", migrations: 2 },
      ]);
    });

    test("an empty registry previews nothing", async () => {
      expect(await previewReset({ projectDir: h.projectDir, workers: [h.api([])], env: "dev" })).toEqual([]);
    });
  });

  describe("countPendingMigrations", () => {
    test("counts unapplied migrations, and drops to zero once migrated", async () => {
      const workers = [h.api([appCapability()])];

      expect(await countPendingMigrations({ projectDir: h.projectDir, workers, env: "dev" })).toBe(1);

      await migrateProject({ projectDir: h.projectDir, workers, env: "dev" });
      expect(await countPendingMigrations({ projectDir: h.projectDir, workers, env: "dev" })).toBe(0);
    });

    test("an empty registry has nothing pending", async () => {
      expect(await countPendingMigrations({ projectDir: h.projectDir, workers: [h.api([])], env: "dev" })).toBe(0);
    });
  });

  describe("remote environments", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    async function writeStagingConfig(databaseId: string | null): Promise<void> {
      const d1 = databaseId ? [{ binding: "DB", database_id: databaseId }] : [];
      await writeFile(
        join(h.projectDir, "apps", "api", "wrangler.jsonc"),
        JSON.stringify({ d1_databases: [], env: { staging: { d1_databases: d1 } } }),
      );
    }

    /** The one repo-wide `.dev.vars` lives at the project root, not in a worker's directory. */
    async function writeCreds(): Promise<void> {
      await writeFile(join(h.projectDir, ".dev.vars"), "CLOUDFLARE_ACCOUNT_ID=acct-1\nCLOUDFLARE_API_TOKEN=tok-1\n");
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
        projectDir: h.projectDir,
        workers: [h.api([appCapability()])],
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
      const collab = await h.worker("collab", [multiplayerCapability("DB")]);
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
          projectDir: h.projectDir,
          workers: [h.api([appCapability()]), collab],
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
      const runs = await migrateProject({ projectDir: h.projectDir, workers: [h.api([])], env: "production" });
      expect(runs).toEqual([{ worker: "api", databases: [] }]);
    });

    test("a worker with no env stanza fails with an actionable error naming it", async () => {
      await writeFile(join(h.projectDir, "apps", "api", "wrangler.jsonc"), JSON.stringify({ d1_databases: [] }));
      const failure = await migrateProject({
        projectDir: h.projectDir,
        workers: [h.api([appCapability()])],
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
        projectDir: h.projectDir,
        workers: [h.api([appCapability()])],
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
          projectDir: h.projectDir,
          workers: [h.api([appCapability()])],
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
        projectDir: h.projectDir,
        workers: [h.api([appCapability()])],
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
    await expect(migrateProject({ projectDir: h.projectDir, workers: [h.api([cap])], env: "dev" })).rejects.toThrow(
      /share|bound to/i,
    );
  });
});
