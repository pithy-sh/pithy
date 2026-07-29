import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { D1Database, KVNamespace, R2Bucket } from "@cloudflare/workers-types";
import type { CloudflareKVManager } from "@pithy-sh/cloudflare/src/kv/kvManager";
import { type Capability, defineCapability } from "@pithy-sh/core/src/capability/capability";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { d1SeedGroup, defineSeed, kvSeedGroup, type MediaSeedItem } from "@pithy-sh/core/src/seed/seed";
import type { Migration } from "kysely/migration";
import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import type { CliAuditEvent } from "../audit/cliAudit";
import { migrateProject, type WorkerScope } from "../migrations/run";
import type { MediaUploader } from "./media";
import { seedProject } from "./run";
import { resetConfirmPhrase } from "./safety";

/** A tiny two-column table — the D1 seed target. */
const Things = z.object({
  id: z.number().int().describe("Auto-increment primary key."),
  name: z.string().describe("The thing's name."),
});

/** The migration that creates the `things` table so a seed has somewhere to land. */
const createThings: Migration = {
  up: async (db) => {
    await db.schema
      .createTable("things")
      .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
      .addColumn("name", "text", (c) => c.notNull())
      .execute();
  },
  down: async (db) => {
    await db.schema.dropTable("things").execute();
  },
};

/** A typed KV store — the KV seed target. */
const notesStore = {
  prefix: "notes",
  key: z.object({ slug: z.string().describe("The note's slug segment.") }),
  value: z.object({ body: z.string().describe("The note's body.") }),
};

/** A capability that both declares the `things` table / `notes` store and seeds them. */
function dataCapability(
  environments: readonly string[] = ["dev", "staging"],
  rows: readonly { id: number; name: string }[] = [
    { id: 1, name: "one" },
    { id: 2, name: "two" },
  ],
) {
  return defineCapability({
    name: "app",
    requiredBindings: [],
    databases: {
      app: {
        binding: "DB",
        tables: { things: Things },
        migrations: { "0001_things": createThings },
        migrationOrder: 1000,
      },
    },
    kvNamespaces: { cache: { binding: "CACHE", stores: { notes: notesStore } } },
    seeds: [
      defineSeed({
        name: "demo",
        order: 1000,
        environments,
        d1: [d1SeedGroup("app", "things", Things, rows)],
        kv: [kvSeedGroup("cache", "notes", notesStore, [{ key: { slug: "a" }, value: { body: "hello" } }])],
      }),
    ],
  });
}

describe("seedProject", () => {
  let dir: string;
  /** The one worker's directory — `apps/api`, under the project root. */
  let workerDir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-seed-run-"));
    workerDir = join(dir, "apps", "api");
    await mkdir(workerDir, { recursive: true });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** The project's one worker, composing `capabilities`. */
  function api(capabilities: Capability[]): WorkerScope {
    return { name: "api", dir: workerDir, capabilities };
  }

  /** A second worker in `apps/<name>`, sharing the project root's local stores. */
  async function worker(name: string, capabilities: Capability[], config?: unknown): Promise<WorkerScope> {
    const target = join(dir, "apps", name);
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "wrangler.jsonc"), JSON.stringify(config ?? localWrangler));
    return { name, dir: target, capabilities };
  }

  async function writeWrangler(config: unknown): Promise<void> {
    await writeFile(join(workerDir, "wrangler.jsonc"), JSON.stringify(config));
  }

  /** Open a fresh Miniflare over the same persisted state to read back what a seed wrote. */
  async function openLocal(): Promise<{ d1: D1Database; kv: KVNamespace; dispose: () => Promise<void> }> {
    const state = join(dir, ".wrangler", "state", "v3");
    const mf = new Miniflare({
      modules: true,
      script: "export default {};",
      d1Databases: { DB: "db-local" },
      kvNamespaces: { CACHE: "cache-local" },
      d1Persist: join(state, "d1"),
      kvPersist: join(state, "kv"),
    });
    return {
      d1: (await mf.getD1Database("DB")) as unknown as D1Database,
      kv: (await mf.getKVNamespace("CACHE")) as unknown as KVNamespace,
      dispose: () => mf.dispose(),
    };
  }

  const localWrangler = {
    d1_databases: [{ binding: "DB", database_id: "db-local" }],
    kv_namespaces: [{ binding: "CACHE", id: "cache-local" }],
  };

  test("writes D1 rows and KV entries locally, idempotently", async () => {
    await writeWrangler(localWrangler);
    const capabilities = [dataCapability()];
    await migrateProject({ workers: [api(capabilities)], projectDir: dir, env: "dev" });

    const report = await seedProject({ workers: [api(capabilities)], projectDir: dir, env: "dev" });
    expect(report.dryRun).toBe(false);
    expect(report.workers[0]?.sets).toEqual([
      {
        name: "1000_app_demo",
        d1: [{ database: "app", table: "things", rows: 2 }],
        kv: [{ namespace: "cache", store: "notes", entries: 1 }],
        r2: [],
        media: [],
      },
    ]);

    const store = await openLocal();
    try {
      const count = await store.d1.prepare("SELECT count(*) AS n FROM things").first<{ n: number }>();
      expect(count?.n).toBe(2);
      expect(await store.kv.get("notes:a")).toBe(JSON.stringify({ body: "hello" }));

      // Re-running seeds nothing new: INSERT OR IGNORE keeps the row count at 2.
      await seedProject({ workers: [api(capabilities)], projectDir: dir, env: "dev" });
      const again = await store.d1.prepare("SELECT count(*) AS n FROM things").first<{ n: number }>();
      expect(again?.n).toBe(2);
    } finally {
      await store.dispose();
    }
  });

  test("a dry run computes the plan and writes nothing", async () => {
    await writeWrangler(localWrangler);
    const capabilities = [dataCapability()];
    await migrateProject({ workers: [api(capabilities)], projectDir: dir, env: "dev" });

    const report = await seedProject({ workers: [api(capabilities)], projectDir: dir, env: "dev", dryRun: true });
    expect(report.dryRun).toBe(true);
    expect(report.workers[0]?.sets[0]?.d1).toEqual([{ database: "app", table: "things", rows: 2 }]);
    expect(report.workers[0]?.sets[0]?.kv).toEqual([{ namespace: "cache", store: "notes", entries: 1 }]);

    const store = await openLocal();
    try {
      const count = await store.d1.prepare("SELECT count(*) AS n FROM things").first<{ n: number }>();
      expect(count?.n).toBe(0);
    } finally {
      await store.dispose();
    }
  });

  describe("fan-out over workers", () => {
    /** A second worker's capability: its own seed set, writing to the KV namespace both workers bind. */
    const roomsStore = {
      prefix: "rooms",
      key: z.object({ id: z.string().describe("The room's id segment.") }),
      value: z.object({ title: z.string().describe("The room's title.") }),
    };

    function collabCapability() {
      return defineCapability({
        name: "collab",
        requiredBindings: [],
        kvNamespaces: { cache: { binding: "CACHE", stores: { rooms: roomsStore } } },
        seeds: [
          defineSeed({
            name: "rooms",
            order: 2000,
            environments: ["dev"],
            kv: [kvSeedGroup("cache", "rooms", roomsStore, [{ key: { id: "r1" }, value: { title: "Room" } }])],
          }),
        ],
      });
    }

    test("runs each worker's own fixtures and reports per worker", async () => {
      await writeWrangler(localWrangler);
      const workers = [api([dataCapability()]), await worker("collab", [collabCapability()])];
      await migrateProject({ projectDir: dir, workers, env: "dev" });

      const report = await seedProject({ projectDir: dir, workers, env: "dev" });
      expect(report.workers.map((entry) => entry.worker)).toEqual(["api", "collab"]);
      expect(report.workers[0]?.sets.map((set) => set.name)).toEqual(["1000_app_demo"]);
      expect(report.workers[1]?.sets).toEqual([
        {
          name: "2000_collab_rooms",
          d1: [],
          kv: [{ namespace: "cache", store: "rooms", entries: 1 }],
          r2: [],
          media: [],
        },
      ]);
      expect(report.workers.every((entry) => entry.shared.length === 0)).toBe(true);

      // Both workers bind CACHE, so both fixtures landed in the one project-root KV store.
      const store = await openLocal();
      try {
        expect(await store.kv.get("notes:a")).toBe(JSON.stringify({ body: "hello" }));
        expect(await store.kv.get("rooms:r1")).toBe(JSON.stringify({ title: "Room" }));
      } finally {
        await store.dispose();
      }
    });

    test("a set two workers compose runs once, and the second worker says so", async () => {
      await writeWrangler(localWrangler);
      const workers = [api([dataCapability()]), await worker("collab", [dataCapability()])];
      await migrateProject({ projectDir: dir, workers, env: "dev" });

      const report = await seedProject({ projectDir: dir, workers, env: "dev" });
      expect(report.workers[0]?.sets.map((set) => set.name)).toEqual(["1000_app_demo"]);
      expect(report.workers[1]?.sets).toEqual([]);
      expect(report.workers[1]?.shared).toEqual(["1000_app_demo"]);

      const store = await openLocal();
      try {
        const count = await store.d1.prepare("SELECT count(*) AS n FROM things").first<{ n: number }>();
        expect(count?.n).toBe(2); // written once, not once per worker
      } finally {
        await store.dispose();
      }
    });

    test("a set two workers point at different databases runs in each of them", async () => {
      // Same capability, same binding name, different resolved databases — a wiring `migrate` supports
      // and migrates separately. Deduping on the set key alone would skip the second store and report
      // it as "already seeded by another worker", leaving that database empty and saying otherwise.
      await writeWrangler(localWrangler);
      const collab = await worker("collab", [dataCapability()], {
        d1_databases: [{ binding: "DB", database_id: "db-collab" }],
        kv_namespaces: [{ binding: "CACHE", id: "cache-collab" }],
      });
      const workers = [api([dataCapability()]), collab];
      await migrateProject({ projectDir: dir, workers, env: "dev" });

      const report = await seedProject({ projectDir: dir, workers, env: "dev" });
      expect(report.workers[1]?.shared).toEqual([]);
      expect(report.workers[1]?.sets.map((set) => set.name)).toEqual(["1000_app_demo"]);

      const mf = new Miniflare({
        modules: true,
        script: "export default {};",
        d1Databases: { API: "db-local", COLLAB: "db-collab" },
        d1Persist: join(dir, ".wrangler", "state", "v3", "d1"),
      });
      try {
        for (const binding of ["API", "COLLAB"]) {
          const db = (await mf.getD1Database(binding)) as unknown as D1Database;
          const count = await db.prepare("SELECT count(*) AS n FROM things").first<{ n: number }>();
          expect(count?.n, `${binding} rows`).toBe(2);
        }
      } finally {
        await mf.dispose();
      }
    });

    test("--worker narrows the fan-out to one worker", async () => {
      await writeWrangler(localWrangler);
      const workers = [api([dataCapability()]), await worker("collab", [collabCapability()])];
      await migrateProject({ projectDir: dir, workers, env: "dev" });

      const report = await seedProject({ projectDir: dir, workers, env: "dev", worker: "collab" });
      expect(report.workers.map((entry) => entry.worker)).toEqual(["collab"]);

      const store = await openLocal();
      try {
        expect(await store.kv.get("rooms:r1")).toBe(JSON.stringify({ title: "Room" }));
        // The unnamed worker's fixtures never ran.
        expect(await store.kv.get("notes:a")).toBeNull();
      } finally {
        await store.dispose();
      }
    });

    test("a dry run plans per worker too, writing nothing", async () => {
      await writeWrangler(localWrangler);
      const workers = [api([dataCapability()]), await worker("collab", [collabCapability()])];

      const report = await seedProject({ projectDir: dir, workers, env: "dev", dryRun: true });
      expect(report).toMatchObject({
        command: "seed",
        env: "dev",
        dryRun: true,
        workers: [
          { worker: "api", skippedByEnv: [], shared: [] },
          { worker: "collab", skippedByEnv: [], shared: [] },
        ],
      });
      expect(report.workers[1]?.sets.map((set) => set.name)).toEqual(["2000_collab_rooms"]);
    });
  });

  describe("env safety", () => {
    test("a set disallowed for the requested env is reported, never run", async () => {
      await writeWrangler(localWrangler);
      // The set lists only dev/staging; a production run composes it into skippedByEnv, not the plan.
      const report = await seedProject({
        workers: [api([dataCapability()])],
        projectDir: dir,
        env: "production",
        yes: true,
        confirmProduction: "yes, i really want to seed production",
      });
      expect(report.workers[0]?.sets).toEqual([]);
      expect(report.workers[0]?.skippedByEnv).toEqual(["1000_app_demo"]);
    });

    test("staging refuses to run without --yes", async () => {
      await writeWrangler(localWrangler);
      const failure = await seedProject({ workers: [api([dataCapability()])], projectDir: dir, env: "staging" }).catch(
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(PithyError);
      expect((failure as PithyError).payload.message).toMatch(/confirmation/i);
    });

    test("production refuses without the exact confirm phrase, even with --yes", async () => {
      await writeWrangler(localWrangler);
      const capabilities = [dataCapability(["dev", "production"])];

      const noPhrase = await seedProject({
        workers: [api(capabilities)],
        projectDir: dir,
        env: "production",
        yes: true,
        json: true,
      }).catch((error: unknown) => error);
      expect(noPhrase).toBeInstanceOf(PithyError);

      const wrongPhrase = await seedProject({
        workers: [api(capabilities)],
        projectDir: dir,
        env: "production",
        yes: true,
        confirmProduction: "seed it",
      }).catch((error: unknown) => error);
      expect(wrongPhrase).toBeInstanceOf(PithyError);
      expect((wrongPhrase as PithyError).payload.message).toMatch(/phrase/i);
    });

    test("a dry run needs no confirmation for a non-dev env", async () => {
      await writeWrangler(localWrangler);
      const report = await seedProject({
        workers: [api([dataCapability()])],
        projectDir: dir,
        env: "staging",
        dryRun: true,
      });
      expect(report.dryRun).toBe(true);
      expect(report.workers[0]?.sets[0]?.d1).toEqual([{ database: "app", table: "things", rows: 2 }]);
    });
  });

  describe("--redo", () => {
    test("a plain re-seed does not refresh a changed fixture value", async () => {
      await writeWrangler(localWrangler);
      const capabilities = [dataCapability()];
      await migrateProject({ workers: [api(capabilities)], projectDir: dir, env: "dev" });
      await seedProject({ workers: [api(capabilities)], projectDir: dir, env: "dev" });

      const edited = [
        dataCapability(
          ["dev", "staging"],
          [
            { id: 1, name: "ONE-CHANGED" },
            { id: 2, name: "two" },
          ],
        ),
      ];
      await seedProject({ workers: [api(edited)], projectDir: dir, env: "dev" });

      const store = await openLocal();
      try {
        const row = await store.d1.prepare("SELECT name FROM things WHERE id = 1").first<{ name: string }>();
        expect(row?.name).toBe("one"); // untouched — INSERT OR IGNORE never overwrites
        const count = await store.d1.prepare("SELECT count(*) AS n FROM things").first<{ n: number }>();
        expect(count?.n).toBe(2); // no duplicate row either
      } finally {
        await store.dispose();
      }
    });

    test("refreshes a changed fixture value: the new value lands, with no duplicate row", async () => {
      await writeWrangler(localWrangler);
      const capabilities = [dataCapability()];
      await migrateProject({ workers: [api(capabilities)], projectDir: dir, env: "dev" });
      await seedProject({ workers: [api(capabilities)], projectDir: dir, env: "dev" });

      const edited = [
        dataCapability(
          ["dev", "staging"],
          [
            { id: 1, name: "ONE-CHANGED" },
            { id: 2, name: "two" },
          ],
        ),
      ];
      const report = await seedProject({ workers: [api(edited)], projectDir: dir, env: "dev", redo: true });
      expect(report.reset).toEqual([{ database: "app", binding: "DB", migrations: 1 }]);

      const store = await openLocal();
      try {
        const row = await store.d1.prepare("SELECT name FROM things WHERE id = 1").first<{ name: string }>();
        expect(row?.name).toBe("ONE-CHANGED");
        const count = await store.d1.prepare("SELECT count(*) AS n FROM things").first<{ n: number }>();
        expect(count?.n).toBe(2);
      } finally {
        await store.dispose();
      }
    });

    test("drops and recreates the schema — a hand-inserted row is gone afterwards", async () => {
      await writeWrangler(localWrangler);
      const capabilities = [dataCapability()];
      await migrateProject({ workers: [api(capabilities)], projectDir: dir, env: "dev" });
      await seedProject({ workers: [api(capabilities)], projectDir: dir, env: "dev" });

      let store = await openLocal();
      try {
        await store.d1.prepare("INSERT INTO things (id, name) VALUES (999, 'hand-inserted')").run();
      } finally {
        await store.dispose();
      }

      await seedProject({ workers: [api(capabilities)], projectDir: dir, env: "dev", redo: true });

      store = await openLocal();
      try {
        // This is a full schema reset, not a per-row merge: the hand-inserted row is gone along with
        // everything else, and only the fixture's own rows come back.
        const survivor = await store.d1.prepare("SELECT count(*) AS n FROM things WHERE id = 999").first<{
          n: number;
        }>();
        expect(survivor?.n).toBe(0);
        const count = await store.d1.prepare("SELECT count(*) AS n FROM things").first<{ n: number }>();
        expect(count?.n).toBe(2);
      } finally {
        await store.dispose();
      }
    });

    test("--dry-run reports the reset and writes nothing", async () => {
      await writeWrangler(localWrangler);
      const capabilities = [dataCapability()];
      await migrateProject({ workers: [api(capabilities)], projectDir: dir, env: "dev" });
      await seedProject({ workers: [api(capabilities)], projectDir: dir, env: "dev" });

      const report = await seedProject({
        workers: [api(capabilities)],
        projectDir: dir,
        env: "dev",
        redo: true,
        dryRun: true,
      });
      expect(report.dryRun).toBe(true);
      expect(report.reset).toEqual([{ database: "app", binding: "DB", migrations: 1 }]);

      const store = await openLocal();
      try {
        const count = await store.d1.prepare("SELECT count(*) AS n FROM things").first<{ n: number }>();
        expect(count?.n).toBe(2); // untouched — exactly what the earlier plain seed wrote
      } finally {
        await store.dispose();
      }
    });

    test("on a non-dev env without --yes throws a PithyError — the gate is never weaker", async () => {
      await writeWrangler(localWrangler);
      const failure = await seedProject({
        workers: [api([dataCapability()])],
        projectDir: dir,
        env: "staging",
        redo: true,
      }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(PithyError);
      expect((failure as PithyError).payload.message).toMatch(/confirmation/i);
    });

    test("--yes alone cannot authorize a non-dev reset — that flag only ever authorizes an additive seed", async () => {
      await writeWrangler(localWrangler);
      const failure = await seedProject({
        workers: [api([dataCapability()])],
        projectDir: dir,
        env: "staging",
        redo: true,
        yes: true, // enough to SEED staging, deliberately not enough to DROP it
        json: true,
      }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(PithyError);
      expect((failure as PithyError).payload.message).toMatch(/destroys all of its data/i);
      expect((failure as PithyError).payload.action).toMatch(/--confirm-reset/);
    });

    test("a wrong or another env's reset phrase is refused", async () => {
      await writeWrangler(localWrangler);
      const attempt = (confirmReset: string) =>
        seedProject({
          workers: [api([dataCapability()])],
          projectDir: dir,
          env: "staging",
          redo: true,
          yes: true,
          json: true,
          confirmReset,
        }).catch((error: unknown) => error);

      expect(await attempt("yes")).toBeInstanceOf(PithyError);
      // The phrase names its environment, so one env's phrase cannot be pasted at another.
      expect(await attempt(resetConfirmPhrase("production"))).toBeInstanceOf(PithyError);
    });

    test("dev needs no reset phrase — a local store is what reset is for", async () => {
      await writeWrangler(localWrangler);
      const report = await seedProject({ workers: [api([dataCapability()])], projectDir: dir, env: "dev", redo: true });
      expect(report.reset).toBeTruthy();
    });

    test("audits a successful reset, once it actually happened", async () => {
      await writeWrangler(localWrangler);
      const events: CliAuditEvent[] = [];
      await seedProject({
        workers: [api([dataCapability()])],
        projectDir: dir,
        env: "dev",
        redo: true,
        audit: async (event) => void events.push(event),
      });

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        action: "seed/schema_reset",
        outcome: "success",
        resourceType: "schema",
        resourceId: "dev",
      });
    });

    test("a reset that dies partway is audited as a failure, never a success, and still throws", async () => {
      await writeWrangler(localWrangler);
      // A migration whose `up` always throws: `resetMigrations` rolls back cleanly (nothing applied yet
      // against this fresh local D1), then blows up reapplying — reproducing a reset that dies partway.
      const brokenUp: Migration = {
        up: async () => {
          throw new Error("boom: reapply failed");
        },
        down: async (db) => {
          await db.schema.dropTable("things").execute();
        },
      };
      const broken = defineCapability({
        name: "app",
        requiredBindings: [],
        databases: {
          app: {
            binding: "DB",
            tables: { things: Things },
            migrations: { "0001_things": brokenUp },
            migrationOrder: 1000,
          },
        },
      });

      const events: CliAuditEvent[] = [];
      const failure = await seedProject({
        workers: [api([broken])],
        projectDir: dir,
        env: "dev",
        redo: true,
        audit: async (event) => void events.push(event),
      }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(PithyError);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        action: "seed/schema_reset",
        outcome: "failure",
        resourceType: "schema",
        resourceId: "dev",
      });
    });

    test("a plain seed audits nothing — only a reset is destructive enough to record", async () => {
      await writeWrangler(localWrangler);
      const capabilities = [dataCapability()];
      await migrateProject({ workers: [api(capabilities)], projectDir: dir, env: "dev" });

      const events: CliAuditEvent[] = [];
      await seedProject({
        workers: [api(capabilities)],
        projectDir: dir,
        env: "dev",
        audit: async (event) => void events.push(event),
      });
      expect(events).toEqual([]);
    });
  });

  describe("remote environments", () => {
    test("resolves ids from env.<env> and writes through injected D1 + KV managers", async () => {
      await writeWrangler({
        d1_databases: [],
        kv_namespaces: [],
        env: {
          staging: {
            d1_databases: [{ binding: "DB", database_id: "db-staging" }],
            kv_namespaces: [{ binding: "CACHE", id: "cache-staging" }],
          },
        },
      });
      const capabilities = [dataCapability()];

      // The REST-backed D1 is substituted with an in-memory Miniflare D1 (the REST client is tested
      // separately); the KV manager is a fake capturing its `set` calls.
      const mf = new Miniflare({ modules: true, script: "export default {};", d1Databases: { REMOTE: "db-staging" } });
      const remoteD1 = (await mf.getD1Database("REMOTE")) as unknown as D1Database;
      const kvSets: { key: string; value: string }[] = [];
      const remoteKv = {
        // The remote store starts empty, so the non-destructive existence check reads a miss and writes.
        get: async () => null,
        set: async (key: string, value: string) => void kvSets.push({ key, value }),
      } as unknown as CloudflareKVManager;

      try {
        // Create the table in the fake remote D1 through the same remote orchestration.
        await migrateProject({
          workers: [api(capabilities)],
          projectDir: dir,
          env: "staging",
          remoteD1: () => remoteD1,
        });

        const report = await seedProject({
          workers: [api(capabilities)],
          projectDir: dir,
          env: "staging",
          yes: true,
          remoteD1: () => remoteD1,
          remoteKv: () => remoteKv,
        });
        expect(report.workers[0]?.sets[0]?.d1).toEqual([{ database: "app", table: "things", rows: 2 }]);
        expect(report.workers[0]?.sets[0]?.kv).toEqual([{ namespace: "cache", store: "notes", entries: 1 }]);

        const count = await remoteD1.prepare("SELECT count(*) AS n FROM things").first<{ n: number }>();
        expect(count?.n).toBe(2);
        expect(kvSets).toEqual([{ key: "notes:a", value: JSON.stringify({ body: "hello" }) }]);
      } finally {
        await mf.dispose();
      }
    });
  });

  describe("r2", () => {
    /** A capability seeding one R2 object into a bound bucket. */
    function r2Capability() {
      return defineCapability({
        name: "app",
        requiredBindings: [],
        seeds: [
          defineSeed({
            name: "objects",
            order: 3000,
            environments: ["dev"],
            r2: [{ binding: "ASSETS", key: "logo.png", body: "NEWBYTES", contentType: "image/png" }],
          }),
        ],
      });
    }

    /** Open a fresh Miniflare over the same persisted R2 state to read back what a seed wrote. */
    async function openLocalR2(): Promise<{ bucket: R2Bucket; dispose: () => Promise<void> }> {
      const state = join(dir, ".wrangler", "state", "v3");
      const mf = new Miniflare({
        modules: true,
        script: "export default {};",
        r2Buckets: { ASSETS: "assets-local" },
        r2Persist: join(state, "r2"),
      });
      return { bucket: (await mf.getR2Bucket("ASSETS")) as unknown as R2Bucket, dispose: () => mf.dispose() };
    }

    test("never overwrites an existing object — a re-run preserves live bytes", async () => {
      await writeWrangler({ r2_buckets: [{ binding: "ASSETS", bucket_name: "assets-local" }] });
      const capabilities = [r2Capability()];

      // First run writes the object.
      await seedProject({ workers: [api(capabilities)], projectDir: dir, env: "dev" });
      let store = await openLocalR2();
      try {
        expect(await (await store.bucket.get("logo.png"))?.text()).toBe("NEWBYTES");
        // Simulate a live overwrite at the same key, then re-seed.
        await store.bucket.put("logo.png", "LIVEBYTES");
      } finally {
        await store.dispose();
      }

      await seedProject({ workers: [api(capabilities)], projectDir: dir, env: "dev" });
      store = await openLocalR2();
      try {
        // The existing object is untouched — seeding is non-destructive, like INSERT OR IGNORE.
        expect(await (await store.bucket.get("logo.png"))?.text()).toBe("LIVEBYTES");
      } finally {
        await store.dispose();
      }
    });
  });

  describe("media", () => {
    /** A fake minter recording each upload's store + metadata and returning a deterministic id. */
    function fakeUploader(): { uploader: MediaUploader; calls: { store: string; metadata: Record<string, string> }[] } {
      const calls: { store: string; metadata: Record<string, string> }[] = [];
      const uploader: MediaUploader = {
        images: async (_bytes, metadata) => {
          calls.push({ store: "images", metadata });
          return { id: `img-${calls.length}` };
        },
        stream: async (_bytes, metadata) => {
          calls.push({ store: "stream", metadata });
          return { id: `vid-${calls.length}` };
        },
      };
      return { uploader, calls };
    }

    function mediaCapability(
      mode: "once" | "always",
      file: string,
      ref: string,
      extra: { baseDir?: string; record?: MediaSeedItem["record"] } = {},
    ) {
      const item: MediaSeedItem = {
        store: "images",
        mode,
        file,
        ref,
        metadata: { userId: "u1" },
        ...(extra.record !== undefined ? { record: extra.record } : {}),
      };
      return defineCapability({
        name: "app",
        requiredBindings: [],
        seeds: [
          defineSeed({
            name: "assets",
            order: 2000,
            environments: ["dev"],
            ...(extra.baseDir !== undefined ? { baseDir: extra.baseDir } : {}),
            media: [item],
          }),
        ],
      });
    }

    test("a `once` asset uploads and records the UUID, then a re-run skips it", async () => {
      await writeWrangler({});
      const file = join(dir, "asset.bin");
      const ref = join(dir, "asset.ref.json");
      await writeFile(file, "PNGBYTES");
      const capabilities = [mediaCapability("once", file, ref)];

      const first = fakeUploader();
      const firstReport = await seedProject({
        workers: [api(capabilities)],
        projectDir: dir,
        env: "dev",
        mediaUploader: first.uploader,
      });
      expect(firstReport.workers[0]?.sets[0]?.media).toEqual([
        { store: "images", mode: "once", action: "upload", id: "img-1" },
      ]);
      expect(first.calls).toEqual([{ store: "images", metadata: { userId: "u1", pithyEnv: "dev" } }]);
      // The minted UUID was written back to the sidecar.
      expect(JSON.parse(await readFile(ref, "utf8"))).toEqual({ id: "img-1" });

      // A second run reads the sidecar, skips the upload, and reuses the recorded id.
      const second = fakeUploader();
      const secondReport = await seedProject({
        workers: [api(capabilities)],
        projectDir: dir,
        env: "dev",
        mediaUploader: second.uploader,
      });
      expect(secondReport.workers[0]?.sets[0]?.media).toEqual([
        { store: "images", mode: "once", action: "skip", id: "img-1" },
      ]);
      expect(second.calls).toEqual([]);
    });

    test("an `always` asset re-uploads every run and never records a UUID", async () => {
      await writeWrangler({});
      const file = join(dir, "asset.bin");
      const ref = join(dir, "asset.ref.json");
      await writeFile(file, "PNGBYTES");
      const capabilities = [mediaCapability("always", file, ref)];

      const { uploader, calls } = fakeUploader();
      const first = await seedProject({
        workers: [api(capabilities)],
        projectDir: dir,
        env: "dev",
        mediaUploader: uploader,
      });
      expect(first.workers[0]?.sets[0]?.media).toEqual([
        { store: "images", mode: "always", action: "reupload", id: "img-1" },
      ]);

      const second = await seedProject({
        workers: [api(capabilities)],
        projectDir: dir,
        env: "dev",
        mediaUploader: uploader,
      });
      expect(second.workers[0]?.sets[0]?.media).toEqual([
        { store: "images", mode: "always", action: "reupload", id: "img-2" },
      ]);
      expect(calls).toHaveLength(2);
      // No sidecar was written — an `always` asset re-uploads deliberately.
      await expect(readFile(ref, "utf8")).rejects.toThrow();
    });

    test("resolves relative media paths against the set's baseDir, not the project root", async () => {
      await writeWrangler({});
      // The seed module (and its byte file) live in a subdirectory, addressed by the set's baseDir.
      const moduleDir = join(dir, "seeds");
      await mkdir(moduleDir, { recursive: true });
      await writeFile(join(moduleDir, "asset.bin"), "PNGBYTES");
      const capabilities = [mediaCapability("once", "asset.bin", "asset.ref.json", { baseDir: moduleDir })];

      const { uploader, calls } = fakeUploader();
      const report = await seedProject({
        workers: [api(capabilities)],
        projectDir: dir,
        env: "dev",
        mediaUploader: uploader,
      });
      expect(report.workers[0]?.sets[0]?.media).toEqual([
        { store: "images", mode: "once", action: "upload", id: "img-1" },
      ]);
      expect(calls).toHaveLength(1);
      // The sidecar was written next to the module (baseDir), never at the project root.
      expect(JSON.parse(await readFile(join(moduleDir, "asset.ref.json"), "utf8"))).toEqual({ id: "img-1" });
      await expect(readFile(join(dir, "asset.ref.json"), "utf8")).rejects.toThrow();
    });

    test("an `always` asset with a D1 record is rejected before any upload", async () => {
      await writeWrangler({});
      const file = join(dir, "asset.bin");
      const ref = join(dir, "asset.ref.json");
      await writeFile(file, "PNGBYTES");
      const capabilities = [
        mediaCapability("always", file, ref, { record: { database: "app", table: "assets", row: { url: "u" } } }),
      ];

      const { uploader, calls } = fakeUploader();
      const failure = await seedProject({
        workers: [api(capabilities)],
        projectDir: dir,
        env: "dev",
        mediaUploader: uploader,
      }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(PithyError);
      expect((failure as PithyError).payload.message).toMatch(/always/i);
      expect(calls).toEqual([]); // fail-fast: no upload happened
    });

    test("a dry run reports the media action without uploading", async () => {
      await writeWrangler({});
      const file = join(dir, "asset.bin");
      const ref = join(dir, "asset.ref.json");
      await writeFile(file, "PNGBYTES");
      const capabilities = [mediaCapability("once", file, ref)];

      const { uploader, calls } = fakeUploader();
      const report = await seedProject({
        workers: [api(capabilities)],
        projectDir: dir,
        env: "dev",
        dryRun: true,
        mediaUploader: uploader,
      });
      expect(report.workers[0]?.sets[0]?.media).toEqual([{ store: "images", mode: "once", action: "upload" }]);
      expect(calls).toEqual([]);
      await expect(readFile(ref, "utf8")).rejects.toThrow();
    });
  });
});
