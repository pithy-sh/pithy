// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ReconcileApplied, ReconcilePlan } from "../capabilities/reconcile";
import { scaffoldProject } from "../project/scaffold";
import upgrade, { __test, runUpgrade, type UpgradeWorker } from "./upgrade";

interface ArgSpec {
  type: string;
  default?: unknown;
}

describe("upgrade command", () => {
  test("meta and args match the CLI surface", () => {
    expect(upgrade.meta).toMatchObject({ name: "upgrade" });
    const args = upgrade.args as Record<string, ArgSpec>;
    expect(Object.keys(args)).toEqual(["env", "worker", "dry-run", "migrate", "json"]);
    expect(args.env).toMatchObject({ type: "string", default: "dev" });
    expect(args.worker).toMatchObject({ type: "string" });
    expect(args["dry-run"]).toMatchObject({ type: "boolean", default: false });
    expect(args.migrate).toMatchObject({ type: "boolean", default: false });
    expect(args.json).toMatchObject({ type: "boolean", default: false });
  });
});

const plan: ReconcilePlan = {
  worker: "api",
  deployedAs: "acme-api",
  env: "dev",
  perCapability: [
    {
      name: "auth",
      missingBindings: [{ env: "dev", name: "DB", type: "d1" }],
      missingConfigKeys: [{ key: "basePath", default: "/auth", describe: "x" }],
    },
    { name: "quiet", missingBindings: [], missingConfigKeys: [] },
  ],
  ejectedSkipped: ["billing"],
  pendingMigrations: 3,
  entitlementGap: [],
  missingVersionMetadata: false,
};

describe("plan rendering", () => {
  test("one line per changed capability, ejected by name, pending migrations noted", () => {
    const lines = __test.planLines(plan);
    expect(lines).toContain("auth: add 1 binding, 1 config key.");
    expect(lines).toContain("billing: ejected. Skipped.");
    expect(lines).toContain("3 migrations pending. Run pithy upgrade --migrate, or pithy migrate --env dev.");
    // A capability with no drift produces no line.
    expect(lines.some((line) => line.startsWith("quiet:"))).toBe(false);
  });

  test("a clean worker says nothing to upgrade", () => {
    const clean: ReconcilePlan = {
      worker: "api",
      deployedAs: "acme-api",
      env: "dev",
      perCapability: [],
      ejectedSkipped: [],
      pendingMigrations: 0,
      entitlementGap: [],
      missingVersionMetadata: false,
    };
    expect(__test.planLines(clean)).toEqual(["Nothing to upgrade."]);
  });
});

describe("applied rendering", () => {
  test("reports what was added and notes still-pending migrations when not migrated", () => {
    const applied: ReconcileApplied = {
      worker: "api",
      perCapability: [
        { name: "auth", addedBindings: [{ env: "dev", name: "DB", type: "d1" }], addedConfigKeys: ["basePath"] },
      ],
      ejectedSkipped: ["billing"],
      migrated: false,
      migrations: [],
      addedVersionMetadata: false,
    };
    const lines = __test.appliedLines(applied, plan);
    expect(lines).toContain("auth: added 1 binding, 1 config key.");
    expect(lines).toContain("billing: ejected. Skipped.");
    expect(lines).toContain("3 migrations pending. Run pithy upgrade --migrate, or pithy migrate --env dev.");
  });

  test("reports a completed migration run instead of a pending note", () => {
    const applied: ReconcileApplied = {
      worker: "api",
      perCapability: [],
      ejectedSkipped: [],
      migrated: true,
      migrations: [
        {
          database: "app",
          binding: "DB",
          results: [{ migrationName: "auth_0001", direction: "Up", status: "Success" }],
        },
      ],
      addedVersionMetadata: false,
    };
    const lines = __test.appliedLines(applied, plan);
    expect(lines).toContain("Migrated 1 migration.");
    expect(lines.some((line) => line.includes("pending"))).toBe(false);
  });
});

describe("worker grouping", () => {
  test("every worker gets a labelled block, its lines indented beneath", () => {
    const collab: ReconcilePlan = {
      worker: "collab",
      deployedAs: "acme-collab",
      env: "dev",
      perCapability: [],
      ejectedSkipped: [],
      pendingMigrations: 0,
      entitlementGap: [],
      missingVersionMetadata: false,
    };
    const out = __test.renderUpgrade({
      workers: [
        { plan, applied: null },
        { plan: collab, applied: null },
      ],
      manifestFaults: [],
    });
    expect(out).toEqual([
      "api:",
      "  auth: add 1 binding, 1 config key.",
      "  billing: ejected. Skipped.",
      "  3 migrations pending. Run pithy upgrade --migrate, or pithy migrate --env dev.",
      "collab:",
      "  Nothing to upgrade.",
    ]);
  });

  test("an applied run renders the applied lines, not the plan's", () => {
    const applied: ReconcileApplied = {
      worker: "api",
      perCapability: [{ name: "auth", addedBindings: [], addedConfigKeys: ["basePath"] }],
      ejectedSkipped: [],
      migrated: false,
      migrations: [],
      addedVersionMetadata: false,
    };
    expect(__test.renderUpgrade({ workers: [{ plan, applied }], manifestFaults: [] })).toContain(
      "  auth: added 1 config key.",
    );
  });

  test("a worker with nothing to do still appears — silence would read as skipped", () => {
    const clean: ReconcilePlan = {
      worker: "web",
      deployedAs: "acme-web",
      env: "dev",
      perCapability: [],
      ejectedSkipped: [],
      pendingMigrations: 0,
      entitlementGap: [],
      missingVersionMetadata: false,
    };
    expect(__test.renderUpgrade({ workers: [{ plan: clean, applied: null }], manifestFaults: [] })).toEqual([
      "web:",
      "  Nothing to upgrade.",
    ]);
  });
});

/**
 * The fan-out, against a real two-Worker project on disk. Only the Worker resolver and the migration count
 * are stubbed — the wiring `runUpgrade` reads and writes is the actual `apps/<name>/` files, so a plan that
 * crossed Worker boundaries would show up here.
 */
describe("runUpgrade — fan-out over apps/", () => {
  let dir: string;
  let apiDir: string;
  let collabDir: string;

  /** A capability as a Worker's `pithy.config.ts` composes it — the scope of that Worker's plan. */
  const composes = (...names: string[]): Capability[] => names.map((name) => ({ name, requiredBindings: [] }));

  /** Both Workers, in discovery order, as the resolver seam returns them. Both compose auth. */
  const workers = (): UpgradeWorker[] => [
    { name: "api", dir: apiDir, capabilities: composes("auth") },
    { name: "collab", dir: collabDir, capabilities: composes("auth") },
  ];

  /** Resolve the fixture Workers without importing a `pithy.config.ts`, honouring `--worker`. */
  async function resolve({ worker }: { projectDir: string; worker?: string }): Promise<UpgradeWorker[]> {
    const all = workers();
    return worker === undefined ? all : all.filter((candidate) => candidate.name === worker);
  }

  /** The same two Workers, but `collab` composes nothing — auth is installed at the root for `api` alone. */
  async function resolveApiOnlyComposesAuth(): Promise<UpgradeWorker[]> {
    return [
      { name: "api", dir: apiDir, capabilities: composes("auth") },
      { name: "collab", dir: collabDir, capabilities: [] },
    ];
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-upgrade-"));
    await scaffoldProject({ targetDir: dir, appName: "upgrade-test" });
    apiDir = join(dir, "apps", "api");
    collabDir = join(dir, "apps", "collab");
    await cp(apiDir, collabDir, { recursive: true });

    const pkgDir = join(dir, "node_modules", "@pithy-sh", "auth");
    await mkdir(pkgDir, { recursive: true });
    await writeFile(
      join(pkgDir, "pithy.manifest.json"),
      JSON.stringify({
        name: "auth",
        package: "@pithy-sh/auth",
        requiredBindings: [{ type: "d1", name: "DB" }],
        configOptions: [{ key: "basePath", default: "/auth", describe: "Where the auth routes mount." }],
      }),
    );
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const base = { env: "dev", dryRun: true, migrate: false, countPending: async () => 0 } as const;

  test("plans every worker, one entry each, in discovery order", async () => {
    const { workers: results } = await runUpgrade({ ...base, projectDir: dir, resolveWorkers: resolve });
    expect(results.map((result) => result.plan.worker)).toEqual(["api", "collab"]);
    for (const { plan, applied } of results) {
      expect(applied).toBeNull(); // dry run writes nothing
      expect(plan.perCapability.find((cap) => cap.name === "auth")?.missingBindings).toHaveLength(3);
    }
  });

  test("--worker narrows the fan-out to one worker", async () => {
    const { workers: results } = await runUpgrade({
      ...base,
      projectDir: dir,
      worker: "collab",
      resolveWorkers: resolve,
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.plan.worker).toBe("collab");
  });

  test("drift in one worker only is reported against that worker alone", async () => {
    // Wire DB into every one of api's stanzas; collab keeps the empty arrays.
    const raw = await readFile(join(apiDir, "wrangler.jsonc"), "utf8");
    await writeFile(
      join(apiDir, "wrangler.jsonc"),
      raw.replaceAll('"d1_databases": [],', '"d1_databases": [{ "binding": "DB" }],'),
    );

    const { workers: results } = await runUpgrade({ ...base, projectDir: dir, resolveWorkers: resolve });
    const byWorker = new Map(results.map((result) => [result.plan.worker, result.plan]));
    expect(byWorker.get("api")?.perCapability.find((cap) => cap.name === "auth")?.missingBindings).toEqual([]);
    expect(byWorker.get("collab")?.perCapability.find((cap) => cap.name === "auth")?.missingBindings).toHaveLength(3);
  });

  test("applying writes each worker's own wiring, and re-running finds nothing left", async () => {
    const applyOptions = { ...base, dryRun: false, projectDir: dir, resolveWorkers: resolve };
    const applied = await runUpgrade(applyOptions);
    expect(applied.workers.map((result) => result.applied?.worker)).toEqual(["api", "collab"]);

    for (const workerDir of [apiDir, collabDir]) {
      const wrangler = await readFile(join(workerDir, "wrangler.jsonc"), "utf8");
      expect(wrangler).toContain('"binding": "DB"');
    }

    const second = await runUpgrade(applyOptions);
    for (const { applied: result } of second.workers) expect(result?.perCapability).toEqual([]);
  });

  test("never writes a capability another worker composes into a worker that does not (regression)", async () => {
    // auth is installed once at the project root and wired into api alone. collab composes nothing, so it
    // must plan nothing and keep its wrangler.jsonc byte-identical — foreign bindings on a script that never
    // declared them are exactly what `pithy add --worker` exists to prevent.
    const before = await readFile(join(collabDir, "wrangler.jsonc"), "utf8");

    const { workers: results } = await runUpgrade({
      ...base,
      dryRun: false,
      projectDir: dir,
      resolveWorkers: resolveApiOnlyComposesAuth,
    });

    const byWorker = new Map(results.map((result) => [result.plan.worker, result]));
    expect(byWorker.get("collab")?.plan.perCapability).toEqual([]);
    expect(byWorker.get("collab")?.applied?.perCapability).toEqual([]);
    expect(await readFile(join(collabDir, "wrangler.jsonc"), "utf8")).toBe(before);

    // api, which does compose auth, is still reconciled.
    expect(byWorker.get("api")?.applied?.perCapability.map((cap) => cap.name)).toEqual(["auth"]);
    expect(await readFile(join(apiDir, "wrangler.jsonc"), "utf8")).toContain('"binding": "DB"');
  });

  test("proposes the same project-scoped database name pithy add would have written", async () => {
    // The two routes into a project must agree. `pithy add` names the D1 it proposes
    // `<project>-<env>-<binding>`; if `upgrade` wired the same capability with a bare binding, whichever
    // command an adopter happened to run would decide whether their database carried the project segment
    // — and an unscoped name is the one a second Pithy project in the account silently adopts.
    await runUpgrade({ ...base, dryRun: false, projectDir: dir, worker: "api", resolveWorkers: resolve });

    const wrangler = await readFile(join(apiDir, "wrangler.jsonc"), "utf8");
    expect(wrangler).toContain('"database_name": "upgrade-test-dev-db"');
    expect(wrangler).toContain('"database_name": "upgrade-test-prod-db"');
  });

  test("--worker leaves the other worker's files untouched", async () => {
    const before = await readFile(join(collabDir, "wrangler.jsonc"), "utf8");
    await runUpgrade({ ...base, dryRun: false, projectDir: dir, worker: "api", resolveWorkers: resolve });
    expect(await readFile(join(collabDir, "wrangler.jsonc"), "utf8")).toBe(before);
    expect(await readFile(join(apiDir, "wrangler.jsonc"), "utf8")).not.toBe(before);
  });

  test("--migrate runs migrations once per worker, scoped to that worker's directory", async () => {
    const seen: { worker: string; workerDir: string }[] = [];
    await runUpgrade({
      ...base,
      dryRun: false,
      migrate: true,
      projectDir: dir,
      resolveWorkers: resolve,
      runMigrate: async ({ worker, workerDir }) => {
        seen.push({ worker, workerDir });
        return [];
      },
    });
    expect(seen).toEqual([
      { worker: "api", workerDir: apiDir },
      { worker: "collab", workerDir: collabDir },
    ]);
  });
});

/**
 * The warning `pithy upgrade` did not print.
 *
 * A manifest the schema refuses makes its capability vanish from every plan, so the run reconciles
 * happily around the hole and reports nothing at all (#184). The lines sit above the Workers because the
 * fault belongs to none of them — manifests install once, under the project root.
 */
describe("manifest faults", () => {
  const fault = { package: "@pithy-sh/audit", reason: "configOptions[0].key — not a bare identifier" };

  test("a broken manifest is named, with its reason, above the workers", () => {
    const clean: ReconcilePlan = {
      worker: "api",
      deployedAs: "acme-api",
      env: "dev",
      perCapability: [],
      ejectedSkipped: [],
      pendingMigrations: 0,
      entitlementGap: [],
      missingVersionMetadata: false,
    };
    expect(__test.renderUpgrade({ workers: [{ plan: clean, applied: null }], manifestFaults: [fault] })).toEqual([
      "@pithy-sh/audit: malformed pithy.manifest.json. Not reconciled.",
      "  configOptions[0].key — not a bare identifier",
      "api:",
      "  Nothing to upgrade.",
    ]);
  });

  test("a healthy install adds no lines at all", () => {
    const clean: ReconcilePlan = {
      worker: "api",
      deployedAs: "acme-api",
      env: "dev",
      perCapability: [],
      ejectedSkipped: [],
      pendingMigrations: 0,
      entitlementGap: [],
      missingVersionMetadata: false,
    };
    expect(__test.renderUpgrade({ workers: [{ plan: clean, applied: null }], manifestFaults: [] })).toEqual([
      "api:",
      "  Nothing to upgrade.",
    ]);
  });
});
