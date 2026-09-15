// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { D1Database } from "@cloudflare/workers-types";
import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runUpgrade } from "../commands/upgrade";
import { collectMigrationSets } from "./registry";
import { migrateProject, previewReset, readProjectLedger } from "./run";

/**
 * **A migration run for an environment counts and applies that environment's migrations (#595).**
 *
 * `pithy migrate --env staging`, `pithy upgrade --env staging` and the pending count `pithy deploy --env
 * staging` prints all compose each Worker's `pithy.config.ts` to learn its migrations. None of them set
 * `ENVIRONMENT` for that composition, so each answered from a composition built for **no** environment
 * while reporting the one it was asked about.
 *
 * Every fixture is a real project on disk with a real `pithy.config.ts`, because the defect is in *when the
 * config is evaluated* and no seam over the loader can observe that. The config reads `ENVIRONMENT` at
 * module scope, which is where an adopter's `originFor(compositionEnvironment(), DOMAINS)` reads it.
 */
describe("a migration run composes for the environment it was asked about", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-env-composition-"));
    await writeFile(join(dir, "pithy.config.ts"), 'export default { name: "acme", environments: ["staging"] };\n');
    const workerDir = join(dir, "apps", "api");
    await mkdir(workerDir, { recursive: true });
    await writeFile(
      join(workerDir, "wrangler.jsonc"),
      JSON.stringify({
        name: "api",
        d1_databases: [{ binding: "DB", database_id: "DB" }],
        env: { staging: { d1_databases: [{ binding: "DB", database_id: "remote-staging-id" }] } },
      }),
    );
    await writeFile(
      join(workerDir, "pithy.config.ts"),
      [
        'const staging = process.env.ENVIRONMENT === "staging";',
        "const noop = { up: async () => {}, down: async () => {} };",
        "export default {",
        "  capabilities: [",
        "    {",
        '      name: "app",',
        "      requiredBindings: [],",
        "      databases: {",
        "        app: {",
        '          binding: "DB",',
        "          tables: {},",
        "          migrationOrder: 1000,",
        '          migrations: staging ? { "0001_base": noop, "0002_staging": noop } : { "0001_base": noop },',
        "        },",
        "      },",
        "    },",
        "  ],",
        "};",
        "",
      ].join("\n"),
    );
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** An in-memory stand-in for the REST-backed D1 a staging run reaches. */
  async function remote(): Promise<{ d1: D1Database; dispose: () => Promise<void> }> {
    const miniflare = new Miniflare({ modules: true, script: "export default {};", d1Databases: { REMOTE: "r" } });
    return {
      d1: (await miniflare.getD1Database("REMOTE")) as unknown as D1Database,
      dispose: () => miniflare.dispose(),
    };
  }

  test("migrate --env staging applies the staging set", async () => {
    const d1 = await remote();
    try {
      const runs = await migrateProject({
        projectDir: dir,
        env: "staging",
        account: null,
        project: "acme",
        remoteD1: () => d1.d1,
      });
      expect(runs[0]?.databases[0]?.results.map((result) => result.migrationName)).toEqual([
        "1000_app_0001_base",
        "1000_app_0002_staging",
      ]);
    } finally {
      await d1.dispose();
    }
  });

  test("deploy's pending count for staging counts the staging set", async () => {
    const d1 = await remote();
    try {
      // The exact call `pithy deploy`'s `pendingFor` makes, with the network client substituted.
      const ledger = await readProjectLedger({ projectDir: dir, env: "staging", account: null, remoteD1: () => d1.d1 });
      expect(ledger).toEqual({ state: "read", pending: 2, undeclared: [] });
    } finally {
      await d1.dispose();
    }
  });

  test("upgrade --env staging plans against the staging composition", async () => {
    const seen: string[][] = [];
    await runUpgrade({
      projectDir: dir,
      env: "staging",
      account: null,
      dryRun: true,
      migrate: false,
      readManifests: async () => ({ faults: [] }),
      readLedger: async (scope) => {
        seen.push(collectMigrationSets(scope.capabilities).flatMap((set) => Object.keys(set.migrations)));
        return { state: "read", pending: 0, undeclared: [] };
      },
    });
    expect(seen).toEqual([["0001_base", "0002_staging"]]);
  });

  test("a config this process already composed for dev is composed again for staging", async () => {
    // The module cache is keyed on the path, so a second import hands back the first evaluation. One CLI
    // run composing for two environments — `pithy add`'s dev migrate beside a staging count — must not
    // answer the second question with the first composition.
    expect(await previewReset({ projectDir: dir, env: "dev", account: null })).toEqual([
      { database: "app", binding: "DB", migrations: 1 },
    ]);
    expect(await previewReset({ projectDir: dir, env: "staging", account: null })).toEqual([
      { database: "app", binding: "DB", migrations: 2 },
    ]);
  });

  test("leaves ENVIRONMENT exactly as it found it", async () => {
    const before = process.env.ENVIRONMENT;
    await previewReset({ projectDir: dir, env: "staging", account: null });
    expect(process.env.ENVIRONMENT).toBe(before);
    expect(Object.hasOwn(process.env, "ENVIRONMENT")).toBe(before !== undefined);
  });
});
