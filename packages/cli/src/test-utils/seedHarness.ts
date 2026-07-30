// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { D1Database, KVNamespace } from "@cloudflare/workers-types";
import { type Capability, defineCapability } from "@pithy-sh/core/src/capability/capability";
import { d1SeedGroup, defineSeed, kvSeedGroup } from "@pithy-sh/core/src/seed/seed";
import type { Migration } from "kysely/migration";
import { Miniflare } from "miniflare";
import { afterEach, beforeEach } from "vitest";
import { z } from "zod";
import type { WorkerScope } from "../migrations/run";

/**
 * Shared scaffolding for the `seedProject` suites, extracted so those suites can live in more than
 * one file.
 *
 * Splitting them is a speed decision, not a taste one. Vitest parallelizes across test *files* and
 * runs the tests inside one file in sequence, and every `seedProject`/`migrateProject` call spawns
 * its own Miniflare — so a single file holding all of them serializes dozens of workerd boots.
 * Measured before the split: `seed/run.test.ts` took 25.1s, of which `--redo` was 10.1s and
 * `fan-out over workers` 9.6s, and it set the floor for the whole package's 28.0s node suite.
 *
 * See `test-utils/migrateHarness.ts` for the same treatment of the migration suites.
 */

/** A tiny two-column table — the D1 seed target. */
export const Things = z.object({
  id: z.number().int().describe("Auto-increment primary key."),
  name: z.string().describe("The thing's name."),
});

/** The migration that creates the `things` table so a seed has somewhere to land. */
export const createThings: Migration = {
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
export const notesStore = {
  prefix: "notes",
  key: z.object({ slug: z.string().describe("The note's slug segment.") }),
  value: z.object({ body: z.string().describe("The note's body.") }),
};

/** The one worker's `wrangler.jsonc` for a local run: a D1 on `DB`, a KV on `CACHE`. */
export const localWrangler = {
  d1_databases: [{ binding: "DB", database_id: "db-local" }],
  kv_namespaces: [{ binding: "CACHE", id: "cache-local" }],
};

/** A capability that both declares the `things` table / `notes` store and seeds them. */
export function dataCapability(
  environments: readonly string[] = ["dev", "staging"],
  rows: readonly { id: number; name: string }[] = [
    { id: 1, name: "one" },
    { id: 2, name: "two" },
  ],
): Capability {
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

/** A fresh Miniflare over a seed run's persisted state, for reading back what the seed wrote. */
export interface LocalStores {
  /** The `DB` database, as the seeder wrote it. */
  d1: D1Database;
  /** The `CACHE` namespace, as the seeder wrote it. */
  kv: KVNamespace;
  /** Shuts the reader down — always call it, or the workerd process outlives the test. */
  dispose: () => Promise<void>;
}

/** A throwaway project directory and the workers inside it, rebuilt per test. */
export interface SeedHarness {
  /** The project root. A getter: `beforeEach` makes a new temp directory for every test. */
  readonly projectDir: string;
  /** The one worker's directory — `apps/api`, under the project root. Also a getter. */
  readonly workerDir: string;
  /** The project's one worker, composing `capabilities`. */
  api(capabilities: Capability[]): WorkerScope;
  /** A second worker in `apps/<name>`, sharing the project root's local stores. */
  worker(name: string, capabilities: Capability[], config?: unknown): Promise<WorkerScope>;
  /** Writes the one worker's `wrangler.jsonc`. */
  writeWrangler(config: unknown): Promise<void>;
  /** Opens a fresh Miniflare over the same persisted state to read back what a seed wrote. */
  openLocal(): Promise<LocalStores>;
}

/**
 * Registers the per-test temp project and returns the accessors the suites use. Call it once at
 * `describe` scope; the directories are getters because each test gets fresh ones, so a plain value
 * captured at import would go stale after the first test.
 */
export function seedHarness(): SeedHarness {
  let dir = "";
  let workerDir = "";
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-seed-run-"));
    workerDir = join(dir, "apps", "api");
    await mkdir(workerDir, { recursive: true });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  return {
    get projectDir(): string {
      return dir;
    },
    get workerDir(): string {
      return workerDir;
    },
    api(capabilities: Capability[]): WorkerScope {
      return { name: "api", dir: workerDir, capabilities };
    },
    async worker(name: string, capabilities: Capability[], config?: unknown): Promise<WorkerScope> {
      const target = join(dir, "apps", name);
      await mkdir(target, { recursive: true });
      await writeFile(join(target, "wrangler.jsonc"), JSON.stringify(config ?? localWrangler));
      return { name, dir: target, capabilities };
    },
    async writeWrangler(config: unknown): Promise<void> {
      await writeFile(join(workerDir, "wrangler.jsonc"), JSON.stringify(config));
    },
    async openLocal(): Promise<LocalStores> {
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
    },
  };
}
