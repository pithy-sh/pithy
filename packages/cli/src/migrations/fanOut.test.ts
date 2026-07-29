import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Capability, defineCapability } from "@pithy-sh/core/src/capability/capability";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { Miniflare } from "miniflare";
import { describe, expect, test } from "vitest";
import { appCapability, createTable, migrateHarness, multiplayerCapability } from "../test-utils/migrateHarness";
import { countPendingMigrations, migrateProject } from "./run";

/**
 * `migrateProject`'s fan-out across a project's workers — the group that dominated the suite's
 * wall clock, in its own file so it runs alongside the rest instead of behind it. Everything it
 * shares with the other `migrateProject` files lives in `test-utils/migrateHarness.ts`.
 */
describe("migrateProject", () => {
  const h = migrateHarness();

  describe("fan-out over workers", () => {
    test("runs each worker's own registry, reported per worker", async () => {
      const workers = [h.api([appCapability()]), await h.worker("collab", [multiplayerCapability()])];

      const runs = await migrateProject({ projectDir: h.projectDir, workers, env: "dev" });
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
      const workers = [h.api([appCapability()]), await h.worker("collab", [multiplayerCapability()])];

      const runs = await migrateProject({ projectDir: h.projectDir, workers, env: "dev", worker: "collab" });
      expect(runs.map((run) => run.worker)).toEqual(["collab"]);
      expect(runs[0]?.databases[0]?.results.map((r) => r.migrationName)).toEqual(["0500_multiplayer_0001_rooms"]);

      // The unnamed worker's own migration never ran — it is still pending.
      expect(await countPendingMigrations({ projectDir: h.projectDir, workers, env: "dev", worker: "api" })).toBe(1);
    });

    test("an unknown --worker fails with an actionable error naming the known workers", async () => {
      const workers = [h.api([appCapability()])];
      const failure = await migrateProject({ projectDir: h.projectDir, workers, env: "dev", worker: "nope" }).catch(
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(PithyError);
      expect((failure as PithyError).payload.action).toMatch(/api/);
    });

    describe("a database two workers share", () => {
      test("migrates once when both compose the same capability", async () => {
        // Workers share a resource by declaring the same binding, so both `DB` entries are one D1.
        const workers = [h.api([appCapability()]), await h.worker("collab", [appCapability()])];

        const runs = await migrateProject({ projectDir: h.projectDir, workers, env: "dev" });
        // One run, credited to the worker that declared it — not once per worker.
        expect(runs[0]?.databases[0]?.results.map((r) => r.migrationName)).toEqual(["1000_app_0001_things"]);
        expect(runs[1]?.databases[0]?.results).toEqual([]);
        // Both rows name the other worker, so the report says the database is shared.
        expect(runs[0]?.databases[0]?.sharedWith).toEqual(["collab"]);
        expect(runs[1]?.databases[0]?.sharedWith).toEqual(["api"]);

        // Counted once, too — not once per worker.
        expect(await countPendingMigrations({ projectDir: h.projectDir, workers, env: "dev" })).toBe(0);
      });

      test("merges both workers' capabilities into one run, each credited with its own", async () => {
        const workers = [h.api([appCapability()]), await h.worker("collab", [multiplayerCapability("DB")])];

        const runs = await migrateProject({ projectDir: h.projectDir, workers, env: "dev" });
        expect(runs[0]?.databases[0]?.results.map((r) => r.migrationName)).toEqual(["1000_app_0001_things"]);
        expect(runs[1]?.databases[0]?.results.map((r) => r.migrationName)).toEqual(["0500_multiplayer_0001_rooms"]);

        // Both tables landed in the one shared local D1, and nothing is pending afterwards.
        expect(await countPendingMigrations({ projectDir: h.projectDir, workers, env: "dev" })).toBe(0);
        const mf = new Miniflare({
          modules: true,
          script: "export default {};",
          d1Databases: { DB: "DB" },
          d1Persist: join(h.projectDir, ".wrangler", "state", "v3", "d1"),
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
        const workers = [h.api([appCapability()]), await h.worker("collab", [other])];

        const failure = await migrateProject({ projectDir: h.projectDir, workers, env: "dev" }).catch(
          (error: unknown) => error,
        );
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
        const workers = [h.api([cap("things")]), await h.worker("collab", [cap("widgets")])];

        const failure = await migrateProject({ projectDir: h.projectDir, workers, env: "dev" }).catch(
          (error: unknown) => error,
        );
        expect(failure).toBeInstanceOf(PithyError);
        expect((failure as PithyError).payload.message).toMatch(/different migrations/i);
      });

      test("still dedupes one capability composed twice, in two distinct capability objects", async () => {
        // A capability ships module-level migration objects, so composing it into two workers yields two
        // distinct capabilities pointing at the same migrations. Identity is the migration, not the
        // capability object — this must still migrate once, however strict the collision test gets.
        expect(appCapability()).not.toBe(appCapability());
        const workers = [h.api([appCapability()]), await h.worker("collab", [appCapability()])];

        const runs = await migrateProject({ projectDir: h.projectDir, workers, env: "dev" });
        expect(runs[0]?.databases[0]?.results.map((r) => r.migrationName)).toEqual(["1000_app_0001_things"]);
        expect(runs[1]?.databases[0]?.results).toEqual([]);
      });

      test("a run narrowed to one worker still presents the whole shared registry", async () => {
        // The ledger of a shared D1 records both workers' migrations. A provider covering only the
        // named worker's namespaces reads as corrupted state to kysely and aborts the run — which is
        // every `pithy add`/`remove`/`upgrade --migrate`, since they always scope to one worker.
        const workers = [h.api([appCapability()]), await h.worker("collab", [multiplayerCapability("DB")])];
        await migrateProject({ projectDir: h.projectDir, workers, env: "dev" });

        const runs = await migrateProject({ projectDir: h.projectDir, workers, env: "dev", worker: "api" });
        expect(runs.map((run) => run.worker)).toEqual(["api"]);
        expect(runs[0]?.databases[0]?.results).toEqual([]);
        // The report still names the worker it shares the database with.
        expect(runs[0]?.databases[0]?.sharedWith).toEqual(["collab"]);
      });

      test("a narrowed run applies the shared database as a whole, crediting only its own", async () => {
        const workers = [h.api([appCapability()]), await h.worker("collab", [multiplayerCapability("DB")])];

        const runs = await migrateProject({ projectDir: h.projectDir, workers, env: "dev", worker: "api" });
        // api is credited with its own migration alone — collab's is applied, never misattributed.
        expect(runs[0]?.databases[0]?.results.map((r) => r.migrationName)).toEqual(["1000_app_0001_things"]);

        // Both tables landed: a shared database migrates as a whole, or the ledger diverges from it.
        const mf = new Miniflare({
          modules: true,
          script: "export default {};",
          d1Databases: { DB: "DB" },
          d1Persist: join(h.projectDir, ".wrangler", "state", "v3", "d1"),
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
        const full = await migrateProject({ projectDir: h.projectDir, workers, env: "dev" });
        expect(full.flatMap((run) => run.databases.flatMap((database) => database.results))).toEqual([]);
      });
    });

    test("workers keep their bindings but share the project's local state directory", async () => {
      // Each worker's wrangler.jsonc names the same database, in its own directory. Persistence is
      // project-scoped, so both resolve to one local store — not one file per worker.
      const workers = [h.api([appCapability()]), await h.worker("collab", [appCapability()])];
      for (const target of workers) {
        await writeFile(
          join(target.dir, "wrangler.jsonc"),
          JSON.stringify({ d1_databases: [{ binding: "DB", database_name: "shared-db" }] }),
        );
      }

      await migrateProject({ projectDir: h.projectDir, workers, env: "dev" });

      const mf = new Miniflare({
        modules: true,
        script: "export default {};",
        d1Databases: { DB: "shared-db" },
        d1Persist: join(h.projectDir, ".wrangler", "state", "v3", "d1"),
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
});
