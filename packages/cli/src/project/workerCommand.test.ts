import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NotFoundError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { devConfigPath, readDevConfig } from "../feature/devConfig";
import { addWorker, listWorkers, removeWorker } from "./workerCommand";
import type { WorkerTarget } from "./workers";

/** A discover-workers seam over the current apps/ dirs, so tests fix the set without real discovery. */
function discover(root: string, names: string[]): () => Promise<WorkerTarget[]> {
  return async () =>
    names.map((name) => ({
      name,
      dir: name === "app" ? root : join(root, "apps", name),
      dev: { autostart: true, readySignal: "Ready on https?://" },
      hasWrangler: true,
    }));
}

describe("addWorker", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-worker-add-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("in a plain checkout: scaffolds, skips port reconcile, reports no port", async () => {
    let installed = false;
    const report = await addWorker({
      projectDir: dir,
      name: "web",
      mainRoot: dir, // projectDir === mainRoot → not a feature worktree
      install: async () => {
        installed = true;
      },
      discoverWorkers: discover(dir, ["app", "web"]),
    });

    expect(installed).toBe(true);
    expect(report).toEqual({ name: "web", dir: join(dir, "apps", "web"), port: null, reconciled: false });
    await stat(join(dir, "apps", "web", "wrangler.jsonc")); // the scaffold landed
  });

  test("--skip-install does not run the workspace install", async () => {
    let installed = false;
    await addWorker({
      projectDir: dir,
      name: "web",
      mainRoot: dir,
      skipInstall: true,
      install: async () => {
        installed = true;
      },
      discoverWorkers: discover(dir, ["app", "web"]),
    });
    expect(installed).toBe(false);
  });

  test("degrades gracefully when the project is not a git repo (fresh init before git init)", async () => {
    // No mainRoot passed, and git fails — worker add must still scaffold, treating the dir as its own root.
    const report = await addWorker({
      projectDir: dir,
      name: "web",
      skipInstall: true,
      git: async () => {
        throw new Error("fatal: not a git repository");
      },
      discoverWorkers: discover(dir, ["app", "web"]),
    });
    expect(report).toEqual({ name: "web", dir: join(dir, "apps", "web"), port: null, reconciled: false });
    await stat(join(dir, "apps", "web", "wrangler.jsonc"));
  });

  test("in a feature worktree: reconciles .dev.config.json and pins a port", async () => {
    const mainRoot = await mkdtemp(join(tmpdir(), "pithy-main-"));
    const worktree = join(mainRoot, ".worktrees", "73-demo");
    await mkdir(worktree, { recursive: true });
    try {
      const report = await addWorker({
        projectDir: worktree,
        name: "web",
        mainRoot,
        branch: "feature/73-demo",
        skipInstall: true,
        discoverWorkers: discover(worktree, ["app", "web"]),
      });

      expect(report.reconciled).toBe(true);
      expect(report.port).toBeGreaterThanOrEqual(8787);

      const config = await readDevConfig(devConfigPath(worktree));
      expect(config?.workers.web?.port).toBe(report.port);
    } finally {
      await rm(mainRoot, { recursive: true, force: true });
    }
  });
});

describe("listWorkers", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-worker-list-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("reports autostart state and pinned port from .dev.config.json", async () => {
    await writeFile(
      devConfigPath(dir),
      `${JSON.stringify({
        version: 1,
        branch: "feature/73-demo",
        ports: { index: 0, base: 8787, size: 10 },
        workers: { app: { port: 8787, origin: "http://localhost:8787" } },
      })}\n`,
    );

    const workers = await listWorkers({
      projectDir: dir,
      discoverWorkers: discover(dir, ["app", "web"]),
    });

    expect(workers).toEqual([
      { name: "app", dir, autostart: true, hasWrangler: true, port: 8787 },
      { name: "web", dir: join(dir, "apps", "web"), autostart: true, hasWrangler: true, port: null },
    ]);
  });
});

describe("removeWorker", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-worker-remove-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("deletes apps/<name> in a plain checkout", async () => {
    await mkdir(join(dir, "apps", "web"), { recursive: true });
    await writeFile(join(dir, "apps", "web", "wrangler.jsonc"), "{}");

    const report = await removeWorker({
      projectDir: dir,
      name: "web",
      mainRoot: dir,
      discoverWorkers: discover(dir, ["app", "web"]),
    });

    expect(report).toEqual({ name: "web", dir: join(dir, "apps", "web"), reconciled: false });
    await expect(stat(join(dir, "apps", "web"))).rejects.toThrow();
  });

  test("removes a worker by the wrangler name that worker list showed, even when it differs from the directory", async () => {
    // apps/api holds a worker whose wrangler `name` is "my-service" — the name `worker list` prints.
    const apiDir = join(dir, "apps", "api");
    await mkdir(apiDir, { recursive: true });
    await writeFile(join(apiDir, "wrangler.jsonc"), JSON.stringify({ name: "my-service" }));
    const discoverRenamed = async () => [
      { name: "my-service", dir: apiDir, dev: { autostart: true, readySignal: "x" }, hasWrangler: true },
    ];

    const report = await removeWorker({
      projectDir: dir,
      name: "my-service",
      mainRoot: dir,
      discoverWorkers: discoverRenamed,
    });

    expect(report).toEqual({ name: "my-service", dir: apiDir, reconciled: false });
    await expect(stat(apiDir)).rejects.toThrow();
  });

  test("throws NotFoundError when the worker does not exist", async () => {
    await expect(
      removeWorker({ projectDir: dir, name: "ghost", mainRoot: dir, discoverWorkers: discover(dir, ["app"]) }),
    ).rejects.toThrow(NotFoundError);
  });
});
