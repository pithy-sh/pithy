// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { D1Database } from "@cloudflare/workers-types";
import { Miniflare } from "miniflare";
import { describe, expect, test } from "vitest";
import type { MigrationScope } from "../capabilities/reconcile";
import {
  buildDoctorReport,
  type DoctorReportOptions,
  doctorExitCode,
  renderDoctorJson,
  renderDoctorText,
} from "../commands/doctor";
import { collectMigrationSets } from "../migrations/registry";
import { NeighborsNotComposed, type ProjectLedger, readProjectLedger, unprovisionedDatabases } from "../migrations/run";
import { checkedWorker, doctorHarness } from "../test-utils/doctorHarness";
import { environmentMigrations } from "./environmentMigrations";
import type { ProjectHealth } from "./health";

/**
 * **No per-environment migration answer is taken from another environment (#586).**
 *
 * `pithy doctor` printed `2 pending — run: pithy migrate --env dev` whatever it was asked, and the count
 * under a prod heading was dev's: prod had no database to have anything pending against. Doctor has no
 * `--env`, and citty accepted one silently. It now reports every environment the project has — `dev`,
 * and each one the root `pithy.config.ts` declares — each composed for itself and read for itself.
 *
 * Every fixture here is a real project on disk with a real `pithy.config.ts` that reads `ENVIRONMENT` at
 * module scope, because the defect is in *which composition answered*, and a seam over the loader cannot
 * observe that. The config names each migration after the environment it was evaluated under, so a count
 * or a read taken from the wrong composition is visible in what the ledger seam was handed.
 *
 * ## What this sees, and what it does not
 *
 * It holds the migrations check end to end, over two Workers: which reads were taken, for which Worker,
 * environment and composition; the answers on the report; the answers `--json` carries; and the exact lines
 * printed. Planted and turned red: a composition for `dev` reused for every environment, a read handed the
 * wrong environment, the renderer borrowing `dev`'s sentence for an environment that did not compose, the
 * health builder borrowing the previous environment's answer for one that is not provisioned, doctor
 * composing each environment from its one environment-less resolution, the `--json` renderer re-deriving an
 * entry from `dev`'s, an ignored offline decision, and every Worker composed from the first one's directory.
 *
 * What it does not see, said plainly:
 *
 * - **Only the migrations check.** Doctor's other per-environment answers — `Secret bindings:`,
 *   `Environment configs:` — come from `capabilities/secretApplicability.ts` and are held by its suites. A
 *   new per-environment check is held by nothing here until it is added here.
 * - **A module the config imports.** `composeFor` re-evaluates `pithy.config.ts` alone, so an environment
 *   read at the top of a module it imports keeps its first answer. That is the primitive's stated limit, and
 *   every fixture here reads the environment in the config itself.
 * - **A resolver that ignores the Worker it is narrowed to.** Doctor picks the composed Worker by directory
 *   and refuses when none matches; a resolver handing back a different Worker at the same directory is not
 *   a state discovery can produce, and nothing here stages it.
 */

const harness = doctorHarness();

/**
 * One read the report took: the Worker, the environment it asked for, and the environment its composition
 * was evaluated under.
 */
interface Read {
  worker: string;
  env: string;
  composedFor: string;
}

/** A ledger seam that records each read and answers with how many migrations the composition declares. */
function recordingLedger(reads: Read[]): (scope: MigrationScope) => Promise<ProjectLedger> {
  return async (scope) => {
    const names = collectMigrationSets(scope.capabilities).flatMap((set) => Object.keys(set.migrations));
    const composedFor = [...new Set(names.map((name) => name.split(":")[1] ?? "none"))].join(",");
    reads.push({ worker: scope.worker, env: scope.env, composedFor });
    return { state: "read", pending: names.length, undeclared: [] };
  };
}

/**
 * A project declaring three environments, with two Workers that answer them differently.
 *
 * `api`: `dev` composes one migration, `staging` two and is provisioned, `prod` composes and is not
 * provisioned, `qa` is provisioned and throws when composed. `web`: three migrations in every environment,
 * all of them provisioned — so an answer borrowed from the other Worker, or from `api`'s refusal in `qa`,
 * is a different number.
 */
async function project(dir: string): Promise<void> {
  await writeFile(
    join(dir, "pithy.config.ts"),
    'export default { name: "acme", environments: ["staging", "prod", "qa"] };\n',
  );
  const workerDir = join(dir, "apps", "api");
  await mkdir(workerDir, { recursive: true });
  await writeFile(
    join(workerDir, "wrangler.jsonc"),
    JSON.stringify({
      name: "api",
      d1_databases: [{ binding: "DB", database_id: "DB" }],
      env: {
        staging: { d1_databases: [{ binding: "DB", database_id: "remote-staging-id" }] },
        prod: { d1_databases: [{ binding: "DB", database_name: "acme-prod-db" }] },
        qa: { d1_databases: [{ binding: "DB", database_id: "remote-qa-id" }] },
      },
    }),
  );
  await writeFile(
    join(workerDir, "pithy.config.ts"),
    [
      'const environment = process.env.ENVIRONMENT ?? "none";',
      'if (environment === "qa") throw new Error("qa is not configured yet.");',
      "const noop = { up: async () => {}, down: async () => {} };",
      'const migrations = { [["0001", environment].join(":")]: noop };',
      'if (environment === "staging") migrations[["0002", environment].join(":")] = noop;',
      "export default {",
      "  capabilities: [",
      '    { name: "app", requiredBindings: [], databases: { app: { binding: "DB", tables: {}, migrationOrder: 1000, migrations } } },',
      "  ],",
      "};",
      "",
    ].join("\n"),
  );

  const webDir = join(dir, "apps", "web");
  await mkdir(webDir, { recursive: true });
  const provisioned = (env: string) => ({ d1_databases: [{ binding: "WEB_DB", database_id: `web-${env}-id` }] });
  await writeFile(
    join(webDir, "wrangler.jsonc"),
    JSON.stringify({
      name: "web",
      d1_databases: [{ binding: "WEB_DB", database_id: "WEB_DB" }],
      env: { staging: provisioned("staging"), prod: provisioned("prod"), qa: provisioned("qa") },
    }),
  );
  await writeFile(
    join(webDir, "pithy.config.ts"),
    [
      'const environment = process.env.ENVIRONMENT ?? "none";',
      "const noop = { up: async () => {}, down: async () => {} };",
      'const migrations = Object.fromEntries(["w1", "w2", "w3"].map((key) => [[key, environment].join(":"), noop]));',
      "export default {",
      "  capabilities: [",
      '    { name: "site", requiredBindings: [], databases: { site: { binding: "WEB_DB", tables: {}, migrationOrder: 1000, migrations } } },',
      "  ],",
      "};",
      "",
    ].join("\n"),
  );
}

/** The report over the fixture, with the real resolver and the real per-environment composition. */
function options(reads: Read[], overrides: Partial<DoctorReportOptions> = {}): DoctorReportOptions {
  return harness.baseOptions({
    projectDir: harness.dir,
    loadProject: undefined,
    resolveWorkers: undefined,
    readLedger: recordingLedger(reads),
    // Probes this suite is not about, each of which would compose the fixture again for its own reasons.
    checkDevSecrets: async () => null,
    checkSecretBindings: async () => null,
    checkEnvironmentConfigs: async () => ({ unresolved: [] }),
    checkSettings: async () => null,
    checkLocalDelivery: async () => null,
    checkDevVars: async () => null,
    checkDevVarsLocal: async () => null,
    checkDevSecretsFile: async () => null,
    ...overrides,
  });
}

/** The Worker's `migrations` lines, exactly as printed. */
function migrationLines(text: string): string[] {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.startsWith("    migrations"));
  if (start === -1) throw new Error(`no migrations line in:\n${text}`);
  const end = lines.findIndex((line, index) => index > start && /^ {4}\S/.test(line));
  return lines.slice(start, end === -1 ? undefined : end);
}

describe("doctor reports each environment's migrations from that environment", () => {
  test("every environment is read for itself, from a composition for itself, and printed under its own name", async () => {
    await project(harness.dir);
    const reads: Read[] = [];
    const report = await buildDoctorReport(options(reads));

    // The reads that were taken: one per Worker per environment that could be read, each for the
    // environment it reports and from that Worker's composition for it. api's prod has nothing to read and
    // its qa did not compose; web's qa did, and is read for itself.
    expect(reads).toEqual([
      { worker: "api", env: "dev", composedFor: "dev" },
      { worker: "api", env: "staging", composedFor: "staging" },
      { worker: "web", env: "dev", composedFor: "dev" },
      { worker: "web", env: "staging", composedFor: "staging" },
      { worker: "web", env: "prod", composedFor: "prod" },
      { worker: "web", env: "qa", composedFor: "qa" },
    ]);

    const three = { state: "read", pending: 3, undeclared: [] } as const;
    expect(checkedWorker(report.project?.health, 1).migrations.environments).toEqual([
      { env: "dev", state: "checked", ledger: three },
      { env: "staging", state: "checked", ledger: three },
      { env: "prod", state: "checked", ledger: three },
      { env: "qa", state: "checked", ledger: three },
    ]);

    const environments = checkedWorker(report.project?.health).migrations.environments;
    expect(environments.map((entry) => entry.env)).toEqual(["dev", "staging", "prod", "qa"]);
    expect(environments).toEqual([
      { env: "dev", state: "checked", ledger: { state: "read", pending: 1, undeclared: [] } },
      { env: "staging", state: "checked", ledger: { state: "read", pending: 2, undeclared: [] } },
      { env: "prod", state: "not-provisioned", unprovisioned: [{ database: "app", binding: "DB" }] },
      { env: "qa", state: "not-composed" },
    ]);
    // The same answers are what `--json` carries: no second rendering of them substitutes one for another.
    expect(
      (renderDoctorJson(report).project as { health: ProjectHealth }).health.workers.map((worker) =>
        worker.state === "checked" ? worker.migrations : null,
      ),
    ).toEqual([
      {
        ok: false,
        environments: [
          { env: "dev", state: "checked", ledger: { state: "read", pending: 1, undeclared: [] } },
          { env: "staging", state: "checked", ledger: { state: "read", pending: 2, undeclared: [] } },
          { env: "prod", state: "not-provisioned", unprovisioned: [{ database: "app", binding: "DB" }] },
          { env: "qa", state: "not-composed" },
        ],
      },
      {
        ok: false,
        environments: ["dev", "staging", "prod", "qa"].map((env) => ({ env, state: "checked", ledger: three })),
      },
    ]);

    const lines = migrationLines(renderDoctorText(report, "/home/u"));
    expect(lines).toEqual([
      "    migrations   dev: 1 pending — run: pithy migrate --env dev",
      "                 staging: 2 pending — run: pithy migrate --env staging",
      "                 prod: DB (app) not provisioned — run: pithy provision --env prod",
      "                 qa: couldn't be checked — pithy.config.ts does not compose for qa",
    ]);
    // Stated as the rule, over whatever lines there are: a command on an environment's line names that
    // environment and no other.
    for (const line of lines) {
      const env = line
        .trim()
        .replace(/^migrations\s+/, "")
        .split(":")[0];
      for (const named of line.matchAll(/--env (\S+)/g)) expect(named[1], line).toBe(env);
    }
  });

  test("a deployed environment's migrations are reported, and dev's alone fail the exit", async () => {
    await project(harness.dir);
    // dev level, staging behind: the exit stays green on a deployed environment's state.
    const report = await buildDoctorReport(
      options([], {
        readLedger: async (scope) => ({ state: "read", pending: scope.env === "dev" ? 0 : 3, undeclared: [] }),
      }),
    );
    expect(migrationLines(renderDoctorText(report, "/home/u")).slice(0, 2)).toEqual([
      "    migrations   dev: none pending, none undeclared ✓",
      "                 staging: 3 pending — run: pithy migrate --env staging",
    ]);
    expect(checkedWorker(report.project?.health).migrations.ok).toBe(true);
    expect(doctorExitCode(report)).toBe(0);
  });

  test("offline, a deployed read is skipped with a line saying so, and provisioning is still read from files", async () => {
    await project(harness.dir);
    const reads: Read[] = [];
    const report = await buildDoctorReport(options(reads, { offline: true }));
    expect(reads.map((read) => `${read.worker} ${read.env}`)).toEqual(["api dev", "web dev"]);
    expect(migrationLines(renderDoctorText(report, "/home/u"))).toEqual([
      "    migrations   dev: 1 pending — run: pithy migrate --env dev",
      "                 staging: skipped — offline, so no database was read",
      "                 prod: DB (app) not provisioned — run: pithy provision --env prod",
      "                 qa: couldn't be checked — pithy.config.ts does not compose for qa",
    ]);
  });

  test("with no Cloudflare credentials, a deployed read is skipped with a line saying so", async () => {
    await project(harness.dir);
    const reads: Read[] = [];
    const report = await buildDoctorReport(
      options(reads, {
        checkCloudflare: async () => ({
          state: "unconfigured" as const,
          missing: ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"],
          tokenStatus: null,
          credentialSplit: null,
        }),
      }),
    );
    expect(reads.map((read) => `${read.worker} ${read.env}`)).toEqual(["api dev", "web dev"]);
    expect(migrationLines(renderDoctorText(report, "/home/u"))[1]).toBe(
      "                 staging: skipped — no Cloudflare credentials, so no database was read",
    );
  });
});

/**
 * **A database shared with a Worker that does not compose for the environment is not read as if it were
 * not shared (#586).**
 *
 * Doctor reads one Worker's ledger, and the rest of the project is discovered beside it, because a shared
 * D1's ledger holds every Worker's migrations. That discovery swallowed any failure into "no neighbors", so
 * one Worker whose config throws for staging — the dashboard's prod shape — emptied the whole set. A
 * database `a` shares with the healthy `b` was then grouped with `a`'s migrations alone, `b`'s applied row
 * read as undeclared, and doctor printed `delete its row from pithy_migrations` under staging's name.
 */
describe("a Worker beside one that does not compose for the environment", () => {
  const noop = "{ up: async () => {}, down: async () => {} }";

  /** Worker `name`, binding `DB` to `staging` in staging, migrating one database; `throws` for staging. */
  async function worker(name: string, order: number, staging: string, throws = false): Promise<string> {
    const workerDir = join(harness.dir, "apps", name);
    await mkdir(workerDir, { recursive: true });
    await writeFile(
      join(workerDir, "wrangler.jsonc"),
      JSON.stringify({
        name,
        d1_databases: [{ binding: "DB", database_id: "DB" }],
        env: { staging: { d1_databases: [{ binding: "DB", database_id: staging }] } },
      }),
    );
    await writeFile(
      join(workerDir, "pithy.config.ts"),
      [
        throws ? 'if (process.env.ENVIRONMENT === "staging") throw new Error("staging is not configured.");' : "",
        "export default {",
        "  capabilities: [",
        `    { name: "${name}", requiredBindings: [], databases: { ${name}: { binding: "DB", tables: {}, migrationOrder: ${order}, migrations: { "0001_init": ${noop} } } } },`,
        "  ],",
        "};",
        "",
      ].join("\n"),
    );
    return workerDir;
  }

  test("is not answered from the Workers that did compose, and doctor says it could not be checked", async () => {
    await writeFile(
      join(harness.dir, "pithy.config.ts"),
      'export default { name: "acme", environments: ["staging"] };\n',
    );
    const a = await worker("a", 1000, "shared-staging");
    await worker("b", 1100, "shared-staging");
    await worker("c", 1200, "c-staging", true);

    const miniflare = new Miniflare({ modules: true, script: "export default {};", d1Databases: { REMOTE: "r" } });
    try {
      const d1 = (await miniflare.getD1Database("REMOTE")) as unknown as D1Database;
      // The shared database, as a healthy staging holds it: both Workers' first migration applied.
      await d1.exec(
        "CREATE TABLE pithy_migrations (name varchar(255) not null primary key, timestamp varchar(255) not null)",
      );
      await d1.exec("INSERT INTO pithy_migrations VALUES ('1000_a_0001_init', 't'), ('1100_b_0001_init', 't')");

      // Doctor's own ledger read — one Worker handed over, the rest discovered — with the REST client swapped.
      const answer = await environmentMigrations({
        projectDir: harness.dir,
        worker: { name: "a", dir: a },
        env: "staging",
        account: null,
        remoteSkip: null,
        readLedger: (scope) =>
          readProjectLedger({
            projectDir: scope.projectDir,
            env: scope.env,
            account: scope.account,
            workers: [{ name: scope.worker, dir: scope.workerDir, capabilities: scope.capabilities }],
            remoteD1: () => d1,
          }),
      });
      expect(answer).toEqual({ env: "staging", state: "not-composed" });
      // The refusal is the fan-out's, so every caller handing over a narrowed set meets it — `pithy add`,
      // `remove` and `upgrade --migrate` included — and not doctor's alone.
      await expect(
        readProjectLedger({
          projectDir: harness.dir,
          env: "staging",
          account: null,
          workers: [{ name: "a", dir: a, capabilities: [] }],
          remoteD1: () => d1,
        }),
      ).rejects.toBeInstanceOf(NeighborsNotComposed);
    } finally {
      await miniflare.dispose();
    }
  });
});

describe("unprovisionedDatabases", () => {
  const noop = { up: async () => {}, down: async () => {} };
  const migrating = [
    {
      name: "app",
      requiredBindings: [],
      databases: { app: { binding: "DB", tables: {}, migrationOrder: 1000, migrations: { "0001_init": noop } } },
    },
  ];

  test("a scaffold placeholder, a missing id and a missing stanza are unprovisioned; dev never is", async () => {
    const workerDir = join(harness.dir, "api");
    await mkdir(workerDir, { recursive: true });
    await writeFile(
      join(workerDir, "wrangler.jsonc"),
      JSON.stringify({
        d1_databases: [{ binding: "DB" }],
        env: {
          staging: { d1_databases: [{ binding: "DB", database_id: "<database_id>" }] },
          prod: { d1_databases: [{ binding: "DB" }] },
          live: { d1_databases: [{ binding: "DB", database_id: "acme-live-db-id" }] },
        },
      }),
    );
    const workers = [{ name: "api", dir: workerDir, capabilities: migrating }];
    const db = [{ binding: "DB", database: "app" }];
    expect(await unprovisionedDatabases("staging", workers)).toEqual(db);
    expect(await unprovisionedDatabases("prod", workers)).toEqual(db);
    expect(await unprovisionedDatabases("qa", workers)).toEqual(db);
    expect(await unprovisionedDatabases("live", workers)).toEqual([]);
    expect(await unprovisionedDatabases("dev", workers)).toEqual([]);
    // A Worker that migrates nothing has nothing to provision for it.
    expect(await unprovisionedDatabases("prod", [{ name: "api", dir: workerDir, capabilities: [] }])).toEqual([]);
  });
});
