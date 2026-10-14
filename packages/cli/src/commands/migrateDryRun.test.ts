// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { D1Database } from "@cloudflare/workers-types";
import { runCommand } from "citty";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Plan } from "../plan/plan";
import { scaffoldProject } from "../project/scaffold";
import { linkKitPackages } from "../test-utils/linkKit";
import { captureStdout, commandAt, expectConforms, runCaptured } from "../test-utils/payloadContract";
import { snapshotTree } from "../test-utils/treeSnapshot";

/**
 * **`pithy migrate --dry-run` applies nothing and writes nothing (#697)** — the real command, in a
 * scaffolded project whose app declares one migration. Locally the project's tree is byte-identical after,
 * store and all. Against a remote environment the Cloudflare D1 client is replaced by a database that
 * records every statement sent to it, and every one of them is a read.
 *
 * The planning itself, refusals included, is `migrations/dryRun.test.ts`'s; this is the command around it.
 */

const remote = vi.hoisted(() => ({ d1: undefined as unknown as () => unknown }));
vi.mock("../cloudflare/clients", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cloudflare/clients")>()),
  cloudflareClients: async () => ({ d1: () => remote.d1() }),
}));

/** The app capability, with one table, so there is a migration to plan. */
const APP_CONFIG = `import { defineCapability } from "@pithy-sh/core/src/capability/capability";

const app = defineCapability({
  name: "app",
  requiredBindings: [],
  databases: {
    app: {
      binding: "DB",
      tables: {},
      migrations: {
        "0001_things": {
          up: async (db) => {
            await db.schema.createTable("things").addColumn("id", "integer").execute();
          },
          down: async (db) => {
            await db.schema.dropTable("things").execute();
          },
        },
      },
      migrationOrder: 1000,
    },
  },
});

export default { capabilities: [], app };
`;

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-migrate-dry-"));
  await scaffoldProject({ targetDir: dir, appName: "acme", worker: "api" });
  await linkKitPackages(dir, ["core"]);
  await writeFile(join(dir, "apps", "api", "pithy.config.ts"), APP_CONFIG);
  vi.spyOn(process, "cwd").mockReturnValue(dir);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

describe("pithy migrate --dry-run, locally", () => {
  test("--json: the published payload with its plan, and the project byte-identical after", async () => {
    const before = await snapshotTree(dir);
    const written = await runCaptured("migrate", ["--dry-run", "--json"]);

    await expectConforms("migrate", written);
    const payload = JSON.parse(written.join(""));
    expect(payload).toMatchObject({ command: "migrate", env: "dev", rollback: false, dryRun: true, workers: [] });
    expect(payload.group).toBeUndefined();
    expect(Plan.parse(payload.plan).migrations).toEqual([
      { env: "dev", worker: "acme-api", database: "app", binding: "DB", name: "1000_app_0001_things", direction: "up" },
    ]);
    expect(await snapshotTree(dir)).toEqual(before);
  });

  test("a rollback plans the group's migrations and asks nobody anything", async () => {
    await runCaptured("migrate", ["--group", "release-7", "--json"]);
    const before = await snapshotTree(dir);

    const written = await runCaptured("migrate", ["--rollback", "--group", "release-7", "--dry-run", "--json"]);

    const payload = JSON.parse(written.join(""));
    expect(payload).toMatchObject({ rollback: true, group: "release-7", dryRun: true });
    expect(Plan.parse(payload.plan).migrations.map((m) => [m.name, m.direction])).toEqual([
      ["1000_app_0001_things", "down"],
    ]);
    expect(await snapshotTree(dir)).toEqual(before);
  });

  test("text: the plan, then the dry-run line in place of Done.", async () => {
    const before = await snapshotTree(dir);
    const written = captureStdout();
    await runCommand(await commandAt("migrate"), { rawArgs: ["--dry-run"] });
    // The step the run raises before it reads a database is raised here too, for the same reason: it is a read.
    const lines = written
      .join("")
      .split("\n")
      .filter((line) => line !== "" && !line.startsWith("▸"));
    expect(lines).toEqual(["Would apply 1000_app_0001_things to app (DB, dev).", "Dry run. Nothing written."]);
    expect(await snapshotTree(dir)).toEqual(before);
  });

  test("a real run says dryRun: false", async () => {
    const written = await runCaptured("migrate", ["--json"]);
    await expectConforms("migrate", written);
    const payload = JSON.parse(written.join(""));
    expect(payload.dryRun).toBe(false);
    expect(payload.plan).toBeUndefined();
  });
});

describe("pithy migrate --dry-run, against staging", () => {
  let miniflare: Miniflare;
  const statements: string[] = [];

  beforeEach(async () => {
    statements.length = 0;
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acct");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "tok");
    miniflare = new Miniflare(
      convertV4MiniflareOptions({ modules: true, script: "export default {};", d1Databases: { DB: "db-1" } }),
    );
    const db = (await miniflare.getD1Database("DB")) as unknown as D1Database;
    remote.d1 = () =>
      new Proxy(db, {
        get(target, property) {
          if (property === "prepare") {
            return (sql: string) => {
              statements.push(sql);
              return target.prepare(sql);
            };
          }
          const value = Reflect.get(target, property) as unknown;
          return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        },
      });
    await writeFile(
      join(dir, "apps", "api", "wrangler.jsonc"),
      JSON.stringify({
        name: "acme-api",
        main: "src/index.ts",
        env: { staging: { d1_databases: [{ binding: "DB", database_id: "db-1" }] } },
      }),
    );
  });

  afterEach(async () => {
    await miniflare.dispose();
  });

  test("every statement it sends is a select, and the plan names what is pending", async () => {
    const written = await runCaptured("migrate", ["--env", "staging", "--dry-run", "--json"]);

    await expectConforms("migrate", written);
    const payload = JSON.parse(written.join(""));
    expect(Plan.parse(payload.plan).migrations.map((m) => [m.env, m.name])).toEqual([
      ["staging", "1000_app_0001_things"],
    ]);
    expect(statements.length).toBeGreaterThan(0);
    for (const sql of statements) expect(sql.trimStart().toLowerCase()).toMatch(/^select\b/);
  });
});
