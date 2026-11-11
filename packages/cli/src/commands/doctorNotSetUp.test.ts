// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { existsSync } from "node:fs";
import { cp, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { localDevStorePath } from "../devSecrets/store";
import { doctorFailures } from "../doctor/failures";
import { migrateProject } from "../migrations/run";
import { scaffoldProject } from "../project/scaffold";
import { checkedWorker, doctorHarness } from "../test-utils/doctorHarness";
import { linkKitPackages } from "../test-utils/linkKit";
import {
  buildDoctorReport,
  type DoctorReportOptions,
  doctorExitCode,
  renderDoctorJson,
  renderDoctorText,
} from "./doctor";

/**
 * **A checkout nothing has set up is not set up, and it does not fail `pithy doctor`.**
 *
 * A fresh clone and a CI runner hold no local D1 store, no `.dev.vars`, no dev secrets and no `dev.json`. Every
 * check of local dev state reads its absence as "not set up" and reports it; only local state that exists and is
 * wrong fails the exit. Every check of committed files runs and gates the same way either way.
 *
 * Every fixture is a real scaffold with the local-state seams left real, and a config directory nothing has
 * written to, so a new check that gates on an absent local state fails the first test here.
 */

const harness = doctorHarness();

const MIGRATION = "{ up: async () => {}, down: async () => {} }";

/**
 * A scaffolded project named apart from its Worker, whose Worker migrates one local database. `migrations` is
 * how many migrations the database declares.
 */
async function clone(migrations = 1, name = "clone"): Promise<string> {
  const projectDir = join(harness.dir, name);
  await scaffoldProject({ targetDir: projectDir, appName: "acme-stats", worker: "api" });
  const workerDir = join(projectDir, "apps", "api");
  const wrangler = join(workerDir, "wrangler.jsonc");
  const text = await readFile(wrangler, "utf8");
  await writeFile(
    wrangler,
    text.replace(
      '"kv_namespaces": [],',
      '"d1_databases": [{ "binding": "DB", "database_name": "acme-stats-dev-db", "database_id": "acme-stats-dev-db" }],\n  "kv_namespaces": [],',
    ),
  );
  const names = Array.from({ length: migrations }, (_, index) => `"000${index + 1}_init": ${MIGRATION}`);
  await writeFile(
    join(workerDir, "pithy.config.ts"),
    [
      "export default {",
      "  capabilities: [",
      `    { name: "stats", requiredBindings: [], databases: { stats: { binding: "DB", tables: {}, migrationOrder: 1000, migrations: { ${names.join(", ")} } } } },`,
      "  ],",
      "};",
      "",
    ].join("\n"),
  );
  return projectDir;
}

/**
 * `projectDir`'s Worker declares `READY_AFTER_MINUTES` with `defineVars`, and its `wrangler.jsonc` carries it at the
 * top level and in `env.staging` but not in `env.prod`: a committed-file fault that fails the exit.
 */
async function dropDeclaredVar(projectDir: string): Promise<void> {
  await linkKitPackages(projectDir, ["core"]);
  const zod = dirname(createRequire(import.meta.url).resolve("zod/package.json"));
  await symlink(await realpath(zod), join(projectDir, "node_modules", "zod"));
  const workerDir = join(projectDir, "apps", "api");
  const config = join(workerDir, "pithy.config.ts");
  await writeFile(
    config,
    [
      'import { defineVars } from "@pithy-sh/core/src/worker/vars";',
      'import { z } from "zod";',
      "",
      "const vars = defineVars({",
      '  READY_AFTER_MINUTES: { description: "Minutes after the cron the next file is ready.", schema: z.number(), default: 15 },',
      "});",
      "",
      (await readFile(config, "utf8")).replace("export default {", "export default {\n  vars,"),
    ].join("\n"),
  );
  const wrangler = join(workerDir, "wrangler.jsonc");
  const text = await readFile(wrangler, "utf8");
  await writeFile(
    wrangler,
    text
      .replace('"ENVIRONMENT": "dev",', '"ENVIRONMENT": "dev",\n    "READY_AFTER_MINUTES": 15,')
      .replace('"ENVIRONMENT": "staging",', '"ENVIRONMENT": "staging",\n        "READY_AFTER_MINUTES": 15,'),
  );
}

/** Doctor over `projectDir` with every local-state seam real, against a config directory nothing wrote. */
function realLocalState(projectDir: string, overrides: Partial<DoctorReportOptions> = {}): DoctorReportOptions {
  return harness.healthyOptions({
    projectDir,
    env: { PITHY_CONFIG_DIR: join(harness.dir, "config") },
    offline: true,
    loadProject: undefined,
    resolveWorkersFor: undefined,
    buildPlan: undefined,
    checkoutSetUp: undefined,
    localStore: undefined,
    checkPortsRegistry: undefined,
    checkProjectName: undefined,
    ...overrides,
  });
}

/** The Worker's `migrations` lines as printed. */
function migrationLines(text: string): string[] {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.startsWith("    migrations"));
  if (start === -1) throw new Error(`no migrations line in:\n${text}`);
  const end = lines.findIndex((line, index) => index > start && /^ {4}\S/.test(line));
  return lines.slice(start, end === -1 ? undefined : end);
}

describe("pithy doctor on a checkout nothing has set up", () => {
  test("exits 0, says dev is not set up with pithy setup as the fix, and fails nothing", async () => {
    const projectDir = await clone();
    const report = await buildDoctorReport(realLocalState(projectDir));

    expect(doctorFailures(report)).toEqual([]);
    expect(doctorExitCode(report)).toBe(0);
    expect(checkedWorker(report.project?.health).migrations.environments[0]).toEqual({
      env: "dev",
      state: "not-set-up",
    });
    expect(migrationLines(renderDoctorText(report, "/home/u"))[0]).toBe(
      "    migrations   dev: not set up — run: pithy setup",
    );
  });

  test("--json carries not-set-up as dev's state, with its fix, and no failure for it", async () => {
    const report = await buildDoctorReport(realLocalState(await clone()));
    const payload = renderDoctorJson(report) as {
      failures: unknown[];
      project: { health: { workers: { migrations: { ok: boolean; environments: Record<string, unknown>[] } }[] } };
    };
    expect(payload.failures).toEqual([]);
    expect(payload.project.health.workers[0]?.migrations.ok).toBe(true);
    expect(payload.project.health.workers[0]?.migrations.environments[0]).toEqual({
      env: "dev",
      state: "not-set-up",
      fix: "pithy setup",
    });
  });

  test("a stanza missing a declared var still fails the exit, while dev stays not set up", async () => {
    const projectDir = await clone();
    await dropDeclaredVar(projectDir);
    const report = await buildDoctorReport(realLocalState(projectDir));

    expect(checkedWorker(report.project?.health).migrations.environments[0]).toEqual({
      env: "dev",
      state: "not-set-up",
    });
    expect(report.varStanzas?.findings).toEqual([
      {
        worker: "api",
        kind: "missing",
        stanza: "env.prod",
        name: "READY_AFTER_MINUTES",
        declared: true,
        line: '"READY_AFTER_MINUTES": 15',
      },
    ]);
    expect(doctorFailures(report).map((failure) => failure.check)).toEqual(["varStanzas"]);
    expect(doctorExitCode(report)).toBe(1);
  });

  test("creates no local store, so the next run answers the same", async () => {
    const projectDir = await clone();
    await buildDoctorReport(realLocalState(projectDir));
    expect(existsSync(join(projectDir, ".wrangler"))).toBe(false);
    expect(doctorExitCode(await buildDoctorReport(realLocalState(projectDir)))).toBe(0);
  });
});

describe("pithy doctor on a checkout whose local store exists", () => {
  test("one migration behind fails with the pending count and its fix", async () => {
    // Migrated where it declared one migration, then carried to a checkout that declares two.
    const migrated = await clone(1, "migrated");
    await migrateProject({ projectDir: migrated, env: "dev", account: null, project: "acme-stats" });
    const projectDir = await clone(2);
    await cp(join(migrated, ".wrangler"), join(projectDir, ".wrangler"), { recursive: true });

    const report = await buildDoctorReport(realLocalState(projectDir));
    expect(doctorExitCode(report)).toBe(1);
    expect(doctorFailures(report)).toEqual([
      { check: "project", detail: "acme-stats-api: 1 pending in dev.", fix: "pithy setup" },
    ]);
    expect(migrationLines(renderDoctorText(report, "/home/u"))[0]).toBe(
      "    migrations   dev: 1 pending — run: pithy setup",
    );
  });

  test("an empty store directory is a store: its pending count fails", async () => {
    const projectDir = await clone();
    await mkdir(localDevStorePath(projectDir), { recursive: true });
    const report = await buildDoctorReport(realLocalState(projectDir));
    expect(doctorFailures(report).map((failure) => failure.detail)).toEqual(["acme-stats-api: 1 pending in dev."]);
  });
});
