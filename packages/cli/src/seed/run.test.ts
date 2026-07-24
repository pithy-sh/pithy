import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { D1Database, KVNamespace, R2Bucket } from "@cloudflare/workers-types";
import type { CloudflareKVManager } from "@pithy-sh/cloudflare/src/kv/kvManager";
import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { d1SeedGroup, defineSeed, kvSeedGroup, type MediaSeedItem } from "@pithy-sh/core/src/seed/seed";
import type { Migration } from "kysely/migration";
import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { migrateProject } from "../migrations/run";
import type { MediaUploader } from "./media";
import { seedProject } from "./run";

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
function dataCapability(environments: readonly string[] = ["dev", "staging"]) {
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
        d1: [
          d1SeedGroup("app", "things", Things, [
            { id: 1, name: "one" },
            { id: 2, name: "two" },
          ]),
        ],
        kv: [kvSeedGroup("cache", "notes", notesStore, [{ key: { slug: "a" }, value: { body: "hello" } }])],
      }),
    ],
  });
}

describe("seedProject", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-seed-run-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function writeWrangler(config: unknown): Promise<void> {
    await writeFile(join(dir, "wrangler.jsonc"), JSON.stringify(config));
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
    await migrateProject({ capabilities, projectDir: dir, env: "dev" });

    const report = await seedProject({ capabilities, projectDir: dir, env: "dev" });
    expect(report.dryRun).toBe(false);
    expect(report.sets).toEqual([
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
      await seedProject({ capabilities, projectDir: dir, env: "dev" });
      const again = await store.d1.prepare("SELECT count(*) AS n FROM things").first<{ n: number }>();
      expect(again?.n).toBe(2);
    } finally {
      await store.dispose();
    }
  });

  test("a dry run computes the plan and writes nothing", async () => {
    await writeWrangler(localWrangler);
    const capabilities = [dataCapability()];
    await migrateProject({ capabilities, projectDir: dir, env: "dev" });

    const report = await seedProject({ capabilities, projectDir: dir, env: "dev", dryRun: true });
    expect(report.dryRun).toBe(true);
    expect(report.sets[0]?.d1).toEqual([{ database: "app", table: "things", rows: 2 }]);
    expect(report.sets[0]?.kv).toEqual([{ namespace: "cache", store: "notes", entries: 1 }]);

    const store = await openLocal();
    try {
      const count = await store.d1.prepare("SELECT count(*) AS n FROM things").first<{ n: number }>();
      expect(count?.n).toBe(0);
    } finally {
      await store.dispose();
    }
  });

  describe("env safety", () => {
    test("a set disallowed for the requested env is reported, never run", async () => {
      await writeWrangler(localWrangler);
      // The set lists only dev/staging; a production run composes it into skippedByEnv, not the plan.
      const report = await seedProject({
        capabilities: [dataCapability()],
        projectDir: dir,
        env: "production",
        yes: true,
        confirmProduction: "yes, i really want to seed production",
      });
      expect(report.sets).toEqual([]);
      expect(report.skippedByEnv).toEqual(["1000_app_demo"]);
    });

    test("staging refuses to run without --yes", async () => {
      await writeWrangler(localWrangler);
      const failure = await seedProject({ capabilities: [dataCapability()], projectDir: dir, env: "staging" }).catch(
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(PithyError);
      expect((failure as PithyError).payload.message).toMatch(/confirmation/i);
    });

    test("production refuses without the exact confirm phrase, even with --yes", async () => {
      await writeWrangler(localWrangler);
      const capabilities = [dataCapability(["dev", "production"])];

      const noPhrase = await seedProject({
        capabilities,
        projectDir: dir,
        env: "production",
        yes: true,
        json: true,
      }).catch((error: unknown) => error);
      expect(noPhrase).toBeInstanceOf(PithyError);

      const wrongPhrase = await seedProject({
        capabilities,
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
        capabilities: [dataCapability()],
        projectDir: dir,
        env: "staging",
        dryRun: true,
      });
      expect(report.dryRun).toBe(true);
      expect(report.sets[0]?.d1).toEqual([{ database: "app", table: "things", rows: 2 }]);
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
        await migrateProject({ capabilities, projectDir: dir, env: "staging", remoteD1: () => remoteD1 });

        const report = await seedProject({
          capabilities,
          projectDir: dir,
          env: "staging",
          yes: true,
          remoteD1: () => remoteD1,
          remoteKv: () => remoteKv,
        });
        expect(report.sets[0]?.d1).toEqual([{ database: "app", table: "things", rows: 2 }]);
        expect(report.sets[0]?.kv).toEqual([{ namespace: "cache", store: "notes", entries: 1 }]);

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
      await seedProject({ capabilities, projectDir: dir, env: "dev" });
      let store = await openLocalR2();
      try {
        expect(await (await store.bucket.get("logo.png"))?.text()).toBe("NEWBYTES");
        // Simulate a live overwrite at the same key, then re-seed.
        await store.bucket.put("logo.png", "LIVEBYTES");
      } finally {
        await store.dispose();
      }

      await seedProject({ capabilities, projectDir: dir, env: "dev" });
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
        capabilities,
        projectDir: dir,
        env: "dev",
        mediaUploader: first.uploader,
      });
      expect(firstReport.sets[0]?.media).toEqual([{ store: "images", mode: "once", action: "upload", id: "img-1" }]);
      expect(first.calls).toEqual([{ store: "images", metadata: { userId: "u1", pithyEnv: "dev" } }]);
      // The minted UUID was written back to the sidecar.
      expect(JSON.parse(await readFile(ref, "utf8"))).toEqual({ id: "img-1" });

      // A second run reads the sidecar, skips the upload, and reuses the recorded id.
      const second = fakeUploader();
      const secondReport = await seedProject({
        capabilities,
        projectDir: dir,
        env: "dev",
        mediaUploader: second.uploader,
      });
      expect(secondReport.sets[0]?.media).toEqual([{ store: "images", mode: "once", action: "skip", id: "img-1" }]);
      expect(second.calls).toEqual([]);
    });

    test("an `always` asset re-uploads every run and never records a UUID", async () => {
      await writeWrangler({});
      const file = join(dir, "asset.bin");
      const ref = join(dir, "asset.ref.json");
      await writeFile(file, "PNGBYTES");
      const capabilities = [mediaCapability("always", file, ref)];

      const { uploader, calls } = fakeUploader();
      const first = await seedProject({ capabilities, projectDir: dir, env: "dev", mediaUploader: uploader });
      expect(first.sets[0]?.media).toEqual([{ store: "images", mode: "always", action: "reupload", id: "img-1" }]);

      const second = await seedProject({ capabilities, projectDir: dir, env: "dev", mediaUploader: uploader });
      expect(second.sets[0]?.media).toEqual([{ store: "images", mode: "always", action: "reupload", id: "img-2" }]);
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
      const report = await seedProject({ capabilities, projectDir: dir, env: "dev", mediaUploader: uploader });
      expect(report.sets[0]?.media).toEqual([{ store: "images", mode: "once", action: "upload", id: "img-1" }]);
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
      const failure = await seedProject({ capabilities, projectDir: dir, env: "dev", mediaUploader: uploader }).catch(
        (error: unknown) => error,
      );
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
        capabilities,
        projectDir: dir,
        env: "dev",
        dryRun: true,
        mediaUploader: uploader,
      });
      expect(report.sets[0]?.media).toEqual([{ store: "images", mode: "once", action: "upload" }]);
      expect(calls).toEqual([]);
      await expect(readFile(ref, "utf8")).rejects.toThrow();
    });
  });
});
