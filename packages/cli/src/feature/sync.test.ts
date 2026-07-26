import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { WorkerTarget } from "../project/workers";
import { devConfigPath, readDevConfig } from "./devConfig";
import { BASE_PORT } from "./ports";
import { syncFeatureDevConfig } from "./sync";

describe("syncFeatureDevConfig", () => {
  let mainRoot: string;
  let worktreePath: string;

  beforeEach(async () => {
    mainRoot = await mkdtemp(join(tmpdir(), "pithy-sync-"));
    worktreePath = join(mainRoot, ".worktrees", "69-demo");
    await mkdir(worktreePath, { recursive: true });
    await writeFile(join(mainRoot, ".dev.vars"), "SECRET=abc\n");
  });
  afterEach(async () => {
    await rm(mainRoot, { recursive: true, force: true });
  });

  /** Resolve a worker's directory, creating it as a real discovery would have found it. */
  async function workerTargets(root: string, names: string[]): Promise<WorkerTarget[]> {
    const targets: WorkerTarget[] = [];
    for (const name of names) {
      const dir = name === "app" ? root : join(root, "apps", name);
      await mkdir(dir, { recursive: true });
      targets.push({ name, dir });
    }
    return targets;
  }

  /** Run a sync over a fixed worker set. */
  const sync = (names: string[]) =>
    syncFeatureDevConfig({
      mainRoot,
      worktreePath,
      branch: "feature/69-demo",
      discoverWorkers: async () => workerTargets(worktreePath, names),
    });

  test("first sync reserves a block and pins a port per worker", async () => {
    const report = await sync(["api", "web"]);

    expect(report.block).toMatchObject({ block: 0, base: BASE_PORT });
    expect(report.added.sort()).toEqual(["api", "web"]);
    expect(report.removed).toEqual([]);
    expect(report.dev.workers).toEqual({
      api: { port: BASE_PORT, origin: `http://localhost:${BASE_PORT}` },
      web: { port: BASE_PORT + 1, origin: `http://localhost:${BASE_PORT + 1}` },
    });

    // Persisted for the life of the feature.
    expect(await readDevConfig(devConfigPath(worktreePath))).toEqual(report.dev);
  });

  test("adding a worker gives it the next free port and leaves the others untouched", async () => {
    const before = await sync(["web"]);
    expect(before.dev.workers.web?.port).toBe(BASE_PORT);

    // "api" sorts before "web" — a positional assignment would have moved web.
    const after = await sync(["api", "web"]);

    expect(after.added).toEqual(["api"]);
    expect(after.removed).toEqual([]);
    expect(after.dev.workers.web?.port).toBe(BASE_PORT); // unmoved
    expect(after.dev.workers.api?.port).toBe(BASE_PORT + 1); // next free in the block
    expect(after.block).toEqual(before.block); // same reserved block, not a new one
  });

  test("removing a worker releases its port for reuse", async () => {
    await sync(["api", "web"]);
    const after = await sync(["web"]);

    expect(after.removed).toEqual(["api"]);
    expect(after.dev.workers.api).toBeUndefined();
    expect(after.dev.workers.web?.port).toBe(BASE_PORT + 1); // kept its own port
  });

  test("a no-change sync is idempotent and reports nothing moved", async () => {
    const first = await sync(["api", "web"]);
    const second = await sync(["api", "web"]);

    expect(second.added).toEqual([]);
    expect(second.removed).toEqual([]);
    expect(second.dev).toEqual(first.dev);
  });

  test("a second feature never draws from the first feature's block", async () => {
    await sync(["api"]);

    const otherWorktree = join(mainRoot, ".worktrees", "70-other");
    await mkdir(otherWorktree, { recursive: true });
    const other = await syncFeatureDevConfig({
      mainRoot,
      worktreePath: otherWorktree,
      branch: "feature/70-other",
      discoverWorkers: async () => workerTargets(otherWorktree, ["api"]),
    });

    expect(other.block.block).toBe(1);
    expect(other.dev.workers.api?.port).not.toBe(BASE_PORT);
  });

  test("wires the worktree's .dev.vars to the repo's shared file", async () => {
    await sync(["app"]);
    expect(await readFile(join(worktreePath, ".dev.vars"), "utf8")).toBe("SECRET=abc\n");
  });

  test("a colleague who pulled the branch gets the whole local setup built for them", async () => {
    // Their machine has the branch and the code, but none of the machine-local state: no .dev.config.json
    // (git-ignored), no port reservation, no .dev.vars link. One sync creates all of it.
    await expect(readDevConfig(devConfigPath(worktreePath))).resolves.toBeNull();

    const report = await sync(["api", "web"]);

    expect(report.added.sort()).toEqual(["api", "web"]);
    expect(await readDevConfig(devConfigPath(worktreePath))).toEqual(report.dev);
    expect(await readFile(join(worktreePath, "apps", "api", ".dev.vars"), "utf8")).toBe("SECRET=abc\n");
    // Their block is allocated against THEIR registry, which is why ports are never committed.
    expect(JSON.parse(await readFile(join(mainRoot, ".dev-ports.json"), "utf8"))["feature/69-demo"]).toMatchObject({
      block: 0,
    });
  });

  test("refuses to sync the main checkout as if it were a feature worktree, leaving its .dev.vars untouched", async () => {
    const apiDir = join(mainRoot, "apps", "api");
    await mkdir(apiDir, { recursive: true });
    const realDevVars = join(apiDir, ".dev.vars");
    await writeFile(realDevVars, "REAL_SECRET=do-not-lose-me\n");

    const failure = await syncFeatureDevConfig({
      mainRoot,
      worktreePath: mainRoot,
      branch: "feature/69-demo",
      discoverWorkers: async () => workerTargets(mainRoot, ["api"]),
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PithyError);
    expect((failure as PithyError).payload.action).toBeTruthy();

    // The guard fired before wireFeatureDevVars ever ran — the real, git-ignored file survives untouched.
    expect(await readFile(realDevVars, "utf8")).toBe("REAL_SECRET=do-not-lose-me\n");
  });
});
