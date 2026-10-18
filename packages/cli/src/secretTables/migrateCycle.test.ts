// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type Capability, defineCapability } from "@pithy-sh/core/src/capability/capability";
import { secrets } from "@pithy-sh/secrets/src/capability";
import { secretTablesDatabase } from "@pithy-sh/secrets/src/tables/database";
import { defineSecretTable } from "@pithy-sh/secrets/src/tables/defineSecretTable";
import type { Migration } from "kysely/migration";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { migrateProject, type WorkerScope } from "../migrations/run";
import { ledgerOf, withLocalD1 } from "../test-utils/migrateHarness";
import { generateSecretTableMigrations, SECRET_TABLE_MIGRATIONS_DIR } from "./generate";
import { readVaultTables } from "./report";

/**
 * The whole loop the issue describes, against a real local D1: a run that writes a migration applies
 * nothing, the run after it applies it, and a run with nothing to write migrates normally. Each "run" is what
 * `pithy migrate` does — generate first, migrate only when nothing was written — over a Worker composed from
 * what is on disk at that moment.
 */

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(import.meta.dirname, "..", "..", ".e2e-secret-cycle-"));
  await mkdir(join(root, "apps", "api"), { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const declare = (keys: string[]) =>
  defineSecretTable({
    name: "customer",
    keys: Object.fromEntries(keys.map((key) => [key, z.string().describe(`The ${key}.`)])),
    secrets: { STRIPE_KEY: { valueType: "text", rotatable: true } },
  });

const dir = () => join(root, "apps", "api");

/** What the directory's index composes right now, each file loaded by its own path. */
async function onDisk(): Promise<Record<string, Migration> | undefined> {
  const index = await readFile(join(dir(), SECRET_TABLE_MIGRATIONS_DIR, "index.ts"), "utf8").catch(() => null);
  if (index === null) return undefined;
  const migrations: Record<string, Migration> = {};
  for (const [, key] of index.matchAll(/^import \w+ from "\.\/(\w+)";$/gm)) {
    if (!key) continue;
    const file = pathToFileURL(join(dir(), SECRET_TABLE_MIGRATIONS_DIR, `${key}.ts`)).href;
    migrations[key] = ((await import(file)) as { default: Migration }).default;
  }
  return migrations;
}

/** The Worker as its config composes it now: the secrets capability, and the app's declared table. */
async function compose(keys: string[]): Promise<WorkerScope> {
  const migrations = await onDisk();
  const app: Capability = defineCapability({
    name: "app",
    requiredBindings: [],
    databases: {
      secrets: secretTablesDatabase({ tables: [declare(keys)], ...(migrations ? { migrations } : {}) }),
    },
  });
  return { name: "api", dir: dir(), capabilities: [secrets({ registry: {} }), app] };
}

/** One `pithy migrate --env dev`: write and stop, or migrate. Answers which it did. */
async function migrateOnce(keys: string[]): Promise<{ wrote: string[]; applied: string[] }> {
  const workers = [await compose(keys)];
  const { generated } = await generateSecretTableMigrations({ projectDir: root, env: "dev", workers, write: true });
  if (generated.length > 0) return { wrote: generated.map((one) => one.file), applied: [] };
  const run = await migrateProject({ account: null, projectDir: root, workers, env: "dev", project: "acme" });
  return {
    wrote: [],
    applied: run.flatMap((worker) =>
      worker.databases.flatMap((database) => database.results.map((r) => r.migrationName)),
    ),
  };
}

const columns = (): Promise<string[]> =>
  withLocalD1(root, "SECRETS", async (db) =>
    (
      await db.prepare("select name from pragma_table_info('pithy_secrets_customer_secrets')").all<{ name: string }>()
    ).results.map((row) => row.name),
  );

describe("pithy migrate over a declared table", () => {
  test("writes and stops, then applies on the next run, then writes nothing", async () => {
    // First run: the table is new. One file is written, and nothing is applied — not even the kit's own.
    expect(await migrateOnce(["userId", "organizationId"])).toEqual({
      wrote: ["apps/api/migrations/secrets/0001_customer_init.ts"],
      applied: [],
    });

    // Second run: the chain matches, so it migrates — the vault, its registry, and the table.
    const second = await migrateOnce(["userId", "organizationId"]);
    expect(second.wrote).toEqual([]);
    expect(second.applied).toEqual([
      "0100_secrets_0001_init",
      "0100_secrets_0002_tables",
      "1500_app_0001_customer_init",
    ]);
    expect(await columns()).toContain("organization_id");
    expect(
      await withLocalD1(root, "SECRETS", async (db) =>
        db.prepare("select keys from pithy_secrets_tables where name = 'customer'").first<{ keys: string }>(),
      ),
    ).toEqual({ keys: '["userId","organizationId"]' });

    // The declaration gains a key: an alter is written and the ledger does not move.
    expect(await migrateOnce(["userId", "organizationId", "teamId"])).toEqual({
      wrote: ["apps/api/migrations/secrets/0002_customer_team_id.ts"],
      applied: [],
    });
    expect(await withLocalD1(root, "SECRETS", ledgerOf)).not.toContain("1500_app_0002_customer_team_id");
    expect(await columns()).not.toContain("team_id");

    // Running it again applies it.
    expect(await migrateOnce(["userId", "organizationId", "teamId"])).toEqual({
      wrote: [],
      applied: ["1500_app_0002_customer_team_id"],
    });
    expect(await columns()).toContain("team_id");

    // And a declaration matching the chain writes nothing and migrates normally — there is nothing left.
    expect(await migrateOnce(["userId", "organizationId", "teamId"])).toEqual({ wrote: [], applied: [] });
  });

  test("the vault's tables read back through the same driver a migrate uses: rows and key versions", async () => {
    await migrateOnce(["userId"]);
    await migrateOnce(["userId"]);
    await withLocalD1(root, "SECRETS", async (db) => {
      for (const [user, version] of [
        ["u1", 2],
        ["u2", 2],
        ["u3", 1],
      ] as const) {
        await db
          .prepare(
            "insert into pithy_secrets_customer_secrets (name, encrypted_value, iv, key_version, value_type, created_at, updated_at, user_id) values ('STRIPE_KEY', 'c', 'i', ?, 'text', 1, 1, ?)",
          )
          .bind(version, user)
          .run();
      }
    });
    expect(
      await readVaultTables({ projectDir: root, env: "dev", account: null, workers: [await compose(["userId"])] }),
    ).toEqual({
      newestKeyVersion: 2,
      tables: [
        {
          table: "customer",
          keys: ["userId"],
          secrets: [{ name: "STRIPE_KEY", rows: 3, keyVersions: { "1": 1, "2": 2 } }],
        },
      ],
    });
  });
});
