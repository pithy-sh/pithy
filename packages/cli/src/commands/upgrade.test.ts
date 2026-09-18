// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { declineRefusal, type ReconcileApplied, type ReconcilePlan } from "../capabilities/reconcile";
import { declaredSpecs } from "../kitPackages/ranges";
import type { RegistryFetch } from "../kitPackages/registry";
import { scaffoldProject } from "../project/scaffold";
import { doctorHarness } from "../test-utils/doctorHarness";
import { fakeInstall, fakePackument, fakeRegistry } from "../test-utils/fakeInstall";
import { templateTarball } from "../test-utils/templateTarball";
import { readManifestDocument, writeManifestDocument } from "../ui/workerUi";
import { buildDoctorReport, installedCapabilityVersions, renderDoctorText } from "./doctor";
import upgrade, {
  __test,
  runUpgrade,
  type UpgradeWorker,
  type UpgradeWorkerResult,
  upgradeFailed,
  upgradeIncomplete,
  upgradeJsonLine,
  upgradeText,
  validateUpgradeFlags,
} from "./upgrade";

/**
 * Narrow a fan-out entry to the state that carries a plan, failing the test when the run lost it.
 *
 * Every assertion below reaching through this is one the #380 union makes unreachable without narrowing —
 * which is the point of putting the plan behind the discriminant rather than beside an `ok` flag.
 */
function reconciled(result: UpgradeWorkerResult | undefined): Extract<UpgradeWorkerResult, { state: "reconciled" }> {
  if (result?.state !== "reconciled") throw new Error(`expected a reconciled worker, got ${result?.state ?? "none"}`);
  return result;
}

/** The three-state entry a render test hands to `renderUpgrade`, for a Worker whose plan was built. */
const entry = (built: ReconcilePlan, applied: ReconcileApplied | null = null): UpgradeWorkerResult => ({
  state: "reconciled",
  worker: built.worker,
  plan: built,
  applied,
});

interface ArgSpec {
  type: string;
  default?: unknown;
}

describe("upgrade command", () => {
  test("meta and args match the CLI surface", () => {
    expect(upgrade.meta).toMatchObject({ name: "upgrade" });
    const args = upgrade.args as Record<string, ArgSpec>;
    expect(Object.keys(args)).toEqual(["env", "worker", "dry-run", "migrate", "packages", "latest", "json"]);
    expect(args.env).toMatchObject({ type: "string", default: "dev" });
    expect(args.worker).toMatchObject({ type: "string" });
    expect(args["dry-run"]).toMatchObject({ type: "boolean", default: false });
    expect(args.migrate).toMatchObject({ type: "boolean", default: false });
    expect(args.json).toMatchObject({ type: "boolean", default: false });
    expect(args.packages).toMatchObject({ type: "boolean", default: false });
    expect(args.latest).toMatchObject({ type: "boolean", default: false });
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
      missingEntryExports: [],
    },
    { name: "quiet", missingBindings: [], missingConfigKeys: [], missingEntryExports: [] },
  ],
  ejectedSkipped: ["billing"],
  ledger: { state: "read", pending: 3, undeclared: [] },
  entitlements: { state: "read", gates: [] },
  missingPrerequisites: [],
  declinedBindings: { state: "read", declines: [] },
  generatedValues: { state: "read", drift: [], stalePins: [] },
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

  test("a Durable Object class the entry does not export gets its own line", () => {
    // A plan reports what an apply writes. This one wrote the export and reported nothing, so a project
    // wired before it landed — binding present, export nowhere — read as "Nothing to upgrade." while
    // `wrangler deploy` refused it (#428).
    const lines = __test.planLines({
      ...plan,
      perCapability: [
        {
          name: "multiplayer",
          missingBindings: [],
          missingConfigKeys: [],
          missingEntryExports: ["MultiplayerSession"],
        },
      ],
    });
    expect(lines).toContain("Worker entry: export MultiplayerSession.");
  });

  test("a clean worker says nothing to upgrade", () => {
    const clean: ReconcilePlan = {
      worker: "api",
      deployedAs: "acme-api",
      env: "dev",
      perCapability: [],
      ejectedSkipped: [],
      ledger: { state: "read", pending: 0, undeclared: [] },
      entitlements: { state: "read", gates: [] },
      missingPrerequisites: [],
      declinedBindings: { state: "read", declines: [] },
      generatedValues: { state: "read", drift: [], stalePins: [] },
      missingVersionMetadata: false,
    };
    expect(__test.planLines(clean)).toEqual(["Nothing to upgrade."]);
  });
});

describe("applied rendering", () => {
  test("reports what was added and notes still-pending migrations when not migrated", () => {
    const applied: ReconcileApplied = {
      worker: "api",
      deployedAs: "acme-api",
      perCapability: [
        {
          name: "auth",
          addedBindings: [{ env: "dev", name: "DB", type: "d1" }],
          skippedBindings: [],
          addedConfigKeys: ["basePath"],
        },
      ],
      ejectedSkipped: ["billing"],
      migrated: false,
      migrations: [],
      addedVersionMetadata: false,
      addedEntryExports: [],
    };
    const lines = __test.appliedLines(applied, plan);
    expect(lines).toContain("auth: added 1 binding, 1 config key.");
    expect(lines).toContain("billing: ejected. Skipped.");
    expect(lines).toContain("3 migrations pending. Run pithy upgrade --migrate, or pithy migrate --env dev.");
  });

  test("reports a completed migration run instead of a pending note", () => {
    const applied: ReconcileApplied = {
      worker: "api",
      deployedAs: "acme-api",
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
      addedEntryExports: [],
    };
    const lines = __test.appliedLines(applied, plan);
    expect(lines).toContain("Migrated 1 migration.");
    expect(lines.some((line) => line.includes("pending"))).toBe(false);
  });
});

describe("worker grouping", () => {
  test("every worker gets a labeled block, its lines indented beneath", () => {
    const collab: ReconcilePlan = {
      worker: "collab",
      deployedAs: "acme-collab",
      env: "dev",
      perCapability: [],
      ejectedSkipped: [],
      ledger: { state: "read", pending: 0, undeclared: [] },
      entitlements: { state: "read", gates: [] },
      missingPrerequisites: [],
      declinedBindings: { state: "read", declines: [] },
      generatedValues: { state: "read", drift: [], stalePins: [] },
      missingVersionMetadata: false,
    };
    const out = __test.renderUpgrade({
      workers: [entry(plan), entry(collab)],
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
      deployedAs: "acme-api",
      perCapability: [{ name: "auth", addedBindings: [], skippedBindings: [], addedConfigKeys: ["basePath"] }],
      ejectedSkipped: [],
      migrated: false,
      migrations: [],
      addedVersionMetadata: false,
      addedEntryExports: [],
    };
    expect(__test.renderUpgrade({ workers: [entry(plan, applied)], manifestFaults: [] })).toContain(
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
      ledger: { state: "read", pending: 0, undeclared: [] },
      entitlements: { state: "read", gates: [] },
      missingPrerequisites: [],
      declinedBindings: { state: "read", declines: [] },
      generatedValues: { state: "read", drift: [], stalePins: [] },
      missingVersionMetadata: false,
    };
    expect(__test.renderUpgrade({ workers: [entry(clean)], manifestFaults: [] })).toEqual([
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

  /** Resolve the fixture Workers without importing a `pithy.config.ts`, honoring `--worker`. */
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
    const { workers: results } = await runUpgrade({ account: null, ...base, projectDir: dir, resolveWorkers: resolve });
    expect(results.map((result) => result.worker)).toEqual(["api", "collab"]);
    for (const result of results) {
      const { plan, applied } = reconciled(result);
      expect(applied).toBeNull(); // dry run writes nothing
      expect(plan.perCapability.find((cap) => cap.name === "auth")?.missingBindings).toHaveLength(3);
    }
  });

  test("--worker narrows the fan-out to one worker", async () => {
    const { workers: results } = await runUpgrade({
      account: null,
      ...base,
      projectDir: dir,
      worker: "collab",
      resolveWorkers: resolve,
    });
    expect(results).toHaveLength(1);
    expect(reconciled(results[0]).plan.worker).toBe("collab");
  });

  test("drift in one worker only is reported against that worker alone", async () => {
    // Wire DB into every one of api's stanzas; collab keeps the empty arrays.
    const raw = await readFile(join(apiDir, "wrangler.jsonc"), "utf8");
    await writeFile(
      join(apiDir, "wrangler.jsonc"),
      raw.replaceAll('"d1_databases": [],', '"d1_databases": [{ "binding": "DB" }],'),
    );

    const { workers: results } = await runUpgrade({ account: null, ...base, projectDir: dir, resolveWorkers: resolve });
    const byWorker = new Map(results.map((result) => [result.worker, reconciled(result).plan]));
    expect(byWorker.get("api")?.perCapability.find((cap) => cap.name === "auth")?.missingBindings).toEqual([]);
    expect(byWorker.get("collab")?.perCapability.find((cap) => cap.name === "auth")?.missingBindings).toHaveLength(3);
  });

  test("applying writes each worker's own wiring, and re-running finds nothing left", async () => {
    const applyOptions = { ...base, account: null, dryRun: false, projectDir: dir, resolveWorkers: resolve };
    const applied = await runUpgrade(applyOptions);
    expect(applied.workers.map((result) => reconciled(result).applied?.worker)).toEqual(["api", "collab"]);

    for (const workerDir of [apiDir, collabDir]) {
      const wrangler = await readFile(join(workerDir, "wrangler.jsonc"), "utf8");
      expect(wrangler).toContain('"binding": "DB"');
    }

    const second = await runUpgrade(applyOptions);
    for (const result of second.workers) expect(reconciled(result).applied?.perCapability).toEqual([]);
  });

  test("the applied entry carries the identity the plan does — a dry run and a real one are one array", async () => {
    // `--json` reports `applied ?? plan` from the same `workers` array, so a key the plan carries and the
    // apply drops is a payload that changes shape with a flag. A consumer that read `deployedAs` worked
    // under `--dry-run` and got `undefined` on the run that wrote something. #231.
    const { workers: results } = await runUpgrade({
      account: null,
      ...base,
      dryRun: false,
      projectDir: dir,
      resolveWorkers: resolve,
    });

    expect(results).toHaveLength(2);
    for (const result of results) {
      const { plan, applied } = reconciled(result);
      expect(plan.deployedAs).not.toBe("");
      expect({ worker: applied?.worker, deployedAs: applied?.deployedAs }).toEqual({
        worker: plan.worker,
        deployedAs: plan.deployedAs,
      });
    }
  });

  test("never writes a capability another worker composes into a worker that does not (regression)", async () => {
    // auth is installed once at the project root and wired into api alone. collab composes nothing, so it
    // must plan nothing and keep its wrangler.jsonc byte-identical — foreign bindings on a script that never
    // declared them are exactly what `pithy add --worker` exists to prevent.
    const before = await readFile(join(collabDir, "wrangler.jsonc"), "utf8");

    const { workers: results } = await runUpgrade({
      account: null,
      ...base,
      dryRun: false,
      projectDir: dir,
      resolveWorkers: resolveApiOnlyComposesAuth,
    });

    const byWorker = new Map(results.map((result) => [result.worker, reconciled(result)]));
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
    await runUpgrade({
      account: null,
      ...base,
      dryRun: false,
      projectDir: dir,
      worker: "api",
      resolveWorkers: resolve,
    });

    const wrangler = await readFile(join(apiDir, "wrangler.jsonc"), "utf8");
    expect(wrangler).toContain('"database_name": "upgrade-test-dev-db"');
    expect(wrangler).toContain('"database_name": "upgrade-test-prod-db"');
  });

  test("--worker leaves the other worker's files untouched", async () => {
    const before = await readFile(join(collabDir, "wrangler.jsonc"), "utf8");
    await runUpgrade({
      account: null,
      ...base,
      dryRun: false,
      projectDir: dir,
      worker: "api",
      resolveWorkers: resolve,
    });
    expect(await readFile(join(collabDir, "wrangler.jsonc"), "utf8")).toBe(before);
    expect(await readFile(join(apiDir, "wrangler.jsonc"), "utf8")).not.toBe(before);
  });

  test("--migrate runs migrations once per worker, scoped to that worker's directory", async () => {
    const seen: { worker: string; workerDir: string }[] = [];
    await runUpgrade({
      account: null,
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
      ledger: { state: "read", pending: 0, undeclared: [] },
      entitlements: { state: "read", gates: [] },
      missingPrerequisites: [],
      declinedBindings: { state: "read", declines: [] },
      generatedValues: { state: "read", drift: [], stalePins: [] },
      missingVersionMetadata: false,
    };
    expect(__test.renderUpgrade({ workers: [entry(clean)], manifestFaults: [fault] })).toEqual([
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
      ledger: { state: "read", pending: 0, undeclared: [] },
      entitlements: { state: "read", gates: [] },
      missingPrerequisites: [],
      declinedBindings: { state: "read", declines: [] },
      generatedValues: { state: "read", drift: [], stalePins: [] },
      missingVersionMetadata: false,
    };
    expect(__test.renderUpgrade({ workers: [entry(clean)], manifestFaults: [] })).toEqual([
      "api:",
      "  Nothing to upgrade.",
    ]);
  });
});

/**
 * **A Worker that could not be reconciled costs its own entry, not the run (#380).**
 *
 * `runUpgrade` fans out over `apps/*` building and applying one plan per Worker. A plan reads that
 * Worker's own config and wrangler stanzas; an apply *writes* them. Either can fail for reasons
 * belonging to one Worker, and the throw used to propagate — so a project lost every other Worker's
 * report to one broken config, after some of those Workers' files had already been rewritten.
 *
 * These tests exist to fail when either guard is removed. The failure is planted in the seams the run
 * already takes (`resolveWorkers` decides the set; `readLedger` and `runMigrate` are what a plan and an
 * apply reach through), so nothing here mocks the function under test.
 */
describe("runUpgrade — a worker that will not reconcile", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-upgrade-fail-"));
    await scaffoldProject({ targetDir: dir, appName: "upgrade-test" });
    await cp(join(dir, "apps", "api"), join(dir, "apps", "collab"), { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Both Workers; `broken` is the one whose wiring the plant destroys. */
  const both = async (): Promise<UpgradeWorker[]> => [
    { name: "api", dir: join(dir, "apps", "api"), capabilities: [] },
    { name: "collab", dir: join(dir, "apps", "collab"), capabilities: [] },
  ];

  const base = { account: null, env: "dev", migrate: false, resolveWorkers: both } as const;

  /**
   * A ledger that will not read — the failure both `#371` and `#380` were written against.
   *
   * It throws **synchronously** on purpose: a `.catch()` guard would not see it, and `#371`'s own plant
   * escaped exactly such a guard.
   */
  const brokenLedger = ({ workerDir }: { workerDir: string }) => {
    if (workerDir.endsWith("collab")) throw new Error("planted: this worker's ledger will not read");
    return Promise.resolve({ state: "read" as const, pending: 0, undeclared: [] });
  };

  test("a contributor that throws leaves the other worker's plan intact", async () => {
    const run = await runUpgrade({ ...base, dryRun: true, projectDir: dir, readLedger: brokenLedger });

    // Both are planned — `#371` degrades the contributor rather than losing the Worker. `#380`'s
    // `unplanned` state remains for a plan that cannot be built at all, which no contributor now causes.
    expect(run.workers.map((result) => [result.worker, result.state])).toEqual([
      ["api", "reconciled"],
      ["collab", "reconciled"],
    ]);
    expect(reconciled(run.workers[0]).plan.worker).toBe("api");
    expect(reconciled(run.workers[0]).plan.ledger).toEqual({ state: "read", pending: 0, undeclared: [] });
  });

  test("the worker that lost its ledger says so, and says nothing it could not check", async () => {
    const run = await runUpgrade({ ...base, dryRun: true, projectDir: dir, readLedger: brokenLedger });

    // `unavailable` carries no `pending`, so a short sum cannot be read as a whole one — and nothing
    // derived from the throw travels, because the catch takes no binding.
    expect(reconciled(run.workers[1]).plan.ledger).toEqual({ state: "unavailable" });
    expect(JSON.stringify(run.workers[1])).not.toContain("planted");
  });

  test("an unplanned worker carries its name and nothing else — no plan to read as an empty one", () => {
    // Asserted on the shape rather than through a plant, and that is a statement about the code as it
    // now stands: after `#371` every contributor to a plan degrades, so nothing reachable through
    // `runUpgrade`'s own seams makes `buildReconcilePlan` throw. The state and its guard are kept as
    // depth — a future contributor added without a guard lands here rather than taking the run down —
    // and this pins the shape so it cannot quietly grow a plan-shaped hole.
    const unplanned: UpgradeWorkerResult = { state: "unplanned", worker: "collab" };
    expect(Object.keys(unplanned).sort()).toEqual(["state", "worker"]);
    expect(__test.workerLines(unplanned)).toEqual([
      "Couldn't be planned. Its pithy.config.ts or wrangler.jsonc would not read.",
      "Nothing was written for it.",
    ]);
  });

  test("an apply that throws is its own state, because that worker's files have been opened", async () => {
    const run = await runUpgrade({
      ...base,
      dryRun: false,
      migrate: true,
      projectDir: dir,
      // The migration run an apply performs after writing the wiring. By the time this throws, that
      // Worker's `wrangler.jsonc` has already been rewritten — which is why it is not `unplanned`.
      runMigrate: async ({ worker }) => {
        if (worker === "collab") throw new Error("planted: this worker's migrations will not run");
        return [];
      },
    });

    expect(run.workers.map((result) => [result.worker, result.state])).toEqual([
      ["api", "reconciled"],
      ["collab", "unapplied"],
    ]);
    // The plan survives on this state and the applied record does not: what landed is precisely what
    // the run cannot say.
    const failed = run.workers[1];
    expect(failed?.state === "unapplied" && failed.plan.worker).toBe("collab");
    expect(failed && "applied" in failed).toBe(false);
  });

  test("either failure still fails the run — the gate does not weaken, it stops taking the report with it", async () => {
    // Both ledgers read. A stub rather than the real read, because the Workers here are a double over a
    // scaffold with nothing installed: the real read discovers the rest of the project beside them, and a
    // project whose configs will not compose is refused there rather than read as having no neighbors (#586).
    const clean = await runUpgrade({
      ...base,
      dryRun: true,
      projectDir: dir,
      readLedger: async () => ({ state: "read" as const, pending: 0, undeclared: [] }),
    });
    expect(upgradeIncomplete(clean)).toBe(false);

    // The composition case: `#371` degrades the ledger, so this Worker comes back `reconciled`. The
    // gate must still fail, because the check did not happen — asking `state !== "reconciled"` alone
    // would exit 0 on a Worker nobody could read.
    const broken = await runUpgrade({ ...base, dryRun: true, projectDir: dir, readLedger: brokenLedger });
    expect(broken.workers[1]?.state).toBe("reconciled");
    expect(upgradeIncomplete(broken)).toBe(true);
  });

  test("neither failure state says nothing to upgrade — that is a finding, and nobody looked", () => {
    const plans = __test.workerLines({ state: "unplanned", worker: "collab" });
    expect(plans).toEqual([
      "Couldn't be planned. Its pithy.config.ts or wrangler.jsonc would not read.",
      "Nothing was written for it.",
    ]);
    expect(plans).not.toContain("Nothing to upgrade.");

    const partial = __test.workerLines({ state: "unapplied", worker: "collab", plan: { ...plan, worker: "collab" } });
    expect(partial[0]).toBe("Upgrade failed partway. Its wiring may hold part of the plan below.");
    expect(partial[1]).toBe("Check it, then re-run: pithy upgrade --worker collab --env dev.");
  });
});

/**
 * What `pithy upgrade` says about a declined binding (#440).
 *
 * Two tenses and one refusal. The refusal is the case worth having a test for: it happens **before the
 * first write**, and every other failure out of `applyReconcilePlan` reports as "Upgrade failed partway.
 * Its wiring may hold part of the plan" — a sentence that would send an adopter looking for damage in a
 * file nothing touched, and that swallows the action line naming the entry to remove.
 */
describe("declined bindings", () => {
  const declining = (declines: ReconcilePlan["declinedBindings"]): ReconcilePlan => ({
    ...plan,
    perCapability: [],
    ejectedSkipped: [],
    ledger: { state: "read", pending: 0, undeclared: [] },
    declinedBindings: declines,
  });

  test("an honored decline is named in both tenses, under the capability that declares it", () => {
    const built = declining({
      state: "read",
      declines: [
        {
          state: "honored",
          name: "SUPPORT_BUCKET",
          type: "r2",
          capability: "support",
          reason: "no R2 yet",
          stillPresentIn: [],
        },
      ],
    });
    expect(__test.planLines(built)).toContain("support: SUPPORT_BUCKET (r2) declined in pithy.config.ts. Not written.");
  });

  test("it sits beside `Nothing to upgrade.`, not instead of it", () => {
    // A run that wrote nothing did write nothing. The decline says why part of that is true; it does not
    // contradict it, and an adopter reading only the first line is not misled by either.
    const lines = __test.planLines(
      declining({
        state: "read",
        declines: [
          {
            state: "honored",
            name: "SUPPORT_BUCKET",
            type: "r2",
            capability: "support",
            reason: "no R2 yet",
            stillPresentIn: [],
          },
        ],
      }),
    );
    expect(lines[0]).toBe("Nothing to upgrade.");
    expect(lines).toHaveLength(2);
  });

  test("a stale decline says it is ignored, and nothing else changes", () => {
    const lines = __test.planLines(
      declining({ state: "read", declines: [{ state: "unrecognized", name: "GONE", reason: "removed it" }] }),
    );
    expect(lines).toContain("declinedBindings: GONE is declined, and nothing here declares it. Ignored.");
  });

  test("a refusal reports its own problem and action, and never claims a partial write", () => {
    // The distinction `refused` exists for. `unapplied` means files were opened; this means they were
    // not, and telling the two apart is the difference between "go inspect your wiring" and "fix one
    // line".
    const built = declining({
      state: "read",
      declines: [{ state: "required", name: "DB", type: "d1", capability: "auth", reason: "own database" }],
    });
    const refusal = declineRefusal(built);
    expect(refusal).not.toBeNull();
    const lines = __test.workerLines({
      state: "refused",
      worker: "api",
      plan: built,
      // biome-ignore lint/style/noNonNullAssertion: asserted non-null on the line above.
      refusal: refusal!.payload,
    });
    expect(lines[0]).toContain("cannot decline");
    expect(lines.join("\n")).toContain("Remove the entry");
    expect(lines.join("\n")).toContain("auth requires it");
    expect(lines.join("\n")).not.toContain("failed partway");
  });

  test("a refused Worker fails the run, and an honored decline does not", () => {
    // The exit gate is what CI reads. A decline that is working must not turn every headless run red;
    // a decline that cannot be honored must not be exited 0 around.
    const honored = declining({
      state: "read",
      declines: [
        {
          state: "honored",
          name: "SUPPORT_BUCKET",
          type: "r2",
          capability: "support",
          reason: "no R2 yet",
          stillPresentIn: [],
        },
      ],
    });
    expect(upgradeIncomplete({ workers: [entry(honored, null)], manifestFaults: [] })).toBe(false);
    expect(
      upgradeIncomplete({
        workers: [
          {
            state: "refused",
            worker: "api",
            plan: honored,
            // A real payload from the real gate, not a hand-built one: the exit gate must key on the
            // state rather than on anything about the error, and a fabricated payload could not show that.
            refusal: new ValidationError({ message: "This Worker declines a binding it cannot decline." }).payload,
          },
        ],
        manifestFaults: [],
      }),
    ).toBe(true);
  });
});

/**
 * `--dry-run` and the real run must agree about a refusal (#440 review).
 *
 * A dry run's whole job is to predict the write, and a refused decline is the thing that stops it. The
 * first implementation returned at the dry-run branch *before* asking, so `pithy upgrade --dry-run`
 * printed "Nothing to upgrade." and exited 0 where the identical un-flagged run exited 1.
 */
describe("a refused decline in both tenses", () => {
  const refusing: ReconcilePlan = {
    ...plan,
    perCapability: [],
    ejectedSkipped: [],
    ledger: { state: "read", pending: 0, undeclared: [] },
    declinedBindings: {
      state: "read",
      declines: [{ state: "required", name: "DB", type: "d1", capability: "auth", reason: "own database" }],
    },
  };

  test("the plan itself carries the refusal, so both paths read one fact", () => {
    // Neither tense recomputes anything: the refusal is a function of the plan, and the plan is built
    // once. That is what makes "they agree" structural rather than a pair of code paths kept in step.
    expect(declineRefusal(refusing)).not.toBeNull();
    expect(declineRefusal({ ...refusing, declinedBindings: { state: "read", declines: [] } })).toBeNull();
  });

  test("a refused Worker fails the exit whether or not anything was written", () => {
    const refusal = declineRefusal(refusing);
    // biome-ignore lint/style/noNonNullAssertion: asserted non-null in the case above.
    const result = { state: "refused" as const, worker: "api", plan: refusing, refusal: refusal!.payload };
    expect(upgradeIncomplete({ workers: [result], manifestFaults: [] })).toBe(true);
    // And the lines it renders are the refusal's own, in either tense — there is one renderer.
    expect(__test.workerLines(result).join("\n")).not.toContain("Nothing to upgrade.");
  });
});

describe("validateUpgradeFlags", () => {
  test("--latest alone moves nothing, so it is refused", () => {
    expect(() => validateUpgradeFlags({ packages: false, latest: true })).toThrow(ValidationError);
    expect(() => validateUpgradeFlags({ packages: false, latest: true })).toThrow(
      "--latest moves packages. Add --packages.",
    );
  });

  test("--packages is project-wide, so --worker is refused beside it", () => {
    expect(() => validateUpgradeFlags({ packages: true, latest: false, worker: "board" })).toThrow(
      "Packages move project-wide. Drop --worker.",
    );
  });

  test("every other combination passes", () => {
    expect(() => validateUpgradeFlags({ packages: false, latest: false, worker: "board" })).not.toThrow();
    expect(() => validateUpgradeFlags({ packages: true, latest: true })).not.toThrow();
  });
});

/**
 * `--packages` against a real project on disk: a root and one Worker, `board`, with a React front end whose
 * sign-in screen the adopter has edited. Only the registry, the installer and the ledger are fakes, and the
 * installer is one that writes what a rewritten range pins — so what the run reads back is what it wrote.
 */
describe("runUpgrade --packages", () => {
  let dir: string;
  let boardDir: string;
  const UI = "@pithy-sh/ui-react";
  const SIGN_IN_020 = 'if (code === "signup_disabled") refuse();\n';
  const SIGN_IN_031 = 'if (code === "provider_sign_in_refused") refuse();\n';
  const tarball = templateTarball({
    "src/routes/pithy/sign-in.tsx": SIGN_IN_031,
    "src/routes/pithy/choose-organization.tsx": "export const Chooser = true;\n",
  });
  const tarballUrl = "https://registry.npmjs.org/@pithy-sh/ui-react/-/ui-react-0.3.1.tgz";

  const registry = (): RegistryFetch => {
    const ui = fakePackument(UI, ["0.2.0", "0.3.1"]);
    const published = ui.versions["0.3.1"];
    if (published) published.dist = { tarball: tarballUrl, integrity: tarball.integrity };
    return fakeRegistry(
      { "@pithy-sh/auth": fakePackument("@pithy-sh/auth", ["0.2.0", "0.2.3", "0.3.1"]), [UI]: ui },
      { [tarballUrl]: tarball.bytes },
    );
  };
  const ledger = async () => ({ state: "read" as const, pending: 0, undeclared: [] });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-upgrade-packages-"));
    await scaffoldProject({ targetDir: dir, appName: "replay" });
    boardDir = join(dir, "apps", "board");
    await cp(join(dir, "apps", "api"), boardDir, { recursive: true });
    await rm(join(dir, "apps", "api"), { recursive: true, force: true });
    await writeFile(
      join(dir, "package.json"),
      `${JSON.stringify({ name: "replay", private: true, workspaces: ["apps/*"], dependencies: { "@pithy-sh/auth": "^0.2.0" } }, null, 2)}\n`,
    );
    await writeFile(
      join(boardDir, "package.json"),
      `${JSON.stringify({ name: "board", dependencies: { "@pithy-sh/auth": "^0.2.0", [UI]: "^0.2.0" } }, null, 2)}\n`,
    );
    await writeFile(join(dir, "bun.lock"), "{}\n");
    const manifest = await readManifestDocument(boardDir);
    manifest.ui = { stub: "react", build: ["vite", "build"] };
    await writeManifestDocument(boardDir, manifest);
    await mkdir(join(boardDir, "src", "routes", "pithy"), { recursive: true });
    await writeFile(join(boardDir, "src", "routes", "pithy", "sign-in.tsx"), "export const SignIn = wrapped;\n");
    await fakeInstall()("bun", ["install"], dir);
    // The installed ui-react carries its templates, as the published one does.
    const installed = join(boardDir, "node_modules", "@pithy-sh", "ui-react", "templates", "src", "routes", "pithy");
    await mkdir(installed, { recursive: true });
    await writeFile(join(installed, "sign-in.tsx"), SIGN_IN_020);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** The one Worker, resolved without importing its config — composing nothing, so the reconcile is quiet. */
  const board = async (): Promise<UpgradeWorker[]> => [{ name: "board", dir: boardDir, capabilities: [] }];
  const base = { account: null, env: "dev", migrate: false, readLedger: ledger } as const;

  test("with no flag nothing reaches the registry or the installer, and the output is today's", async () => {
    const fetch = vi.fn<RegistryFetch>(async () => {
      throw new Error("the registry must not be asked");
    });
    const runInstall = vi.fn(async () => {});
    const run = await runUpgrade({
      ...base,
      projectDir: dir,
      dryRun: false,
      resolveWorkers: board,
      registryFetch: fetch,
      runInstall,
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(runInstall).not.toHaveBeenCalled();
    expect(run.packages).toBeUndefined();
    expect(upgradeText(run, false)).toEqual([...__test.renderUpgrade(run), "Done."]);
    const json = JSON.parse(upgradeJsonLine(run, "dev", false)) as Record<string, unknown>;
    expect(Object.keys(json)).toEqual(["command", "env", "dryRun", "workers", "manifestFaults"]);
    expect(await readFile(join(dir, "package.json"), "utf8")).toContain('"@pithy-sh/auth": "^0.2.0"');
  });

  test("moves every range to the newest it admits, installs once, and reconciles after the install", async () => {
    const runInstall = fakeInstall();
    // Every version the resolver saw, one per call: a resolve before the install would show up as 0.2.0.
    const installedAtResolve: string[] = [];
    const run = await runUpgrade({
      ...base,
      projectDir: dir,
      dryRun: false,
      packages: { latest: false },
      registryFetch: registry(),
      runInstall,
      // The package step runs before any config is imported: by the time the Workers resolve, the new
      // versions are installed.
      resolveWorkers: async () => {
        installedAtResolve.push(
          JSON.parse(await readFile(join(boardDir, "node_modules", "@pithy-sh", "auth", "package.json"), "utf8"))
            .version,
        );
        return board();
      },
    });
    expect(installedAtResolve).toEqual(["0.2.3"]);
    expect(runInstall.calls).toEqual([["bun", ["install"], dir]]);
    expect(JSON.parse(await readFile(join(dir, "package.json"), "utf8")).dependencies).toEqual({
      "@pithy-sh/auth": "^0.2.3",
    });
    expect(JSON.parse(await readFile(join(boardDir, "package.json"), "utf8")).dependencies).toEqual({
      "@pithy-sh/auth": "^0.2.3",
      [UI]: "^0.2.0",
    });
    expect(run.packages).toMatchObject({ state: "read", installed: true, reconciled: true, mismatches: [] });
    expect(run.workers.map((result) => result.state)).toEqual(["reconciled"]);
    expect(upgradeFailed(run)).toBe(false);
  });

  test("a new 0.x minor is held, reported with the command, and the templates it changed are named", async () => {
    const run = await runUpgrade({
      ...base,
      projectDir: dir,
      dryRun: false,
      packages: { latest: false },
      registryFetch: registry(),
      runInstall: fakeInstall(),
      resolveWorkers: board,
    });
    expect(run.packages?.held).toEqual([
      {
        name: "@pithy-sh/auth",
        manifest: "package.json",
        range: "^0.2.0",
        installed: "0.2.0",
        latest: "0.3.1",
        reason: "breaking",
        command: "pithy upgrade --packages --latest",
      },
      {
        name: "@pithy-sh/auth",
        manifest: "apps/board/package.json",
        range: "^0.2.0",
        installed: "0.2.0",
        latest: "0.3.1",
        reason: "breaking",
        command: "pithy upgrade --packages --latest",
      },
      {
        name: UI,
        manifest: "apps/board/package.json",
        range: "^0.2.0",
        installed: "0.2.0",
        latest: "0.3.1",
        reason: "breaking",
        command: "pithy upgrade --packages --latest",
      },
    ]);
    expect(run.packages?.templates).toEqual([
      {
        state: "checked",
        package: UI,
        from: ["0.2.0"],
        to: "0.3.1",
        applied: false,
        files: [
          { worker: "board", path: "src/routes/pithy/sign-in.tsx", change: "changed", copy: "edited" },
          { worker: "board", path: "src/routes/pithy/choose-organization.tsx", change: "added", copy: "absent" },
        ],
      },
    ]);
    expect(upgradeText(run, false)).toEqual([
      "Packages:",
      "  @pithy-sh/auth  ^0.2.0 → ^0.2.3  (package.json, apps/board/package.json)",
      "  @pithy-sh/auth  0.3.1 held. Crosses a breaking boundary. Run pithy upgrade --packages --latest.",
      "  @pithy-sh/ui-react  0.3.1 held. Crosses a breaking boundary. Run pithy upgrade --packages --latest.",
      "Templates (@pithy-sh/ui-react 0.2.0 → 0.3.1, held):",
      "  Templates come from the CLI's @pithy-sh/ui-react. The copies are the project's; nothing here rewrites them.",
      "  board:",
      "    src/routes/pithy/sign-in.tsx  changed upstream. The copy is edited. Merge by hand.",
      "    src/routes/pithy/choose-organization.tsx  new in 0.3.1. Not in this Worker.",
      "board:",
      "  Nothing to upgrade.",
      "Done.",
    ]);
    // Held is not a failure: the run did what it was asked, and said what it would not do.
    expect(upgradeFailed(run)).toBe(false);
  });

  test("--latest crosses the boundary, keeps the operator, and the report is the one that was applied", async () => {
    const run = await runUpgrade({
      ...base,
      projectDir: dir,
      dryRun: false,
      packages: { latest: true },
      registryFetch: registry(),
      runInstall: fakeInstall(),
      resolveWorkers: board,
    });
    expect(JSON.parse(await readFile(join(boardDir, "package.json"), "utf8")).dependencies).toEqual({
      "@pithy-sh/auth": "^0.3.1",
      [UI]: "^0.3.1",
    });
    expect(run.packages?.held).toEqual([]);
    expect(run.packages?.templates.map((section) => [section.to, section.applied])).toEqual([["0.3.1", true]]);
    expect(upgradeText(run, false)).toContain("Templates (@pithy-sh/ui-react 0.2.0 → 0.3.1):");
  });

  test("a dry run and a real run carry the same plan; the dry run writes nothing and says what it reconciled", async () => {
    const runInstall = fakeInstall();
    const dry = await runUpgrade({
      ...base,
      projectDir: dir,
      dryRun: true,
      packages: { latest: false },
      registryFetch: registry(),
      runInstall,
      resolveWorkers: board,
    });
    expect(runInstall.calls).toEqual([]);
    expect(await readFile(join(dir, "package.json"), "utf8")).toContain('"@pithy-sh/auth": "^0.2.0"');
    const real = await runUpgrade({
      ...base,
      projectDir: dir,
      dryRun: false,
      packages: { latest: false },
      registryFetch: registry(),
      runInstall: fakeInstall(),
      resolveWorkers: board,
    });
    const { installed: _dry, ...dryPlan } = dry.packages ?? {};
    const { installed: _real, ...realPlan } = real.packages ?? {};
    expect(dryPlan).toEqual(realPlan);
    expect(dry.packages?.reconciled).toBe(true);
    const text = upgradeText(dry, true);
    expect(text).toContain("  Reconciled against the current install. The moves above are not installed.");
    expect(text.at(-1)).toBe("Dry run. Nothing written.");
    const json = JSON.parse(upgradeJsonLine(dry, "dev", true)) as Record<string, unknown>;
    expect(Object.keys(json)).toEqual(["command", "env", "dryRun", "workers", "manifestFaults", "packages"]);
  });

  test("a registry that does not answer: nothing written, the reconcile still runs, and the run fails", async () => {
    const runInstall = fakeInstall();
    const run = await runUpgrade({
      ...base,
      projectDir: dir,
      dryRun: false,
      packages: { latest: false },
      registryFetch: fakeRegistry({}),
      runInstall,
      resolveWorkers: board,
    });
    expect(run.packages).toMatchObject({ state: "unavailable", installed: false, reconciled: true, moves: [] });
    expect(runInstall.calls).toEqual([]);
    expect(run.workers.map((result) => result.state)).toEqual(["reconciled"]);
    expect(upgradeFailed(run)).toBe(true);
    expect(upgradeText(run, false)[0]).toBe("Packages: not checked. The registry did not answer. Nothing moved.");
  });

  test("an install that lands the wrong version fails the run and names it", async () => {
    const run = await runUpgrade({
      ...base,
      projectDir: dir,
      dryRun: false,
      packages: { latest: false },
      registryFetch: registry(),
      runInstall: fakeInstall({ hold: ["@pithy-sh/auth"] }),
      resolveWorkers: board,
    });
    expect(upgradeFailed(run)).toBe(true);
    expect(upgradeText(run, false)).toContain("  @pithy-sh/auth  expected 0.2.3 in package.json. Installed: 0.2.0.");
  });

  test("a moved CLI stops the run before the reconcile, and says to run the new one", async () => {
    const root = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    root.devDependencies = { "@pithy-sh/cli": "^0.9.4" };
    await writeFile(join(dir, "package.json"), `${JSON.stringify(root, null, 2)}\n`);
    const resolveWorkers = vi.fn(board);
    const fetch = fakeRegistry({
      "@pithy-sh/auth": fakePackument("@pithy-sh/auth", ["0.2.0"]),
      [UI]: fakePackument(UI, ["0.2.0"]),
      "@pithy-sh/cli": fakePackument("@pithy-sh/cli", ["0.9.4", "0.9.5"], "0.9.5", { "0.9.5": { [UI]: "^0.2.0" } }),
    });
    const run = await runUpgrade({
      ...base,
      projectDir: dir,
      dryRun: false,
      packages: { latest: false },
      registryFetch: fetch,
      runInstall: fakeInstall(),
      resolveWorkers,
    });
    expect(resolveWorkers).not.toHaveBeenCalled();
    expect(run.workers).toEqual([]);
    expect(run.packages?.reconciled).toBe(false);
    expect(upgradeFailed(run)).toBe(false);
    expect(upgradeText(run, false).slice(-2)).toEqual([
      "@pithy-sh/cli moved to 0.9.5. Run pithy upgrade to reconcile with it.",
      "Done.",
    ]);
    expect(JSON.parse(upgradeJsonLine(run, "dev", false)).packages).toMatchObject({
      reconciled: false,
      installed: true,
    });
  });
});

/**
 * **Doctor's advice, followed, clears doctor's line (#634's fourth criterion).** Built from the real pieces
 * end to end: doctor reads the project's own manifests and `node_modules`, the command it names is run, and
 * doctor is asked again with the same registry.
 */
describe("doctor's advice clears its own line", () => {
  const harness = doctorHarness();
  let project: string;

  beforeEach(async () => {
    project = join(harness.dir, "project");
    await mkdir(join(project, "apps", "board"), { recursive: true });
    await writeFile(
      join(project, "package.json"),
      `${JSON.stringify({ name: "replay", workspaces: ["apps/*"], dependencies: { "@pithy-sh/auth": "^0.2.0" } }, null, 2)}\n`,
    );
    await writeFile(join(project, "apps", "board", "package.json"), `${JSON.stringify({ name: "board" }, null, 2)}\n`);
    await fakeInstall()("bun", ["install"], project);
  });

  const registryAt = (latest: string) =>
    fakeRegistry({
      "@pithy-sh/auth": fakePackument(
        "@pithy-sh/auth",
        ["0.2.0", "0.2.3", "0.3.1"].filter((v) => v <= latest),
        latest,
      ),
      "@pithy-sh/cli": fakePackument("@pithy-sh/cli", ["1.3.0"]),
    });
  const doctorWith = (fetch: ReturnType<typeof registryAt>) =>
    buildDoctorReport(
      harness.baseOptions({
        projectDir: project,
        fetch,
        installedCapabilities: installedCapabilityVersions,
        declaredSpecs,
      }),
    );
  const upgradeWith = (fetch: RegistryFetch, latest: boolean) =>
    runUpgrade({
      account: null,
      env: "dev",
      migrate: false,
      dryRun: false,
      projectDir: project,
      packages: { latest },
      registryFetch: fetch,
      runInstall: fakeInstall(),
      resolveWorkers: async () => [],
    });
  const authRow = (report: Awaited<ReturnType<typeof buildDoctorReport>>) =>
    report.project?.capabilities.find((cap) => cap.name === "@pithy-sh/auth");

  test("in range: doctor names --packages, and after it the line is current", async () => {
    const fetch = registryAt("0.2.3");
    const before = await doctorWith(fetch);
    expect(authRow(before)).toMatchObject({ state: "outdated", command: "pithy upgrade --packages" });
    expect(renderDoctorText(before, "/home/u")).toContain("(0.2.3 available — run `pithy upgrade --packages`)");
    await upgradeWith(fetch, false);
    expect(authRow(await doctorWith(fetch))).toMatchObject({ state: "current", installed: "0.2.3" });
  });

  test("across a boundary: doctor names --latest, plain --packages leaves the line, and --latest clears it", async () => {
    const fetch = registryAt("0.3.1");
    const before = await doctorWith(fetch);
    expect(authRow(before)).toMatchObject({ state: "outdated", command: "pithy upgrade --packages --latest" });
    expect(renderDoctorText(before, "/home/u")).toContain(
      "(0.3.1 available — run `pithy upgrade --packages --latest`. Crosses a breaking boundary.)",
    );
    await upgradeWith(fetch, false);
    expect(authRow(await doctorWith(fetch))).toMatchObject({ state: "outdated", installed: "0.2.3" });
    await upgradeWith(fetch, true);
    expect(authRow(await doctorWith(fetch))).toMatchObject({ state: "current", installed: "0.3.1" });
  });
});
