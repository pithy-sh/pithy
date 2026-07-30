// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

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

  /** Resolve a worker's directory, creating it as a real discovery would have found it: apps/<name>. */
  async function workerTargets(root: string, names: string[]): Promise<WorkerTarget[]> {
    const targets: WorkerTarget[] = [];
    for (const name of names) {
      const dir = join(root, "apps", name);
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

  test("reclaims a live worktree's block into a lost registry", async () => {
    // .dev-ports.json is git-ignored, so it can vanish while the worktrees allocated from it live on. A
    // live worktree — one that still has its gitlink — must get its pinned block back, or the next feature
    // would be handed a block someone is already running on.
    const first = await sync(["api"]);
    await writeFile(join(worktreePath, ".git"), "gitdir: /somewhere/.git/worktrees/69-demo\n");
    await rm(join(mainRoot, ".dev-ports.json"));

    const otherWorktree = join(mainRoot, ".worktrees", "70-other");
    await mkdir(otherWorktree, { recursive: true });
    const other = await syncFeatureDevConfig({
      mainRoot,
      worktreePath: otherWorktree,
      branch: "feature/70-other",
      discoverWorkers: async () => workerTargets(otherWorktree, ["api"]),
    });

    const registry = JSON.parse(await readFile(join(mainRoot, ".dev-ports.json"), "utf8"));
    expect(registry["feature/69-demo"]).toEqual(first.block);
    expect(other.block.block).not.toBe(first.block.block);
  });

  test("never reclaims a destroyed feature's block back into the registry", async () => {
    // `pithy feature destroy` frees the block and prunes the worktree by dropping its gitlink — it never
    // recursively deletes the files (CLAUDE.md), so the config can linger. Treating that leftover as a live
    // claim re-registered a feature that no longer exists, holding its ports forever and pushing every
    // later feature to a higher base.
    const destroyed = await sync(["api"]);
    const registryPath = join(mainRoot, ".dev-ports.json");
    const registry = JSON.parse(await readFile(registryPath, "utf8"));
    delete registry["feature/69-demo"]; // what freePortBlock does.
    await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
    // The worktree is gone — no gitlink — but its .dev.config.json is still on disk.
    expect(await readDevConfig(devConfigPath(worktreePath))).not.toBeNull();

    const otherWorktree = join(mainRoot, ".worktrees", "70-other");
    await mkdir(otherWorktree, { recursive: true });
    await writeFile(join(otherWorktree, ".git"), "gitdir: /somewhere/.git/worktrees/70-other\n");
    const other = await syncFeatureDevConfig({
      mainRoot,
      worktreePath: otherWorktree,
      branch: "feature/70-other",
      discoverWorkers: async () => workerTargets(otherWorktree, ["api"]),
    });

    const after = JSON.parse(await readFile(registryPath, "utf8"));
    expect(after["feature/69-demo"]).toBeUndefined(); // stays freed
    // And the freed block is handed straight to the next feature.
    expect(other.block).toEqual(destroyed.block);
  });

  test("wires the worktree's and every worker's .dev.vars to the repo's shared file", async () => {
    await sync(["app"]);
    expect(await readFile(join(worktreePath, ".dev.vars"), "utf8")).toBe("SECRET=abc\n");
    // wrangler loads .dev.vars from each worker's own dir and never merges, so each apps/<name> is linked.
    expect(await readFile(join(worktreePath, "apps", "app", ".dev.vars"), "utf8")).toBe("SECRET=abc\n");
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
