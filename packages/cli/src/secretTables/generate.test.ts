// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type Capability, defineCapability } from "@pithy-sh/core/src/capability/capability";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { secretTablesDatabase } from "@pithy-sh/secrets/src/tables/database";
import { defineSecretTable } from "@pithy-sh/secrets/src/tables/defineSecretTable";
import type { Migration } from "kysely/migration";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import type { WorkerScope } from "../migrations/run";
import { formatGeneratedReport, generateSecretTableMigrations, SECRET_TABLE_MIGRATIONS_DIR } from "./generate";

/**
 * `pithy migrate`'s first step for a declared table: diff the declaration against the chain the Worker
 * composes, write the migration that closes it, and stop. The temp project sits inside this package so a
 * written file's `@pithy-sh/secrets` import resolves when the next "run" loads it — which is the part a
 * pure test of the diff cannot prove.
 */

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(import.meta.dirname, "..", "..", ".e2e-secret-tables-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const declare = (keys: string[], secrets: string[] = ["STRIPE_KEY"]) =>
  defineSecretTable({
    name: "customer",
    keys: Object.fromEntries(keys.map((key) => [key, z.string().describe(`The ${key}.`)])),
    secrets: Object.fromEntries(secrets.map((secret) => [secret, { valueType: "text" as const, rotatable: true }])),
  });

/** A Worker under `apps/api` composing the declaration with whatever migrations its directory holds. */
async function worker(
  table: ReturnType<typeof declare>,
  migrations?: Record<string, Migration>,
  name = "api",
): Promise<WorkerScope> {
  const dir = join(root, "apps", name);
  await mkdir(dir, { recursive: true });
  const app: Capability = defineCapability({
    name: "app",
    requiredBindings: [],
    databases: { secrets: secretTablesDatabase({ tables: [table], ...(migrations ? { migrations } : {}) }) },
  });
  return { name, dir, capabilities: [app] };
}

/**
 * Load what the directory's index composes, the way a Worker's config would on the next run. Each file the
 * index imports is loaded by its own path: the index itself is rewritten between runs, and a module cache
 * would hand back the first one.
 */
async function composed(dir: string): Promise<Record<string, Migration>> {
  const index = await readFile(join(dir, SECRET_TABLE_MIGRATIONS_DIR, "index.ts"), "utf8");
  const keys = [...index.matchAll(/^import \w+ from "\.\/(\w+)";$/gm)].map((match) => match[1] ?? "");
  const migrations: Record<string, Migration> = {};
  for (const key of keys) {
    const file = pathToFileURL(join(dir, SECRET_TABLE_MIGRATIONS_DIR, `${key}.ts`)).href;
    migrations[key] = ((await import(file)) as { default: Migration }).default;
  }
  return migrations;
}

async function files(dir: string): Promise<string[]> {
  return (await readdir(join(dir, SECRET_TABLE_MIGRATIONS_DIR))).sort();
}

describe("generateSecretTableMigrations", () => {
  test("a new declaration writes the initial migration and the index, and names both", async () => {
    const api = await worker(declare(["userId", "organizationId"]));
    const result = await generateSecretTableMigrations({ projectDir: root, env: "dev", workers: [api], write: true });

    expect(result.generated).toEqual([
      {
        worker: "api",
        table: "customer",
        change: "create",
        file: "apps/api/migrations/secrets/0001_customer_init.ts",
        addedKeys: ["userId", "organizationId"],
        addedSecrets: ["STRIPE_KEY"],
        removedSecrets: [],
      },
    ]);
    expect(await files(api.dir)).toEqual(["0001_customer_init.ts", "index.ts"]);
    const migration = (await composed(api.dir))["0001_customer_init"] as Migration & { secretTable: unknown };
    expect(migration.secretTable).toEqual({
      from: null,
      to: { table: "customer", keys: ["userId", "organizationId"], secrets: ["STRIPE_KEY"] },
    });
  });

  test("running it twice writes one file, not two — the second run finds the chain matching", async () => {
    const table = declare(["userId", "organizationId"]);
    const first = await worker(table);
    await generateSecretTableMigrations({ projectDir: root, env: "dev", workers: [first], write: true });

    const second = await worker(table, await composed(first.dir));
    const again = await generateSecretTableMigrations({ projectDir: root, env: "dev", workers: [second], write: true });
    expect(again.generated).toEqual([]);
    expect(await files(first.dir)).toEqual(["0001_customer_init.ts", "index.ts"]);
  });

  test("a gained key writes an alter numbered after the chain, and the index composes both", async () => {
    const first = await worker(declare(["userId", "organizationId"]));
    await generateSecretTableMigrations({ projectDir: root, env: "dev", workers: [first], write: true });
    const grown = await worker(declare(["userId", "organizationId", "teamId"]), await composed(first.dir));

    const result = await generateSecretTableMigrations({ projectDir: root, env: "dev", workers: [grown], write: true });
    expect(result.generated.map((one) => [one.change, one.file, one.addedKeys])).toEqual([
      ["alter", "apps/api/migrations/secrets/0002_customer_team_id.ts", ["teamId"]],
    ]);
    expect(Object.keys(await composed(first.dir))).toEqual(["0001_customer_init", "0002_customer_team_id"]);
  });

  test("a removed or renamed key is refused by name, and nothing is written", async () => {
    const first = await worker(declare(["userId", "organizationId"]));
    await generateSecretTableMigrations({ projectDir: root, env: "dev", workers: [first], write: true });
    const renamed = await worker(declare(["userId", "orgId"]), await composed(first.dir));

    const error = await generateSecretTableMigrations({
      projectDir: root,
      env: "dev",
      workers: [renamed],
      write: true,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).payload.message).toContain("organizationId");
    expect((error as ValidationError).payload.message).toContain("customer");
    expect(await files(first.dir)).toEqual(["0001_customer_init.ts", "index.ts"]);
  });

  test("a written file the spec does not compose is refused, naming the wiring to add", async () => {
    const api = await worker(declare(["userId"]));
    await generateSecretTableMigrations({ projectDir: root, env: "dev", workers: [api], write: true });
    // The adopter has not passed `secretTableMigrations` yet: the spec still composes nothing.
    const error = await generateSecretTableMigrations({
      projectDir: root,
      env: "dev",
      workers: [api],
      write: true,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).payload.message).toContain("0001_customer_init");
    expect((error as ValidationError).payload.action).toContain("secretTableMigrations");
  });

  test("a dry run says what it would write and writes nothing", async () => {
    const api = await worker(declare(["userId"]));
    const result = await generateSecretTableMigrations({ projectDir: root, env: "dev", workers: [api], write: false });
    expect(result.generated.map((one) => one.file)).toEqual(["apps/api/migrations/secrets/0001_customer_init.ts"]);
    await expect(readdir(join(api.dir, SECRET_TABLE_MIGRATIONS_DIR))).rejects.toThrow();
  });

  test("a hand-written file the index does not list is refused, naming the line to add to index.ts", async () => {
    const first = await worker(declare(["userId"]));
    await generateSecretTableMigrations({ projectDir: root, env: "dev", workers: [first], write: true });
    await writeFile(
      join(first.dir, SECRET_TABLE_MIGRATIONS_DIR, "0002_backfill.ts"),
      "export default { up: async () => {} };\n",
    );
    // `secretTableMigrations` is wired, but nobody added the hand-written file to index.ts.
    const wired = await worker(declare(["userId"]), await composed(first.dir));
    const error = await generateSecretTableMigrations({
      projectDir: root,
      env: "dev",
      workers: [wired],
      write: true,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).payload.message).toContain("0002_backfill");
    expect((error as ValidationError).payload.action).toContain("index.ts");
    expect((error as ValidationError).payload.action).toContain("0002_backfill");
    expect((error as ValidationError).payload.action).not.toContain("Pass secretTableMigrations");
    expect(await files(first.dir)).toEqual(["0001_customer_init.ts", "0002_backfill.ts", "index.ts"]);
  });

  test("a hand-written file added to index.ts counts toward the number and stays in the index", async () => {
    const first = await worker(declare(["userId"]));
    await generateSecretTableMigrations({ projectDir: root, env: "dev", workers: [first], write: true });
    await writeFile(
      join(first.dir, SECRET_TABLE_MIGRATIONS_DIR, "0002_by_hand.ts"),
      "export default { up: async () => {} };\n",
    );
    const grown = await worker(declare(["userId", "teamId"]), {
      ...(await composed(first.dir)),
      "0002_by_hand": { up: async () => {} },
    });
    const result = await generateSecretTableMigrations({ projectDir: root, env: "dev", workers: [grown], write: true });
    expect(result.generated.map((one) => one.file)).toEqual(["apps/api/migrations/secrets/0003_customer_team_id.ts"]);
    const index = await readFile(join(first.dir, SECRET_TABLE_MIGRATIONS_DIR, "index.ts"), "utf8");
    expect(index).toContain('"0002_by_hand": m0002ByHand,');
  });

  test("one table declared by two Workers is refused — one Worker owns a table's migrations", async () => {
    const table = declare(["userId"]);
    const error = await generateSecretTableMigrations({
      projectDir: root,
      env: "dev",
      workers: [await worker(table, undefined, "api"), await worker(table, undefined, "admin")],
      write: true,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).payload.message).toBe("Secret table customer is declared by api and admin.");
  });

  test("a project declaring no tables writes nothing and touches no directory", async () => {
    const dir = join(root, "apps", "api");
    await mkdir(dir, { recursive: true });
    const plain = { name: "api", dir, capabilities: [defineCapability({ name: "app", requiredBindings: [] })] };
    expect(
      await generateSecretTableMigrations({ projectDir: root, env: "dev", workers: [plain], write: true }),
    ).toEqual({
      generated: [],
    });
    expect(await readdir(dir)).toEqual([]);
  });
});

describe("formatGeneratedReport", () => {
  test("says what changed, what it wrote, and to review it before running again", () => {
    expect(
      formatGeneratedReport([
        {
          worker: "api",
          table: "customer",
          change: "alter",
          file: "apps/api/migrations/secrets/0007_customer_team_id.ts",
          addedKeys: ["teamId"],
          addedSecrets: [],
          removedSecrets: ["OLD"],
        },
      ]),
    ).toBe(
      [
        "Declaration changed: customer",
        "  + key     teamId",
        "  - secret  OLD",
        "",
        "Wrote apps/api/migrations/secrets/0007_customer_team_id.ts",
        "Review it, then run migrate again.",
        "",
      ].join("\n"),
    );
  });

  test("a new table reads as one, and two files are reviewed as them", () => {
    const report = formatGeneratedReport([
      {
        worker: "api",
        table: "customer",
        change: "create",
        file: "apps/api/migrations/secrets/0001_customer_init.ts",
        addedKeys: ["userId"],
        addedSecrets: ["STRIPE_KEY"],
        removedSecrets: [],
      },
      {
        worker: "api",
        table: "connection",
        change: "create",
        file: "apps/api/migrations/secrets/0002_connection_init.ts",
        addedKeys: ["installationId"],
        addedSecrets: ["SIGNING_KEY"],
        removedSecrets: [],
      },
    ]);
    expect(report).toContain("New secret table: customer\n  + key     userId\n  + secret  STRIPE_KEY\n");
    expect(report).toContain("Review them, then run migrate again.");
  });

  test("a dry run names what it would write, and says nothing was", () => {
    const report = formatGeneratedReport(
      [
        {
          worker: "api",
          table: "customer",
          change: "create",
          file: "apps/api/migrations/secrets/0001_customer_init.ts",
          addedKeys: ["userId"],
          addedSecrets: ["STRIPE_KEY"],
          removedSecrets: [],
        },
      ],
      true,
    );
    expect(report).toContain(
      "Would write apps/api/migrations/secrets/0001_customer_init.ts\nDry run. Nothing written.\n",
    );
    expect(report).not.toContain("Review");
  });
});
