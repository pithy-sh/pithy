// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { D1Database } from "@cloudflare/workers-types";
import type { CloudflareKVManager } from "@pithy-sh/cloudflare/src/kv/kvManager";
import type { CloudflareImageManager } from "@pithy-sh/cloudflare/src/media/imageManager";
import type { CloudflareStreamManager } from "@pithy-sh/cloudflare/src/media/streamManager";
import type { CloudflareR2Manager } from "@pithy-sh/cloudflare/src/r2/r2Manager";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { featureConfigPath } from "../provision/featureConfig";
import { fixOf } from "../terminal/exitClass";
import { openSeedDriver, resolveStoreIds } from "./drivers";

/** The `PithyError` a call raised. */
function refusalOf(call: () => unknown): PithyError {
  try {
    call();
  } catch (error) {
    if (error instanceof PithyError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

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

      const driver = await openSeedDriver({ account: null, workerDir, persistRoot: dir, env: "dev" });
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

      const first = await openSeedDriver({ account: null, workerDir, persistRoot: dir, env: "dev" });
      try {
        await first.d1("DB").prepare("CREATE TABLE shared (id integer primary key)").run();
        const kv = first.kv("CACHE");
        if (kv.kind === "local") await kv.namespace.put("k", "from-api");
      } finally {
        await first.dispose();
      }

      const second = await openSeedDriver({ account: null, workerDir: collabDir, persistRoot: dir, env: "dev" });
      try {
        const row = await second.d1("DB").prepare("SELECT count(*) AS n FROM shared").first<{ n: number }>();
        expect(row?.n).toBe(0); // the other worker's table is here — one store, not two
        const kv = second.kv("CACHE");
        if (kv.kind === "local") expect(await kv.namespace.get("k")).toBe("from-api");
      } finally {
        await second.dispose();
      }
    });

    test("a database_name with no id resolves to the store wrangler keys on — the binding", async () => {
      // `pithy add` writes `database_name: "<project>-<env>-<binding>"` and no `database_id`, and
      // wrangler's `d1DatabaseEntry` computes the Miniflare id as `preview_database_id ?? database_id`
      // else the binding — it never reads `database_name`. Resolving the name here would seed a store
      // `pithy dev` never opens, so the driver must land on the same file wrangler serves: `DB`.
      await writeWrangler({ d1_databases: [{ binding: "DB", database_name: "acme-dev-db" }] });

      const driver = await openSeedDriver({ account: null, workerDir, persistRoot: dir, env: "dev" });
      try {
        await driver.d1("DB").prepare("CREATE TABLE seeded (id integer primary key)").run();
      } finally {
        await driver.dispose();
      }

      // Reopen the store exactly as wrangler binds it — id `DB` — and the table is there.
      const wranglerView = new Miniflare({
        modules: true,
        script: "export default {};",
        d1Databases: { DB: "DB" },
        d1Persist: join(dir, ".wrangler", "state", "v3", "d1"),
      });
      try {
        const row = await (await wranglerView.getD1Database("DB"))
          .prepare("SELECT count(*) AS n FROM seeded")
          .first<{ n: number }>();
        expect(row?.n).toBe(0);
      } finally {
        await wranglerView.dispose();
      }
    });

    test("an undeclared binding fails with an actionable error", async () => {
      await writeWrangler({ d1_databases: [] });
      const driver = await openSeedDriver({ account: null, workerDir, persistRoot: dir, env: "dev" });
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
      const driver = await openSeedDriver({ account: null, workerDir, persistRoot: dir, env: "dev" });
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
        account: null,
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
        account: null,
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

    /**
     * The id is missing because the environment was never provisioned, so the refusal is exit 3 and names
     * the command that provisions it (#697) — the feature form for a feature, since `pithy provision`
     * refuses `--env feature`.
     */
    test.each([
      ["staging", "pithy provision --env staging --yes"],
      ["feature", "pithy provision --feature"],
    ])("a missing id on %s is a precondition whose fix is %s", async (env, fix) => {
      const config = JSON.stringify({ env: { [env]: { kv_namespaces: [{ binding: "CACHE" }] } } });
      if (env === "feature") {
        await mkdir(join(workerDir, ".wrangler", "pithy"), { recursive: true });
        await writeFile(featureConfigPath(workerDir), config);
      } else {
        await writeFile(join(workerDir, "wrangler.jsonc"), config);
      }
      const driver = await openSeedDriver({ account: null, workerDir, persistRoot: dir, env });

      const error = refusalOf(() => driver.kv("CACHE"));
      expect(error.payload.code).toBe("core/precondition_failed");
      expect(fixOf(error)).toBe(fix);
    });

    // Provisioning production needs the `--confirm` phrase too, a person's to give, so `--yes` alone would
    // end exit 5. A `fix` is runnable as written; production gets none (#697).
    test.each([
      ["prod", undefined],
      ["live", ["live"]],
    ])("a missing id on %s, a production environment, carries no fix", async (env, productionEnvironments) => {
      await writeWrangler({ env: { [env]: { kv_namespaces: [{ binding: "CACHE" }] } } });
      const driver = await openSeedDriver({
        account: null,
        workerDir,
        persistRoot: dir,
        env,
        ...(productionEnvironments ? { productionEnvironments } : {}),
      });

      const error = refusalOf(() => driver.kv("CACHE"));
      expect(error.payload.code).toBe("core/precondition_failed");
      expect(fixOf(error)).toBeUndefined();
    });

    test("missing credentials fail when the default REST client is built", async () => {
      vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "");
      vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
      await writeWrangler({ env: { staging: { d1_databases: [{ binding: "DB", database_id: "db-staging" }] } } });

      const driver = await openSeedDriver({ account: null, workerDir, persistRoot: dir, env: "staging" });
      expect(() => driver.d1("DB")).toThrow(/credentials/i);
    });

    // A missing R2_CREDENTIALS is the same kind of failure as a missing Cloudflare pair: the call is right
    // and the environment it needs is not set up yet. Exit 3, not 2 — there is no different call to make.
    test("missing R2 credentials are an unmet precondition", async () => {
      vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acct");
      vi.stubEnv("CLOUDFLARE_API_TOKEN", "token");
      vi.stubEnv("R2_CREDENTIALS", "");
      await writeWrangler({ env: { staging: { r2_buckets: [{ binding: "ASSETS", bucket_name: "assets-staging" }] } } });

      const driver = await openSeedDriver({ account: null, workerDir, persistRoot: dir, env: "staging" });
      const error = refusalOf(() => driver.r2("ASSETS"));
      expect(error.payload).toMatchObject({
        code: "core/precondition_failed",
        message: "R2 credentials are missing.",
        action: "Set R2_CREDENTIALS (the S3 access-key/secret-key pair) to seed R2 objects.",
      });
    });
  });

  describe("resolveStoreIds", () => {
    test("dev keys a D1 on database_id else the binding — never database_name", async () => {
      // The dedupe key must be the same identity the local driver opens, which is wrangler's:
      // `d1DatabaseEntry` reads `preview_database_id ?? database_id` else the binding. A stanza from
      // `pithy add` carries only `database_name`, so it must resolve to `DB`, not to `acme-dev-db`.
      await writeWrangler({
        d1_databases: [
          { binding: "DB", database_name: "acme-dev-db" },
          { binding: "COLLAB_DB", database_name: "acme-dev-collab", database_id: "collab-id" },
        ],
      });

      const ids = await resolveStoreIds({ workerDir, env: "dev" });
      expect(ids.d1.get("DB")).toBe("DB");
      expect(ids.d1.get("COLLAB_DB")).toBe("collab-id");
    });

    test("a remote env still keys on database_id alone", async () => {
      await writeWrangler({
        env: { staging: { d1_databases: [{ binding: "DB", database_name: "acme-staging-db", database_id: "sid" }] } },
      });
      expect((await resolveStoreIds({ workerDir, env: "staging" })).d1.get("DB")).toBe("sid");
    });
  });
});
