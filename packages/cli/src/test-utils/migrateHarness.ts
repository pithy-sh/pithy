// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { D1Database } from "@cloudflare/workers-types";
import { type Capability, defineCapability } from "@pithy-sh/core/src/capability/capability";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import type { Migration } from "kysely/migration";
import { afterEach, beforeEach } from "vitest";
import { type MigrationFanOutOptions, readProjectLedger, type WorkerScope } from "../migrations/run";

/**
 * Shared scaffolding for the `migrateProject` suites, extracted so those suites can live in more
 * than one file.
 *
 * Splitting them is a speed decision, not a taste one. Vitest parallelizes across test *files* and
 * runs the tests inside one file in sequence, and every `migrateProject` call spawns its own
 * Miniflare — so a single file holding all of them serializes ~30 workerd boots. Measured before
 * the split: `migrations/run.test.ts` took 21.1s, of which the `fan-out over workers` group alone
 * was 11.8s, and it set the floor for the whole package's 28.0s node suite. One file per heavy
 * group lets those groups run at the same time.
 */

/**
 * The pending half of {@link readProjectLedger}, for the suites that assert how far a schema is behind.
 * The other half — a migration the ledger records and the project no longer declares — has its own
 * suite in `migrations/ledger.test.ts`, because it is a refusal rather than a number.
 */
export const pendingFrom = async (options: MigrationFanOutOptions): Promise<number> => {
  const ledger = await readProjectLedger(options);
  // These suites migrate databases they created a moment ago, so every one of them answers. A `partial`
  // here is the harness reporting a sum with a hole in it, and asserting a number against that would be
  // the #371 defect wearing a test's clothes — so it fails loudly instead (#371).
  if (ledger.state !== "read") {
    throw new InternalError({
      message: "The migration harness could not read every database's ledger.",
      action: "Check the fixture's wrangler.jsonc bindings — a database in scope did not answer.",
      detail: `readProjectLedger returned state ${ledger.state}`,
    });
  }
  return ledger.pending;
};

/** The local Miniflare store `pithy migrate` persists a project's `dev` databases to. */
export function persistDir(projectDir: string): string {
  return join(projectDir, ".wrangler", "state", "v3", "d1");
}

/**
 * Run `body` against the project's local D1 for `binding`, then release the store.
 *
 * Shared, because two suites need the same thing for two reasons: #588's asks what rows a retained table
 * still holds, and #694's asks which group the bookkeeping recorded. Both are "open the store migrate just
 * wrote and look", and a second copy of that drifts on the persistence path — which is the one detail in it
 * that is a product decision rather than a test's.
 */
export async function withLocalD1<T>(
  projectDir: string,
  binding: string,
  body: (db: D1Database) => Promise<T>,
): Promise<T> {
  const { Miniflare } = await import("miniflare");
  const mf = new Miniflare({
    modules: true,
    script: "export default {};",
    d1Databases: { D: binding },
    d1Persist: persistDir(projectDir),
  });
  try {
    return await body((await mf.getD1Database("D")) as unknown as D1Database);
  } finally {
    await mf.dispose();
  }
}

/** The applied migration names in a database's ledger, sorted by name. */
export async function ledgerOf(db: D1Database): Promise<string[]> {
  const { results } = await db.prepare("select name from pithy_migrations order by name").all<{ name: string }>();
  return results.map((row) => row.name);
}

/** Creates a one-column table — the smallest migration that proves `up`/`down` ran. */
export const createTable = (name: string): Migration => ({
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

/** The `things` table migration, used by the default `app` capability. */
export const createThings = createTable("things");

/** A capability with one database on `DB` — the project's baseline registry. */
export function appCapability(): Capability {
  return defineCapability({
    name: "app",
    requiredBindings: [],
    databases: {
      app: { binding: "DB", tables: {}, migrations: { "0001_things": createThings }, migrationOrder: 1000 },
    },
  });
}

/** A second capability, on its own binding by default — the other worker's registry. */
export function multiplayerCapability(binding = "COLLAB_DB"): Capability {
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

/** A throwaway project directory and the workers inside it, rebuilt per test. */
export interface MigrateHarness {
  /** The project root. A getter: `beforeEach` makes a new temp directory for every test. */
  readonly projectDir: string;
  /** The project's one worker, `apps/api`, composing `capabilities`. */
  api(capabilities: Capability[]): WorkerScope;
  /** A second worker, `apps/<name>`, so the fan-out has something to fan out over. */
  worker(name: string, capabilities: Capability[]): Promise<WorkerScope>;
}

/**
 * Registers the per-test temp project and returns the accessors the suites use. Call it once at
 * `describe` scope; `projectDir` is a getter because each test gets a fresh directory, so a plain
 * value captured at import would go stale after the first test.
 */
export function migrateHarness(): MigrateHarness {
  let dir = "";
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-migrate-"));
    await mkdir(join(dir, "apps", "api"), { recursive: true });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  return {
    get projectDir(): string {
      return dir;
    },
    api(capabilities: Capability[]): WorkerScope {
      return { name: "api", dir: join(dir, "apps", "api"), capabilities };
    },
    async worker(name: string, capabilities: Capability[]): Promise<WorkerScope> {
      const workerDir = join(dir, "apps", name);
      await mkdir(workerDir, { recursive: true });
      return { name, dir: workerDir, capabilities };
    },
  };
}
