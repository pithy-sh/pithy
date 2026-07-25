import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createFeature } from "./create";
import { destroyFeature } from "./destroy";
import { devConfigPath, readDevConfig } from "./devConfig";
import { BASE_PORT } from "./ports";
import type { FeatureProvisioners } from "./provision";
import { defaultGit, type GitRunner } from "./worktree";

/** Provisioners that own nothing — the local-only round-trip needs no real Cloudflare. */
const emptyProvisioners: FeatureProvisioners = {
  d1: { find: async () => null, create: async () => ({ id: "x" }), delete: async () => {} },
  kv: { find: async () => null, create: async () => ({ id: "x" }), delete: async () => {} },
  r2: { find: async () => null, create: async () => ({ id: "x" }), delete: async () => {} },
};

/** A trivial capability — create only needs it to hand to the (injected) migrate/seed seams. */
function appCapability() {
  return defineCapability({ name: "app", requiredBindings: [] });
}

describe("createFeature → destroyFeature round-trip", () => {
  let repo: string;
  let git: GitRunner;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "pithy-feature-repo-"));
    const g = (args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
    g(["init", "-q"]);
    g(["config", "user.email", "t@t.dev"]);
    g(["config", "user.name", "T"]);
    g(["config", "commit.gpgsign", "false"]);
    await writeFile(join(repo, "wrangler.jsonc"), '{\n  "name": "app"\n}\n');
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "init"]);
    g(["branch", "-M", "main"]);
    // Bind the default runner to the repo so mainRepoRoot (called with no cwd) resolves it.
    git = (args, cwd) => defaultGit(args, cwd ?? repo);
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  test("create builds the worktree, pins ports, wires .dev.vars, migrates + seeds; destroy reverses it", async () => {
    const migrated: string[] = [];
    const seeded: string[] = [];
    const registryPath = join(repo, ".dev-ports.json");

    const createReport = await createFeature({
      projectDir: repo,
      issue: "77",
      slug: "demo",
      capabilities: [appCapability()],
      skipInstall: true,
      git,
      migrate: async ({ projectDir }) => void migrated.push(projectDir),
      seed: async ({ projectDir }) => void seeded.push(projectDir),
    });

    // Worktree + branch created.
    expect(createReport.branch).toBe("feature/77-demo");
    expect(createReport.created).toBe(true);
    await expect(stat(createReport.worktree)).resolves.toBeTruthy();

    // A port block was reserved and the app worker's port pinned from it.
    expect(createReport.dev.workers).toEqual({ app: { port: BASE_PORT, origin: `http://localhost:${BASE_PORT}` } });
    const registry = JSON.parse(await readFile(registryPath, "utf8"));
    expect(registry["feature/77-demo"]).toMatchObject({ block: 0, base: BASE_PORT });

    // The pinned ports are persisted in the worktree's own .dev.config.json, fixed for the feature's life.
    const devConfig = await readDevConfig(devConfigPath(createReport.worktree));
    expect(devConfig).toMatchObject({
      branch: "feature/77-demo",
      ports: { index: 0, base: BASE_PORT },
      workers: { app: { port: BASE_PORT } },
    });

    // Local migrate + seed ran against the worktree.
    expect(migrated).toEqual([createReport.worktree]);
    expect(seeded).toEqual([createReport.worktree]);

    // Destroy reverses everything: frees the port block and prunes the worktree.
    const destroyReport = await destroyFeature({
      projectDir: createReport.worktree,
      identity: { project: "app", issue: "77", slug: "demo" },
      capabilities: [appCapability()],
      provisioners: emptyProvisioners,
      git,
      registryPath,
    });

    expect(destroyReport.deleted).toEqual([]);
    expect(destroyReport.remote).toBe(true);
    expect(destroyReport.portsFreed).toBe(true);
    expect(destroyReport.worktreePruned).toBe(true);

    const afterRegistry = JSON.parse(await readFile(registryPath, "utf8"));
    expect(afterRegistry["feature/77-demo"]).toBeUndefined();
    // The worktree is no longer registered.
    expect(await defaultGit(["worktree", "list", "--porcelain"], repo)).not.toContain(createReport.worktree);
  });

  test("create is idempotent: a re-run reuses the worktree and keeps its port block", async () => {
    const opts = {
      projectDir: repo,
      issue: "77",
      slug: "demo",
      capabilities: [appCapability()],
      skipInstall: true,
      git,
      migrate: async () => {},
      seed: async () => {},
    };
    const first = await createFeature(opts);
    expect(first.created).toBe(true);

    const second = await createFeature(opts);
    expect(second.created).toBe(false);
    // The pinned ports are stable across re-runs — a feature's addresses never move under it.
    expect(second.dev.workers).toEqual(first.dev.workers);
  });

  test("two features get non-overlapping port blocks, so both can run at once", async () => {
    const common = { projectDir: repo, capabilities: [appCapability()], skipInstall: true, git };
    const noop = { migrate: async () => {}, seed: async () => {} };

    const a = await createFeature({ ...common, ...noop, issue: "77", slug: "demo" });
    const b = await createFeature({ ...common, ...noop, issue: "78", slug: "other" });

    expect(a.dev.ports.index).not.toBe(b.dev.ports.index);
    const aPorts = Object.values(a.dev.workers).map((w) => w.port);
    const bPorts = Object.values(b.dev.workers).map((w) => w.port);
    // No port is shared between the two features — no startup race is even possible.
    expect(aPorts.some((port) => bPorts.includes(port))).toBe(false);
  });

  test("destroy is idempotent: running it with no worktree and no credentials exits cleanly", async () => {
    const report = await destroyFeature({
      projectDir: repo,
      identity: { project: "app", issue: "88", slug: "gone" },
      capabilities: [],
      git,
      registryPath: join(repo, ".dev-ports.json"),
    });
    expect(report.deleted).toEqual([]);
    expect(report.remote).toBe(false); // no provisioners passed → remote skipped
    expect(report.worktreePruned).toBe(false); // nothing to prune
  });
});
