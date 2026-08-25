// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test, vi } from "vitest";
import { type BuildReconcilePlanOptions, buildReconcilePlan, type ReconcilePlan } from "../capabilities/reconcile";
import type { ProjectLedger } from "../migrations/run";
import { checkedWorker } from "../test-utils/doctorHarness";
import { type BuildPlan, buildProjectHealth, defaultBuildPlan } from "./health";

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
    missingVersionMetadata: false,
  };
}

const api = { name: "api", dir: "/p/apps/api", capabilities: [] };
const collab = { name: "collab", dir: "/p/apps/collab", capabilities: [] };

describe("buildProjectHealth", () => {
  test("all checks pass on a clean plan", async () => {
    const health = await buildProjectHealth({
      account: null,
      projectDir: "/p",
      env: "dev",
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
      ledger: { state: "read", pending: 0, undeclared: [] },
      env: "dev",
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
      env: "dev",
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
      env: "dev",
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
      env: "dev",
      workers: [api],
      buildPlan: planStub({ api: plan }),
    });
    expect(health.ok).toBe(false);
    expect(checkedWorker(health).bindings.ok).toBe(false);
    expect(checkedWorker(health).bindings.missingExports).toEqual(["MultiplayerSession"]);
  });

  test("migrations check surfaces the pending count and env", async () => {
    const health = await buildProjectHealth({
      account: null,
      projectDir: "/p",
      env: "dev",
      workers: [api],
      buildPlan: planStub({ api: { ...clean("api"), ledger: { state: "read", pending: 2, undeclared: [] } } }),
    });
    expect(health.ok).toBe(false);
    expect(checkedWorker(health).migrations).toEqual({
      ok: false,
      ledger: { state: "read", pending: 2, undeclared: [] },
      env: "dev",
    });
  });

  test("migrations check fails on an applied migration nothing declares, with nothing pending", async () => {
    // The state that used to pass: the subtraction finds nothing missing, and migrate refuses anyway.
    const undeclared = [{ database: "app", binding: "DB", name: "0250_audit_0002_tenant" }];
    const health = await buildProjectHealth({
      account: null,
      projectDir: "/p",
      env: "dev",
      workers: [api],
      buildPlan: planStub({ api: { ...clean("api"), ledger: { state: "read", pending: 0, undeclared } } }),
    });
    expect(health.ok).toBe(false);
    expect(checkedWorker(health).migrations).toEqual({
      ok: false,
      ledger: { state: "read", pending: 0, undeclared },
      env: "dev",
    });
  });

  test("entitlements check surfaces the gating files of a Worker with no provider composed", async () => {
    const health = await buildProjectHealth({
      account: null,
      projectDir: "/p",
      env: "dev",
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
      env: "dev",
      workers: [api],
      buildPlan: planStub({ api: clean("api") }),
    });
    expect(health.ok).toBe(true);
    expect(checkedWorker(health).entitlements).toEqual({ ok: true, gap: { state: "read", gates: [] } });
  });

  test("shares one engine with upgrade: the default plan builder is buildReconcilePlan", () => {
    expect(defaultBuildPlan).toBe(buildReconcilePlan);
  });

  test("forwards each worker's directory, name, capabilities, and the shared readLedger seam", async () => {
    const build = planStub({ api: clean("api"), collab: clean("collab") });
    const readLedger = vi.fn(async (): Promise<ProjectLedger> => ({ state: "read", pending: 0, undeclared: [] }));
    await buildProjectHealth({
      account: null,
      projectDir: "/p",
      env: "staging",
      workers: [api, collab],
      readLedger,
      buildPlan: build,
    });
    expect(build).toHaveBeenNthCalledWith(1, {
      projectDir: "/p",
      workerDir: "/p/apps/api",
      worker: "api",
      env: "staging",
      account: null,
      capabilities: [],
      readLedger,
    });
    expect(build).toHaveBeenNthCalledWith(2, {
      projectDir: "/p",
      workerDir: "/p/apps/collab",
      worker: "collab",
      env: "staging",
      account: null,
      capabilities: [],
      readLedger,
    });
  });
});

describe("buildProjectHealth — per Worker", () => {
  test("reports one entry per worker, in the order given", async () => {
    const health = await buildProjectHealth({
      account: null,
      projectDir: "/p",
      env: "dev",
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
      env: "dev",
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
      env: "dev",
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
      env: "dev",
      workers: [],
      buildPlan: planStub({}),
    });
    expect(health).toEqual({ ok: true, workers: [], manifests: { ok: true, faults: [] } });
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
      env: "dev",
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
      env: "dev",
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
      env: "dev",
      workers: [api, collab],
      buildPlan: planStub({ api: clean("api"), collab: clean("collab") }),
      readManifests: scan,
    });
    expect(scan).toHaveBeenCalledTimes(1);
    expect(health.manifests.faults).toEqual([fault]);
  });
});
