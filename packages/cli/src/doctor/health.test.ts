import { describe, expect, test, vi } from "vitest";
import { type BuildReconcilePlanOptions, buildReconcilePlan, type ReconcilePlan } from "../capabilities/reconcile";
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
  return { worker, env: "dev", perCapability: [], ejectedSkipped: [], pendingMigrations: 0 };
}

const api = { name: "api", dir: "/p/apps/api", capabilities: [] };
const collab = { name: "collab", dir: "/p/apps/collab", capabilities: [] };

describe("buildProjectHealth", () => {
  test("all checks pass on a clean plan", async () => {
    const health = await buildProjectHealth({
      projectDir: "/p",
      env: "dev",
      workers: [api],
      buildPlan: planStub({ api: clean("api") }),
    });
    expect(health.ok).toBe(true);
    expect(health.workers).toHaveLength(1);
    expect(health.workers[0]?.worker).toBe("api");
    expect(health.workers[0]?.config.ok).toBe(true);
    expect(health.workers[0]?.bindings.ok).toBe(true);
    expect(health.workers[0]?.migrations).toEqual({ ok: true, pending: 0, env: "dev" });
  });

  test("config check fails on missing config keys, listing them per capability", async () => {
    const plan: ReconcilePlan = {
      ...clean("api"),
      perCapability: [
        {
          name: "auth",
          missingBindings: [],
          missingConfigKeys: [
            { key: "basePath", default: "/auth", describe: "x" },
            { key: "sessionDays", default: 30, describe: "y" },
          ],
        },
      ],
    };
    const health = await buildProjectHealth({
      projectDir: "/p",
      env: "dev",
      workers: [api],
      buildPlan: planStub({ api: plan }),
    });
    expect(health.ok).toBe(false);
    expect(health.workers[0]?.config.ok).toBe(false);
    expect(health.workers[0]?.config.drift).toEqual([{ capability: "auth", keys: ["basePath", "sessionDays"] }]);
  });

  test("bindings check groups a missing binding across the envs that lack it", async () => {
    const plan: ReconcilePlan = {
      ...clean("api"),
      perCapability: [
        {
          name: "media",
          missingConfigKeys: [],
          missingBindings: [
            { env: "staging", name: "MEDIA_BUCKET", type: "r2" },
            { env: "production", name: "MEDIA_BUCKET", type: "r2" },
          ],
        },
      ],
    };
    const health = await buildProjectHealth({
      projectDir: "/p",
      env: "dev",
      workers: [api],
      buildPlan: planStub({ api: plan }),
    });
    expect(health.ok).toBe(false);
    expect(health.workers[0]?.bindings.missing).toEqual([
      { name: "MEDIA_BUCKET", type: "r2", envs: ["staging", "production"] },
    ]);
  });

  test("migrations check surfaces the pending count and env", async () => {
    const health = await buildProjectHealth({
      projectDir: "/p",
      env: "dev",
      workers: [api],
      buildPlan: planStub({ api: { ...clean("api"), pendingMigrations: 2 } }),
    });
    expect(health.ok).toBe(false);
    expect(health.workers[0]?.migrations).toEqual({ ok: false, pending: 2, env: "dev" });
  });

  test("shares one engine with upgrade: the default plan builder is buildReconcilePlan", () => {
    expect(defaultBuildPlan).toBe(buildReconcilePlan);
  });

  test("forwards each worker's directory, name, capabilities, and the shared countPending seam", async () => {
    const build = planStub({ api: clean("api"), collab: clean("collab") });
    const countPending = vi.fn(async () => 0);
    await buildProjectHealth({
      projectDir: "/p",
      env: "staging",
      workers: [api, collab],
      countPending,
      buildPlan: build,
    });
    expect(build).toHaveBeenNthCalledWith(1, {
      projectDir: "/p",
      workerDir: "/p/apps/api",
      worker: "api",
      env: "staging",
      capabilities: [],
      countPending,
    });
    expect(build).toHaveBeenNthCalledWith(2, {
      projectDir: "/p",
      workerDir: "/p/apps/collab",
      worker: "collab",
      env: "staging",
      capabilities: [],
      countPending,
    });
  });
});

describe("buildProjectHealth — per Worker", () => {
  test("reports one entry per worker, in the order given", async () => {
    const health = await buildProjectHealth({
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
        { name: "auth", missingConfigKeys: [], missingBindings: [{ env: "dev", name: "DB", type: "d1" }] },
      ],
    };
    const health = await buildProjectHealth({
      projectDir: "/p",
      env: "dev",
      workers: [api, collab],
      buildPlan: planStub({ api: clean("api"), collab: drifted }),
    });
    expect(health.ok).toBe(false);
    expect(health.workers.find((worker) => worker.worker === "api")?.ok).toBe(true);
    expect(health.workers.find((worker) => worker.worker === "collab")?.ok).toBe(false);
  });

  test("a project with no workers is vacuously healthy — nothing was checked", async () => {
    const health = await buildProjectHealth({ projectDir: "/p", env: "dev", workers: [], buildPlan: planStub({}) });
    expect(health).toEqual({ ok: true, workers: [] });
  });
});
