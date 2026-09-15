// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test, vi } from "vitest";
import {
  type BuildReconcilePlanOptions,
  buildReconcilePlan,
  type MigrationScope,
  type ReconcilePlan,
} from "../capabilities/reconcile";
import type { ProjectLedger } from "../migrations/run";
import { checkedWorker } from "../test-utils/doctorHarness";
import { type BuildPlan, buildProjectHealth, defaultBuildPlan, type ProjectHealthOptions } from "./health";

/** A plan builder keyed by Worker, so health is tested without touching a project on disk. */
function planStub(plans: Record<string, ReconcilePlan>): BuildPlan {
  return vi.fn(async (options: BuildReconcilePlanOptions) => {
    const plan = plans[options.worker ?? ""];
    if (!plan) throw new Error(`no stub plan for worker ${options.worker}`);
    return plan;
  });
}

/** A clean plan for one Worker. */
function clean(worker: string): ReconcilePlan {
  return {
    worker,
    // Derived, never echoed — the directory and the deployed name must differ in every fixture.
    deployedAs: `acme-${worker}`,
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
}

/**
 * No declared environment, a run that can reach an account, and a composition that is each double's own
 * empty one — the migration check reduced to `dev` for suites that are about something else.
 */
const declaredNone = {
  environments: [],
  remoteSkip: null,
  composeWorker: async () => ({ capabilities: [] }),
} satisfies Pick<ProjectHealthOptions, "environments" | "remoteSkip" | "composeWorker">;

const api = { name: "api", dir: "/p/apps/api" };
const collab = { name: "collab", dir: "/p/apps/collab" };

describe("buildProjectHealth", () => {
  test("all checks pass on a clean plan", async () => {
    const health = await buildProjectHealth({
      account: null,
      projectDir: "/p",
      ...declaredNone,
      workers: [api],
      buildPlan: planStub({ api: clean("api") }),
    });
    expect(health.ok).toBe(true);
    expect(health.workers).toHaveLength(1);
    expect(checkedWorker(health).worker).toBe("api");
    expect(checkedWorker(health).config.ok).toBe(true);
    expect(checkedWorker(health).bindings.ok).toBe(true);
    expect(checkedWorker(health).migrations).toEqual({
      ok: true,
      environments: [{ env: "dev", state: "checked", ledger: { state: "read", pending: 0, undeclared: [] } }],
    });
  });

  test("config check fails on missing config keys, listing them per capability", async () => {
    const plan: ReconcilePlan = {
      ...clean("api"),
      perCapability: [
        {
          name: "auth",
          missingBindings: [],
          missingEntryExports: [],
          missingConfigKeys: [
            { key: "basePath", default: "/auth", describe: "x" },
            { key: "sessionDays", default: 30, describe: "y" },
          ],
        },
      ],
    };
    const health = await buildProjectHealth({
      account: null,
      projectDir: "/p",
      ...declaredNone,
      workers: [api],
      buildPlan: planStub({ api: plan }),
    });
    expect(health.ok).toBe(false);
    expect(checkedWorker(health).config.ok).toBe(false);
    expect(checkedWorker(health).config.drift).toEqual([{ capability: "auth", keys: ["basePath", "sessionDays"] }]);
  });

  test("bindings check groups a missing binding across the envs that lack it", async () => {
    const plan: ReconcilePlan = {
      ...clean("api"),
      perCapability: [
        {
          name: "media",
          missingConfigKeys: [],
          missingEntryExports: [],
          missingBindings: [
            { env: "staging", name: "MEDIA_BUCKET", type: "r2" },
            { env: "prod", name: "MEDIA_BUCKET", type: "r2" },
          ],
        },
      ],
    };
    const health = await buildProjectHealth({
      account: null,
      projectDir: "/p",
      ...declaredNone,
      workers: [api],
      buildPlan: planStub({ api: plan }),
    });
    expect(health.ok).toBe(false);
    expect(checkedWorker(health).bindings.missing).toEqual([
      { name: "MEDIA_BUCKET", type: "r2", envs: ["staging", "prod"] },
    ]);
  });

  test("bindings check fails on a Durable Object class the entry does not export", async () => {
    // The other half of a `durable_objects.bindings` entry, and the half `wrangler.jsonc` cannot show. A
    // project wired before the CLI wrote that line has the binding and not the class, so every other
    // check passes and the deploy is still refused — `doctor` calling it healthy is #428 one level up.
    const plan: ReconcilePlan = {
      ...clean("api"),
      perCapability: [
        {
          name: "multiplayer",
          missingConfigKeys: [],
          missingBindings: [],
          missingEntryExports: ["MultiplayerSession"],
        },
      ],
    };
    const health = await buildProjectHealth({
      account: null,
      projectDir: "/p",
      ...declaredNone,
      workers: [api],
      buildPlan: planStub({ api: plan }),
    });
    expect(health.ok).toBe(false);
    expect(checkedWorker(health).bindings.ok).toBe(false);
    expect(checkedWorker(health).bindings.missingExports).toEqual(["MultiplayerSession"]);
  });

  test("migrations check surfaces dev's pending count, under dev's name", async () => {
    const health = await buildProjectHealth({
      account: null,
      projectDir: "/p",
      ...declaredNone,
      workers: [api],
      readLedger: async () => ({ state: "read", pending: 2, undeclared: [] }),
      buildPlan: planStub({ api: clean("api") }),
    });
    expect(health.ok).toBe(false);
    expect(checkedWorker(health).migrations).toEqual({
      ok: false,
      environments: [{ env: "dev", state: "checked", ledger: { state: "read", pending: 2, undeclared: [] } }],
    });
  });

  test("migrations check fails on an applied migration nothing declares, with nothing pending", async () => {
    // The state that used to pass: the subtraction finds nothing missing, and migrate refuses anyway.
    const undeclared = [{ database: "app", binding: "DB", name: "0250_audit_0002_tenant" }];
    const health = await buildProjectHealth({
      account: null,
      projectDir: "/p",
      ...declaredNone,
      workers: [api],
      readLedger: async () => ({ state: "read", pending: 0, undeclared }),
      buildPlan: planStub({ api: clean("api") }),
    });
    expect(health.ok).toBe(false);
    expect(checkedWorker(health).migrations).toEqual({
      ok: false,
      environments: [{ env: "dev", state: "checked", ledger: { state: "read", pending: 0, undeclared } }],
    });
  });

  test("a deployed environment behind is reported on the check and does not fail it", async () => {
    const health = await buildProjectHealth({
      account: null,
      projectDir: "/p",
      ...declaredNone,
      environments: ["staging"],
      workers: [api],
      readLedger: async (scope) => ({ state: "read", pending: scope.env === "staging" ? 4 : 0, undeclared: [] }),
      buildPlan: planStub({ api: clean("api") }),
    });
    expect(health.ok).toBe(true);
    expect(checkedWorker(health).migrations).toEqual({
      ok: true,
      environments: [
        { env: "dev", state: "checked", ledger: { state: "read", pending: 0, undeclared: [] } },
        { env: "staging", state: "checked", ledger: { state: "read", pending: 4, undeclared: [] } },
      ],
    });
  });

  test("entitlements check surfaces the gating files of a Worker with no provider composed", async () => {
    const health = await buildProjectHealth({
      account: null,
      projectDir: "/p",
      ...declaredNone,
      workers: [api],
      buildPlan: planStub({
        api: { ...clean("api"), entitlements: { state: "read", gates: ["src/routes/reports.ts"] } },
      }),
    });
    // The seam fails closed, so this Worker would deny every gated route — an unhealthy project, not a
    // cosmetic warning. That is what makes `pithy doctor` exit non-zero and lets CI gate on it.
    expect(health.ok).toBe(false);
    expect(checkedWorker(health).entitlements).toEqual({
      ok: false,
      gap: { state: "read", gates: ["src/routes/reports.ts"] },
    });
  });

  test("no entitlement gap is a passing check, not an absent one", async () => {
    const health = await buildProjectHealth({
      account: null,
      projectDir: "/p",
      ...declaredNone,
      workers: [api],
      buildPlan: planStub({ api: clean("api") }),
    });
    expect(health.ok).toBe(true);
    expect(checkedWorker(health).entitlements).toEqual({ ok: true, gap: { state: "read", gates: [] } });
  });

  test("shares one engine with upgrade: the default plan builder is buildReconcilePlan", () => {
    expect(defaultBuildPlan).toBe(buildReconcilePlan);
  });

  test("forwards each worker's directory, name and composition for each environment, and reads each environment once per worker", async () => {
    const build = planStub({ api: clean("api"), collab: clean("collab") });
    const readLedger = vi.fn(
      async (_scope: MigrationScope): Promise<ProjectLedger> => ({ state: "read", pending: 0, undeclared: [] }),
    );
    // Each environment's composition is its own, so a plan handed another's is visible in what it was handed.
    const composeWorker = vi.fn(async (_worker: { name: string }, env: string) => ({
      capabilities: [{ name: `composed-for-${env}`, requiredBindings: [] }],
      config: { capabilities: [] },
    }));
    await buildProjectHealth({
      account: null,
      projectDir: "/p",
      ...declaredNone,
      composeWorker,
      environments: ["staging"],
      workers: [api, collab],
      readLedger,
      buildPlan: build,
    });
    // The plan is `upgrade`'s engine, built once per environment from that environment's composition. Each
    // is handed that environment's answer, never the seam, so the store is read once per environment and
    // not a second time for the plan.
    const planFor = (worker: string, env: string) => ({
      projectDir: "/p",
      workerDir: `/p/apps/${worker}`,
      worker,
      env,
      account: null,
      capabilities: [{ name: `composed-for-${env}`, requiredBindings: [] }],
      workerConfig: { capabilities: [] },
      readLedger: expect.any(Function),
    });
    expect(build).toHaveBeenNthCalledWith(1, planFor("api", "dev"));
    expect(build).toHaveBeenNthCalledWith(2, planFor("api", "staging"));
    expect(build).toHaveBeenNthCalledWith(3, planFor("collab", "dev"));
    expect(build).toHaveBeenNthCalledWith(4, planFor("collab", "staging"));
    expect(readLedger.mock.calls.map(([scope]) => [scope.worker, scope.env])).toEqual([
      ["api", "dev"],
      ["api", "staging"],
      ["collab", "dev"],
      ["collab", "staging"],
    ]);
    // One composition per Worker per environment: the migration answer and the plan share it.
    expect(composeWorker.mock.calls.map(([worker, env]) => `${worker.name} ${env}`)).toEqual([
      "api dev",
      "api staging",
      "collab dev",
      "collab staging",
    ]);
  });
});

/**
 * **A declared environment's stanza is checked against that environment's composition (#586).**
 *
 * The plan reports, for every stanza in `wrangler.jsonc`, the bindings a composed capability needs and the
 * stanza lacks. It was built once, from a composition for no environment, so which bindings `prod` needed
 * was decided by a config evaluated for none — a capability a config composes for `prod` alone was never
 * asked for in `prod`'s stanza.
 */
describe("buildProjectHealth — bindings per environment", () => {
  const needs = (env: string, name: string) => ({ env, name, type: "r2" as const });
  const planWith = (env: string, missingBindings: ReturnType<typeof needs>[]): ReconcilePlan => ({
    ...clean("api"),
    env,
    perCapability: [{ name: "media", missingConfigKeys: [], missingEntryExports: [], missingBindings }],
  });

  test("a declared stanza's missing bindings are its own environment's plan's, and nothing another plan says about it", async () => {
    const build = vi.fn(async (options: BuildReconcilePlanOptions): Promise<ReconcilePlan> => {
      // dev composes media everywhere, so dev's plan asks every stanza for its bucket.
      if (options.env === "dev") {
        return planWith("dev", [
          needs("dev", "DEV_BUCKET"),
          needs("staging", "MEDIA_BUCKET"),
          needs("prod", "MEDIA_BUCKET"),
          needs("qa", "MEDIA_BUCKET"),
        ]);
      }
      // staging's composition answers about prod's stanza too. That is not staging's to say.
      if (options.env === "staging") return planWith("staging", [needs("prod", "STAGING_ON_PROD")]);
      // prod's composition composes something that needs a bucket only in prod.
      return planWith("prod", [needs("prod", "PROD_ONLY_BUCKET"), needs("staging", "PROD_ON_STAGING")]);
    });
    const health = await buildProjectHealth({
      account: null,
      projectDir: "/p",
      ...declaredNone,
      environments: ["staging", "prod"],
      workers: [api],
      buildPlan: build,
    });
    expect(build.mock.calls.map(([options]) => options.env)).toEqual(["dev", "staging", "prod"]);
    // `qa` is a stanza nothing declares, so no composition is for it; dev's answer stands and
    // `Environments:` reports the stanza.
    expect(checkedWorker(health).bindings.missing).toEqual([
      { name: "DEV_BUCKET", type: "r2", envs: ["dev"] },
      { name: "MEDIA_BUCKET", type: "r2", envs: ["qa"] },
      { name: "PROD_ONLY_BUCKET", type: "r2", envs: ["prod"] },
    ]);
  });

  test("an environment that does not compose contributes no plan, and dev's answer does not stand in for it", async () => {
    const build = vi.fn(async (options: BuildReconcilePlanOptions) =>
      planWith(options.env, [needs("dev", "DEV_BUCKET"), needs("staging", "MEDIA_BUCKET")]),
    );
    const health = await buildProjectHealth({
      account: null,
      projectDir: "/p",
      ...declaredNone,
      composeWorker: async (_worker, env) => {
        if (env === "staging") throw new Error("staging is not configured.");
        return { capabilities: [] };
      },
      environments: ["staging"],
      workers: [api],
      buildPlan: build,
    });
    expect(build.mock.calls.map(([options]) => options.env)).toEqual(["dev"]);
    expect(checkedWorker(health).bindings.missing).toEqual([{ name: "DEV_BUCKET", type: "r2", envs: ["dev"] }]);
    expect(checkedWorker(health).migrations.environments).toContainEqual({ env: "staging", state: "not-composed" });
  });

  test("a Durable Object class a deployed environment's composition binds is still an export the entry needs", async () => {
    const build = vi.fn(
      async (options: BuildReconcilePlanOptions): Promise<ReconcilePlan> => ({
        ...clean("api"),
        perCapability:
          options.env === "prod"
            ? [{ name: "multiplayer", missingConfigKeys: [], missingBindings: [], missingEntryExports: ["Session"] }]
            : [],
      }),
    );
    const health = await buildProjectHealth({
      account: null,
      projectDir: "/p",
      ...declaredNone,
      environments: ["prod"],
      workers: [api],
      buildPlan: build,
    });
    expect(checkedWorker(health).bindings.missingExports).toEqual(["Session"]);
    expect(checkedWorker(health).bindings.ok).toBe(false);
  });

  test("a prerequisite or an option key only a deployed environment's composition lacks is still reported", async () => {
    const build = vi.fn(
      async (options: BuildReconcilePlanOptions): Promise<ReconcilePlan> =>
        options.env === "prod"
          ? {
              ...clean("api"),
              perCapability: [
                {
                  name: "auth",
                  missingBindings: [],
                  missingEntryExports: [],
                  missingConfigKeys: [{ key: "basePath", default: "/auth", describe: "x" }],
                },
              ],
              missingPrerequisites: [{ capability: "auth", requires: "email" }],
            }
          : clean("api"),
    );
    const health = await buildProjectHealth({
      account: null,
      projectDir: "/p",
      ...declaredNone,
      environments: ["staging", "prod"],
      workers: [api],
      buildPlan: build,
    });
    // The Worker does not start in prod, and dev's composition cannot see why.
    expect(checkedWorker(health).prerequisites).toEqual({
      ok: false,
      missing: [{ capability: "auth", requires: "email" }],
    });
    expect(checkedWorker(health).config.drift).toEqual([{ capability: "auth", keys: ["basePath"] }]);
    expect(health.ok).toBe(false);
  });

  test("the capability-resolution read is handed what every environment composes, once per capability", async () => {
    const readCapabilityReach = vi.fn(async () => ({ ok: true, reachable: [], unreachable: [], split: [] }));
    await buildProjectHealth({
      account: null,
      projectDir: "/p",
      ...declaredNone,
      composeWorker: async (_worker, env) => ({
        capabilities: [
          { name: "app", requiredBindings: [] },
          ...(env === "prod" ? [{ name: "payments", requiredBindings: [] }] : []),
        ],
      }),
      environments: ["staging", "prod"],
      workers: [api],
      buildPlan: planStub({ api: clean("api") }),
      readCapabilityReach,
    });
    expect(readCapabilityReach).toHaveBeenCalledWith("/p", [
      {
        name: "api",
        dir: "/p/apps/api",
        capabilities: [
          { name: "app", requiredBindings: [] },
          { name: "payments", requiredBindings: [] },
        ],
      },
    ]);
  });
});

describe("buildProjectHealth — per Worker", () => {
  test("reports one entry per worker, in the order given", async () => {
    const health = await buildProjectHealth({
      account: null,
      projectDir: "/p",
      ...declaredNone,
      workers: [api, collab],
      buildPlan: planStub({ api: clean("api"), collab: clean("collab") }),
    });
    expect(health.workers.map((worker) => worker.worker)).toEqual(["api", "collab"]);
    expect(health.ok).toBe(true);
  });

  test("one unhealthy worker fails the project while the others stay healthy", async () => {
    const drifted: ReconcilePlan = {
      ...clean("collab"),
      perCapability: [
        {
          name: "auth",
          missingConfigKeys: [],
          missingEntryExports: [],
          missingBindings: [{ env: "dev", name: "DB", type: "d1" }],
        },
      ],
    };
    const health = await buildProjectHealth({
      account: null,
      projectDir: "/p",
      ...declaredNone,
      workers: [api, collab],
      buildPlan: planStub({ api: clean("api"), collab: drifted }),
    });
    expect(health.ok).toBe(false);
    expect(checkedWorker(health, 0).ok).toBe(true);
    expect(checkedWorker(health, 1).ok).toBe(false);
  });

  /**
   * The #371 gate. One Worker's plan throws; every sibling Worker keeps all five of its checks.
   *
   * Both directions, asserted on the value rather than through the renderer: the sibling's lines are
   * still there, and the sick Worker does not read as a Worker that passed — `unavailable` carries no
   * `ok`, no empty drift lists and no `0 pending`.
   */
  test("a worker whose plan throws costs its own entry, never its siblings", async () => {
    const build: BuildPlan = async (options) => {
      if (options.worker === "api") {
        throw new Error("EACCES: permission denied, open '/p/apps/api/wrangler.jsonc'");
      }
      return clean(options.worker ?? "");
    };
    const health = await buildProjectHealth({
      account: null,
      projectDir: "/p",
      ...declaredNone,
      workers: [api, collab],
      buildPlan: build,
    });

    expect(health.workers[0]).toEqual({ state: "unavailable", worker: "api" });
    // The sibling kept all five checks.
    expect(checkedWorker(health, 1)).toMatchObject({ state: "checked", worker: "collab", ok: true });
    // And the sick Worker is not a Worker that passed: there is no `ok` on it to read as true, and no
    // empty drift list to read as no drift.
    const sick = health.workers[0];
    expect(sick && "ok" in sick).toBe(false);
    expect(sick && "config" in sick).toBe(false);
    // A Worker nobody checked fails the project, so CI does not go green around the hole.
    expect(health.ok).toBe(false);
    // And nothing the throw said travels — an errno message carries the adopter's own paths.
    expect(JSON.stringify(health)).not.toMatch(/EACCES|permission denied|wrangler\.jsonc/);
  });

  test("a project with no workers is vacuously healthy — nothing was checked", async () => {
    const health = await buildProjectHealth({
      account: null,
      projectDir: "/p",
      ...declaredNone,
      workers: [],
      buildPlan: planStub({}),
    });
    expect(health).toEqual({
      ok: true,
      workers: [],
      manifests: { ok: true, faults: [] },
      bindingScope: { ok: true, split: [], divergent: [], partial: false },
      capabilityReach: { ok: true, reachable: [], unreachable: [], split: [] },
    });
  });
});

/**
 * The check that says why a capability is absent from every other check.
 *
 * A manifest that is present and invalid was skipped by `availableManifests` without a word, so the
 * capability contributed no drift to any Worker and `doctor` reported the project healthy around the hole.
 * `doctor` is one of the three commands an adopter runs when something has gone missing (#184).
 */
describe("buildProjectHealth — manifests", () => {
  test("a healthy install reports no manifest faults and stays ok", async () => {
    const health = await buildProjectHealth({
      account: null,
      projectDir: "/p",
      ...declaredNone,
      workers: [api],
      buildPlan: planStub({ api: clean("api") }),
      readManifests: async () => ({ manifests: [], faults: [] }),
    });
    expect(health.manifests).toEqual({ ok: true, faults: [] });
    expect(health.ok).toBe(true);
  });

  test("a manifest that is present and invalid fails the project, naming the package and why", async () => {
    const fault = { package: "@pithy-sh/audit", reason: "configOptions[0].key — not a bare identifier" };
    const health = await buildProjectHealth({
      account: null,
      projectDir: "/p",
      ...declaredNone,
      workers: [api, collab],
      buildPlan: planStub({ api: clean("api"), collab: clean("collab") }),
      readManifests: async () => ({ manifests: [], faults: [fault] }),
    });
    // Every Worker is clean; the project is not.
    expect(health.workers.every((worker) => worker.state === "checked" && worker.ok)).toBe(true);
    expect(health.manifests).toEqual({ ok: false, faults: [fault] });
    expect(health.ok).toBe(false);
  });

  test("the fault is reported once, not once per Worker — manifests resolve at the project", async () => {
    const fault = { package: "@pithy-sh/audit", reason: "why" };
    const scan = vi.fn(async () => ({ manifests: [], faults: [fault] }));
    const health = await buildProjectHealth({
      account: null,
      projectDir: "/p",
      ...declaredNone,
      workers: [api, collab],
      buildPlan: planStub({ api: clean("api"), collab: clean("collab") }),
      readManifests: scan,
    });
    expect(scan).toHaveBeenCalledTimes(1);
    expect(health.manifests.faults).toEqual([fault]);
  });
});

describe("buildProjectHealth — project-global bindings", () => {
  /** A `split` finding, shaped the way `bindingScopeHealth` returns one. */
  const split = {
    ok: false,
    partial: false,
    divergent: [],
    split: [
      {
        capability: "email",
        package: "@pithy-sh/email",
        binding: "EMAIL_SUPPRESSIONS",
        kind: "d1" as const,
        expected: "acme-global-email-suppressions",
        credential: null,
        stale: [{ worker: "api", env: "staging", name: "acme-staging-email-suppressions" }],
        repointable: true,
      },
    ],
  };

  test("a project whose Workers all point at the one shared resource stays ok", async () => {
    const health = await buildProjectHealth({
      account: null,
      projectDir: "/p",
      ...declaredNone,
      workers: [api],
      buildPlan: planStub({ api: clean("api") }),
      readManifests: async () => ({ manifests: [], faults: [] }),
      readBindingScope: async () => ({ ok: true, split: [], divergent: [], partial: false }),
    });
    expect(health.bindingScope).toEqual({ ok: true, split: [], divergent: [], partial: false });
    expect(health.ok).toBe(true);
  });

  test("a shared resource bound per environment fails the project, though every Worker passes", async () => {
    // The reason it is project-wide: each Worker's own five checks are green, because a binding that is
    // *present* is all any of them asks about. The finding is that two stanzas disagree.
    const health = await buildProjectHealth({
      account: null,
      projectDir: "/p",
      ...declaredNone,
      workers: [api, collab],
      buildPlan: planStub({ api: clean("api"), collab: clean("collab") }),
      readManifests: async () => ({ manifests: [], faults: [] }),
      readBindingScope: async () => split,
    });
    expect(health.workers.every((worker) => worker.state === "checked" && worker.ok)).toBe(true);
    expect(health.bindingScope).toEqual(split);
    expect(health.ok).toBe(false);
  });

  test("it is read once, at the project, not once per Worker", async () => {
    const read = vi.fn(async () => ({ ok: true, split: [], divergent: [], partial: false }));
    await buildProjectHealth({
      account: null,
      projectDir: "/p",
      ...declaredNone,
      workers: [api, collab],
      buildPlan: planStub({ api: clean("api"), collab: clean("collab") }),
      readManifests: async () => ({ manifests: [], faults: [] }),
      readBindingScope: read,
    });
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith("/p");
  });
});

/**
 * The check that says why a `pithy <capability>` command just refused (#533's follow-on).
 *
 * A composition that loaded is not a capability the CLI can reach: the Worker's config was imported by
 * path and resolved its own imports, and the package behind it may be installed nowhere the project keeps
 * packages. Nothing else in the report notices — a capability with no manifest contributes no drift to any
 * check — so the adopter learned it one refusal at a time until this section.
 */
describe("buildProjectHealth — capability resolution", () => {
  /** A finding, shaped the way `capabilityReachHealth` returns one. */
  const unreachable = {
    ok: false,
    reachable: ["auth"],
    unreachable: [{ capability: "payments", package: "@pithy-sh/payments", workers: ["api"] }],
    split: [],
  };

  test("a project whose capabilities all resolve from the root stays ok", async () => {
    const health = await buildProjectHealth({
      account: null,
      projectDir: "/p",
      ...declaredNone,
      workers: [api],
      buildPlan: planStub({ api: clean("api") }),
      readManifests: async () => ({ manifests: [], faults: [] }),
      readCapabilityReach: async () => ({ ok: true, reachable: ["auth"], unreachable: [], split: [] }),
    });
    expect(health.capabilityReach).toEqual({ ok: true, reachable: ["auth"], unreachable: [], split: [] });
    expect(health.ok).toBe(true);
  });

  test("a capability the CLI cannot resolve fails the project, though every Worker passes", async () => {
    // Why it is project-wide, and why no Worker's own checks can catch it: the composition loaded, so
    // config, bindings, migrations, entitlements and prerequisites are all green about a capability every
    // command will refuse to reach.
    const health = await buildProjectHealth({
      account: null,
      projectDir: "/p",
      ...declaredNone,
      workers: [api, collab],
      buildPlan: planStub({ api: clean("api"), collab: clean("collab") }),
      readManifests: async () => ({ manifests: [], faults: [] }),
      readCapabilityReach: async () => unreachable,
    });
    expect(health.workers.every((worker) => worker.state === "checked" && worker.ok)).toBe(true);
    expect(health.capabilityReach).toEqual(unreachable);
    expect(health.ok).toBe(false);
  });

  test("it is read once, at the project, and handed the Workers for what they compose", async () => {
    const read = vi.fn(async () => ({ ok: true, reachable: [], unreachable: [], split: [] }));
    await buildProjectHealth({
      account: null,
      projectDir: "/p",
      ...declaredNone,
      workers: [api, collab],
      buildPlan: planStub({ api: clean("api"), collab: clean("collab") }),
      readManifests: async () => ({ manifests: [], faults: [] }),
      readCapabilityReach: read,
    });
    expect(read).toHaveBeenCalledTimes(1);
    // What they compose is each Worker's composition, never a set handed in beside the Workers.
    expect(read).toHaveBeenCalledWith("/p", [
      { ...api, capabilities: [] },
      { ...collab, capabilities: [] },
    ]);
  });
});
