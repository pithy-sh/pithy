import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { D1Database } from "@cloudflare/workers-types";
import type { CloudflareKVManager } from "@pithy-sh/cloudflare/src/kv/kvManager";
import type { CloudflareImageManager } from "@pithy-sh/cloudflare/src/media/imageManager";
import type { CloudflareStreamManager } from "@pithy-sh/cloudflare/src/media/streamManager";
import type { CloudflareR2Manager } from "@pithy-sh/cloudflare/src/r2/r2Manager";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { openSeedDriver } from "./drivers";

describe("openSeedDriver", () => {
  let dir: string;
  /** The worker's own directory — where its wrangler.jsonc lives, under the project root. */
  let workerDir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-seed-driver-"));
    workerDir = join(dir, "apps", "api");
    await mkdir(workerDir, { recursive: true });
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  });

  async function writeWrangler(config: unknown): Promise<void> {
    await writeFile(join(workerDir, "wrangler.jsonc"), JSON.stringify(config));
  }

  describe("dev resolves local Miniflare stores", () => {
    test("D1, KV, and R2 are live and writable, then dispose releases them", async () => {
      await writeWrangler({
        d1_databases: [{ binding: "DB", database_id: "db-local" }],
        kv_namespaces: [{ binding: "CACHE", id: "cache-local" }],
        r2_buckets: [{ binding: "ASSETS", bucket_name: "assets-local" }],
      });

      const driver = await openSeedDriver({ workerDir, persistRoot: dir, env: "dev" });
      try {
        const row = await driver.d1("DB").prepare("SELECT 1 AS n").first<{ n: number }>();
        expect(row?.n).toBe(1);

        const kv = driver.kv("CACHE");
        expect(kv.kind).toBe("local");
        if (kv.kind === "local") {
          await kv.namespace.put("k", "v");
          expect(await kv.namespace.get("k")).toBe("v");
        }

        const r2 = driver.r2("ASSETS");
        expect(r2.kind).toBe("local");
        if (r2.kind === "local") {
          await r2.bucket.put("obj", "bytes");
          const object = await r2.bucket.get("obj");
          expect(await object?.text()).toBe("bytes");
        }
      } finally {
        await driver.dispose();
      }
    });

    test("two workers declaring one binding share the project's store, not one store each", async () => {
      // Bindings are per-worker; local persistence is per-project. A per-worker persistence directory
      // would silently give two workers that both declare DB two different local databases.
      const collabDir = join(dir, "apps", "collab");
      await mkdir(collabDir, { recursive: true });
      const wrangler = JSON.stringify({
        d1_databases: [{ binding: "DB", database_id: "db-local" }],
        kv_namespaces: [{ binding: "CACHE", id: "cache-local" }],
      });
      await writeFile(join(workerDir, "wrangler.jsonc"), wrangler);
      await writeFile(join(collabDir, "wrangler.jsonc"), wrangler);

      const first = await openSeedDriver({ workerDir, persistRoot: dir, env: "dev" });
      try {
        await first.d1("DB").prepare("CREATE TABLE shared (id integer primary key)").run();
        const kv = first.kv("CACHE");
        if (kv.kind === "local") await kv.namespace.put("k", "from-api");
      } finally {
        await first.dispose();
      }

      const second = await openSeedDriver({ workerDir: collabDir, persistRoot: dir, env: "dev" });
      try {
        const row = await second.d1("DB").prepare("SELECT count(*) AS n FROM shared").first<{ n: number }>();
        expect(row?.n).toBe(0); // the other worker's table is here — one store, not two
        const kv = second.kv("CACHE");
        if (kv.kind === "local") expect(await kv.namespace.get("k")).toBe("from-api");
      } finally {
        await second.dispose();
      }
    });

    test("an undeclared binding fails with an actionable error", async () => {
      await writeWrangler({ d1_databases: [] });
      const driver = await openSeedDriver({ workerDir, persistRoot: dir, env: "dev" });
      try {
        expect(() => driver.d1("DB")).toThrow(PithyError);
        expect(() => driver.d1("DB")).toThrow(/binding "DB"/);
      } finally {
        await driver.dispose();
      }
    });

    test("Images stays remote in dev and fails clearly when credentials are absent", async () => {
      vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "");
      vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
      await writeWrangler({});
      const driver = await openSeedDriver({ workerDir, persistRoot: dir, env: "dev" });
      try {
        expect(() => driver.images()).toThrow(/credentials/i);
      } finally {
        await driver.dispose();
      }
    });
  });

  describe("remote environments resolve REST managers by wrangler id", () => {
    const fakeKv = { id: "kv" } as unknown as CloudflareKVManager;
    const fakeR2 = { id: "r2" } as unknown as CloudflareR2Manager;
    const fakeImages = { id: "images" } as unknown as CloudflareImageManager;
    const fakeStream = { id: "stream" } as unknown as CloudflareStreamManager;
    const fakeD1 = { id: "d1" } as unknown as D1Database;

    test("resolves each backend's id from env.<env> and returns the injected clients", async () => {
      await writeWrangler({
        d1_databases: [],
        env: {
          staging: {
            d1_databases: [{ binding: "DB", database_id: "db-staging" }],
            kv_namespaces: [{ binding: "CACHE", id: "cache-staging" }],
            r2_buckets: [{ binding: "ASSETS", bucket_name: "assets-staging" }],
          },
        },
      });

      const d1Args: { binding: string; databaseId: string }[] = [];
      const kvArgs: { binding: string; namespaceId: string }[] = [];
      const r2Args: { binding: string; bucketName: string }[] = [];

      const driver = await openSeedDriver({
        workerDir,
        persistRoot: dir,
        env: "staging",
        remoteD1: (args) => {
          d1Args.push(args);
          return fakeD1;
        },
        remoteKv: (args) => {
          kvArgs.push(args);
          return fakeKv;
        },
        remoteR2: (args) => {
          r2Args.push(args);
          return fakeR2;
        },
        images: () => fakeImages,
        stream: () => fakeStream,
      });

      expect(driver.d1("DB")).toBe(fakeD1);
      expect(d1Args).toEqual([{ binding: "DB", databaseId: "db-staging" }]);

      const kv = driver.kv("CACHE");
      expect(kv).toEqual({ kind: "remote", manager: fakeKv });
      expect(kvArgs).toEqual([{ binding: "CACHE", namespaceId: "cache-staging" }]);

      const r2 = driver.r2("ASSETS");
      expect(r2).toEqual({ kind: "remote", manager: fakeR2 });
      expect(r2Args).toEqual([{ binding: "ASSETS", bucketName: "assets-staging" }]);

      expect(driver.images()).toBe(fakeImages);
      expect(driver.stream()).toBe(fakeStream);
    });

    test("a binding with no id for the env fails with an actionable error, without building a client", async () => {
      await writeWrangler({ env: { staging: { d1_databases: [{ binding: "DB" }] } } });
      const driver = await openSeedDriver({
        workerDir,
        persistRoot: dir,
        env: "staging",
        remoteD1: () => {
          throw new Error("must not build a client when the id is missing");
        },
      });
      expect(() => driver.d1("DB")).toThrow(PithyError);
      expect(() => driver.d1("DB")).toThrow(/database_id|DB/);
    });

    test("missing credentials fail when the default REST client is built", async () => {
      vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "");
      vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
      await writeWrangler({ env: { staging: { d1_databases: [{ binding: "DB", database_id: "db-staging" }] } } });

      const driver = await openSeedDriver({ workerDir, persistRoot: dir, env: "staging" });
      expect(() => driver.d1("DB")).toThrow(/credentials/i);
    });
  });
});
