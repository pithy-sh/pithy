// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { D1Database } from "@cloudflare/workers-types";
import { type Capability, defineCapability } from "@pithy-sh/core/src/capability/capability";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { claimMigrationOwnership } from "@pithy-sh/core/src/migrations/owner";
import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  createTable,
  ledgerOf,
  migrateHarness,
  multiplayerCapability,
  withLocalD1,
} from "../test-utils/migrateHarness";
import { snapshotTree } from "../test-utils/treeSnapshot";
import { migrateProject, planMigrateProject, type WorkerScope } from "./run";

/**
 * **`pithy migrate --dry-run` lists what the run would apply, and applies nothing (#697).**
 *
 * The plan is read the way the run reads before it writes — the same fan-out, the same groups, the same
 * ledger refusal, the same group pre-flight and retained count — and stops where the run would start
 * changing a database. It never stamps an owner either: a database nobody has claimed stays unclaimed, and
 * one another project owns is refused with the run's own words.
 *
 * Locally that means the project's `.wrangler/state` is not even opened in place. The store is copied and
 * the copy is read, because opening a Miniflare store can write to it, and a dry run that leaves a file
 * behind has written something. `snapshotTree` holds that for every case here.
 */

/** The app capability, carrying whichever migrations a case needs on `DB`. */
function appWith(names: string[]): Capability {
  return defineCapability({
    name: "app",
    requiredBindings: [],
    databases: {
      app: {
        binding: "DB",
        tables: {},
        migrations: Object.fromEntries(names.map((name) => [name, createTable(name.slice(5))])),
        migrationOrder: 1000,
      },
    },
  });
}

/** What a rejected promise threw, as a `PithyError`. */
async function refusal(promise: Promise<unknown>): Promise<PithyError> {
  const outcome = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(outcome).toBeInstanceOf(PithyError);
  return outcome as PithyError;
}

describe("planMigrateProject, against the local store", () => {
  const h = migrateHarness();
  const base = (names: string[]) => ({
    account: null,
    projectDir: h.projectDir,
    env: "dev",
    project: "acme",
    workers: [h.api([appWith(names)])],
  });

  test("a store that does not exist yet: every migration, and no store is created", async () => {
    const before = await snapshotTree(h.projectDir);

    const planned = await planMigrateProject(base(["0001_things", "0002_more"]));

    expect(planned).toEqual([
      { env: "dev", worker: "api", database: "app", binding: "DB", name: "1000_app_0001_things", direction: "up" },
      { env: "dev", worker: "api", database: "app", binding: "DB", name: "1000_app_0002_more", direction: "up" },
    ]);
    expect(await snapshotTree(h.projectDir)).toEqual(before);
  });

  test("a store that has run some: only what is pending, and the store is byte-identical after", async () => {
    await migrateProject({ ...base(["0001_things"]), group: "release-7" });
    const before = await snapshotTree(h.projectDir);

    const planned = await planMigrateProject(base(["0001_things", "0002_more"]));

    expect(planned.map((migration) => migration.name)).toEqual(["1000_app_0002_more"]);
    expect(await snapshotTree(h.projectDir)).toEqual(before);
    await withLocalD1(h.projectDir, "DB", async (db) => expect(await ledgerOf(db)).toEqual(["1000_app_0001_things"]));
  });

  test("a rollback names the group's migrations, newest first, and reverses none of them", async () => {
    await migrateProject({ ...base(["0001_things", "0002_more"]), group: "release-7" });
    const before = await snapshotTree(h.projectDir);

    const planned = await planMigrateProject({
      ...base(["0001_things", "0002_more"]),
      rollback: true,
      group: "release-7",
    });

    expect(planned.map((migration) => [migration.name, migration.direction])).toEqual([
      ["1000_app_0002_more", "down"],
      ["1000_app_0001_things", "down"],
    ]);
    expect(await snapshotTree(h.projectDir)).toEqual(before);
  });

  test("a database two Workers share: each migration is credited to the Worker that declared it, as the run credits it", async () => {
    // One physical D1, reached by each Worker under its own binding and its own database key.
    const api = h.api([appWith(["0001_things"])]);
    const collab = await h.worker("collab", [multiplayerCapability("COLLAB_DB")]);
    await writeFile(
      join(api.dir, "wrangler.jsonc"),
      JSON.stringify({ d1_databases: [{ binding: "DB", database_id: "shared-1" }] }),
    );
    await writeFile(
      join(collab.dir, "wrangler.jsonc"),
      JSON.stringify({ d1_databases: [{ binding: "COLLAB_DB", database_id: "shared-1" }] }),
    );
    const shared = { ...base([]), workers: [api, collab] };
    const before = await snapshotTree(h.projectDir);

    const planned = await planMigrateProject(shared);

    expect(planned).toEqual([
      {
        env: "dev",
        worker: "collab",
        database: "collab",
        binding: "COLLAB_DB",
        name: "0500_multiplayer_0001_rooms",
        direction: "up",
      },
      { env: "dev", worker: "api", database: "app", binding: "DB", name: "1000_app_0001_things", direction: "up" },
    ]);
    expect(await snapshotTree(h.projectDir)).toEqual(before);

    // The run attributes the same set the same way, so the plan and the report cannot disagree.
    const runs = await migrateProject({ ...shared, group: "release-7" });
    const credited = runs.flatMap((run) =>
      run.databases.flatMap((database) =>
        database.results.map((result) => ({
          worker: run.worker,
          database: database.database,
          binding: database.binding,
          name: result.migrationName,
        })),
      ),
    );
    expect(planned.map(({ worker, database, binding, name }) => ({ worker, database, binding, name }))).toEqual(
      expect.arrayContaining(credited),
    );
    expect(credited).toHaveLength(planned.length);
  });

  test("a rollback with no group is refused exactly as the run refuses it", async () => {
    await migrateProject({ ...base(["0001_things"]), group: "release-7" });

    const planned = await refusal(planMigrateProject({ ...base(["0001_things"]), rollback: true }));
    const real = await refusal(migrateProject({ ...base(["0001_things"]), rollback: true }));

    expect(planned.payload.message).toBe(real.payload.message);
    expect(planned.payload.action).toBe(real.payload.action);
  });
});

describe("planMigrateProject, against a remote database", () => {
  const h = migrateHarness();
  let miniflare: Miniflare;
  let remote: D1Database;
  const statements: string[] = [];

  beforeEach(async () => {
    statements.length = 0;
    miniflare = new Miniflare({ modules: true, script: "export default {};", d1Databases: { DB: "db-1" } });
    remote = (await miniflare.getD1Database("DB")) as unknown as D1Database;
  });
  afterEach(async () => {
    await miniflare.dispose();
  });

  /** The remote D1, recording every statement a caller prepares on it. */
  function recorded(): D1Database {
    return new Proxy(remote, {
      get(target, property) {
        if (property === "prepare") {
          return (sql: string) => {
            statements.push(sql);
            return target.prepare(sql);
          };
        }
        if (property === "batch" || property === "exec") {
          return () => {
            throw new Error(`A plan called D1 ${String(property)}.`);
          };
        }
        const value = Reflect.get(target, property) as unknown;
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
  }

  async function staging(names: string[]): Promise<{ workers: WorkerScope[] }> {
    const api = h.api([appWith(names)]);
    await writeFile(
      join(api.dir, "wrangler.jsonc"),
      JSON.stringify({ env: { staging: { d1_databases: [{ binding: "DB", database_id: "db-1" }] } } }),
    );
    return { workers: [api] };
  }

  const options = (workers: WorkerScope[], remoteD1: () => D1Database) => ({
    account: null,
    projectDir: h.projectDir,
    env: "staging",
    project: "acme",
    workers,
    remoteD1,
  });

  test("reads, and only reads: every statement it sends is a select", async () => {
    const { workers } = await staging(["0001_things", "0002_more"]);
    await migrateProject({ ...options(workers, () => remote), workers: [h.api([appWith(["0001_things"])])] });

    const planned = await planMigrateProject(options(workers, recorded));

    expect(planned.map((migration) => [migration.env, migration.name])).toEqual([["staging", "1000_app_0002_more"]]);
    expect(statements.length).toBeGreaterThan(0);
    for (const sql of statements) expect(sql.trimStart().toLowerCase()).toMatch(/^select\b/);
  });

  test("a database nobody owns stays unowned: the plan claims nothing", async () => {
    const { workers } = await staging(["0001_things"]);

    await planMigrateProject(options(workers, recorded));

    const owner = await remote
      .prepare("select name from sqlite_master where type = 'table' and name = 'pithy_migrations_owner'")
      .first();
    expect(owner).toBeNull();
  });

  test("a database another project owns is refused in the run's own words", async () => {
    const { workers } = await staging(["0001_things"]);
    await claimMigrationOwnership(remote, { project: "someone-else", binding: "DB" });

    const planned = await refusal(planMigrateProject(options(workers, recorded)));
    const real = await refusal(migrateProject(options(workers, () => remote)));

    expect(planned.payload.code).toBe(real.payload.code);
    expect(planned.payload.message).toBe(real.payload.message);
    expect(planned.payload.action).toBe(real.payload.action);
  });

  test("a database the caller is about to create is read as empty: every migration, and no round trip", async () => {
    const { workers } = await staging(["0001_things", "0002_more"]);

    const planned = await planMigrateProject({
      ...options(workers, () => {
        throw new Error("A database that does not exist yet was reached for.");
      }),
      fresh: new Set(["db-1"]),
    });

    expect(planned.map((migration) => migration.name)).toEqual(["1000_app_0001_things", "1000_app_0002_more"]);
  });
});
