// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ResourceProvisioners } from "../provision/resources";
import { createFeature } from "./create";
import { destroyFeature } from "./destroy";
import { devConfigPath, readDevConfig } from "./devConfig";
import { BASE_PORT } from "./ports";
import { defaultGit, type GitRunner } from "./worktree";

/** Provisioners that own nothing — the local-only round-trip needs no real Cloudflare. */
const emptyProvisioners: ResourceProvisioners = {
  d1: { find: async () => null, create: async () => ({ id: "x" }), delete: async () => {} },
  kv: { find: async () => null, create: async () => ({ id: "x" }), delete: async () => {} },
  r2: { find: async () => null, create: async () => ({ id: "x" }), delete: async () => {} },
};

/** A trivial capability — destroy recomputes this feature's resource names from its bindings. */
function appCapability() {
  return defineCapability({ name: "app", requiredBindings: [] });
}

describe("createFeature → destroyFeature round-trip", () => {
  let repo: string;
  let git: GitRunner;
  /**
   * The machine's port registry, injected per test (#435).
   *
   * It lives in the Pithy config directory now, not under the checkout — so without a seam every test in
   * this file would share one file and contaminate the next one's block indices, and a real run would
   * write the operator's own.
   */
  let registryPath: string;
  let registryDir: string;

  beforeEach(async () => {
    registryDir = await mkdtemp(join(tmpdir(), "pithy-feature-ports-"));
    registryPath = join(registryDir, "dev-ports.json");
    repo = await mkdtemp(join(tmpdir(), "pithy-feature-repo-"));
    const g = (args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
    g(["init", "-q"]);
    g(["config", "user.email", "t@t.dev"]);
    g(["config", "user.name", "T"]);
    g(["config", "commit.gpgsign", "false"]);
    // One Worker in apps/app, owning its own wrangler.jsonc — apps/ IS the registry, there is no root Worker.
    await mkdir(join(repo, "apps", "app"), { recursive: true });
    await writeFile(join(repo, "apps", "app", "wrangler.jsonc"), '{\n  "name": "app"\n}\n');
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "init"]);
    g(["branch", "-M", "main"]);
    // Bind the default runner to the repo so mainRepoRoot (called with no cwd) resolves it.
    git = (args, cwd) => defaultGit(args, cwd ?? repo);
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
    await rm(registryDir, { recursive: true, force: true });
  });

  test("create builds the worktree, pins ports, wires .dev.vars, migrates + seeds; destroy reverses it", async () => {
    const migrated: string[] = [];
    const seeded: string[] = [];
    const createReport = await createFeature({
      projectDir: repo,
      issue: "77",
      slug: "demo",
      skipInstall: true,
      git,
      registryPath,
      migrate: async ({ projectDir }) => void migrated.push(projectDir),
      seed: async ({ projectDir }) => void seeded.push(projectDir),
    });

    // Worktree + branch created.
    expect(createReport.branch).toBe("feature/77-demo");
    expect(createReport.worktreeCreated).toBe(true);
    await expect(stat(createReport.worktree)).resolves.toBeTruthy();

    // A port block was reserved and the app worker's port pinned from it.
    expect(createReport.dev.workers).toEqual({ app: { port: BASE_PORT, origin: `http://localhost:${BASE_PORT}` } });
    // One checkout, so one key — and reading it back rather than recomposing it is what makes the
    // assertion after destroy a real statement about create and destroy agreeing on the key (#435).
    const registry = JSON.parse(await readFile(registryPath, "utf8"));
    expect(Object.keys(registry)).toHaveLength(1);
    const rootKey = Object.keys(registry)[0] as string;
    expect(registry[rootKey]["feature/77-demo"]).toMatchObject({ block: 0, base: BASE_PORT });

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

    // **And the report does not say so (#231).** Both steps throw on failure, so a report existing at all
    // is the proof they ran; a `migrated: true, seeded: true` pair beside it is a constant dressed as a
    // fact, and the only branch a consumer could write on it is one that can never fire. `feature sync`
    // has a real answer to give here because `--skip-data` can make it `false`; create has none.
    expect(Object.keys(createReport).sort()).toEqual(["branch", "command", "dev", "worktree", "worktreeCreated"]);

    // Destroy reverses everything: frees the port block and prunes the worktree.
    const destroyReport = await destroyFeature({
      projectDir: createReport.worktree,
      identity: { project: "app", issue: "77", slug: "demo" },
      capabilities: [appCapability()],
      env: "feature",
      provisioners: emptyProvisioners,
      git,
      registryPath,
    });

    expect(destroyReport.deleted).toEqual([]);
    expect(destroyReport.remote).toBe(true);
    expect(destroyReport.portsFreed).toBe(true);
    expect(destroyReport.worktreePruned).toBe(true);

    // Empty, not merely missing that branch: `create` reserves under the root `git worktree list` reports
    // and `destroy` frees under the one `git rev-parse --git-common-dir` gives. Two derivations of one
    // quantity, and a disagreement is a free that no-ops while still reporting `portsFreed: true`. An
    // emptied registry is the only assertion that catches it.
    const afterRegistry = JSON.parse(await readFile(registryPath, "utf8"));
    expect(afterRegistry).toEqual({});
    // The worktree is no longer registered.
    expect(await defaultGit(["worktree", "list", "--porcelain"], repo)).not.toContain(createReport.worktree);
  });

  test("create is idempotent: a re-run reuses the worktree and keeps its port block", async () => {
    const opts = {
      projectDir: repo,
      issue: "77",
      slug: "demo",
      skipInstall: true,
      git,
      registryPath,
      migrate: async () => {},
      seed: async () => {},
    };
    const first = await createFeature(opts);
    expect(first.worktreeCreated).toBe(true);

    const second = await createFeature(opts);
    expect(second.worktreeCreated).toBe(false);
    // The pinned ports are stable across re-runs — a feature's addresses never move under it.
    expect(second.dev.workers).toEqual(first.dev.workers);
  });

  test("two features get non-overlapping port blocks, so both can run at once", async () => {
    const common = { projectDir: repo, skipInstall: true, git, registryPath };
    const noop = { migrate: async () => {}, seed: async () => {} };

    const a = await createFeature({ ...common, ...noop, issue: "77", slug: "demo" });
    const b = await createFeature({ ...common, ...noop, issue: "78", slug: "other" });

    expect(a.dev.ports.index).not.toBe(b.dev.ports.index);
    const aPorts = Object.values(a.dev.workers).map((w) => w.port);
    const bPorts = Object.values(b.dev.workers).map((w) => w.port);
    // No port is shared between the two features — no startup race is even possible.
    expect(aPorts.some((port) => bPorts.includes(port))).toBe(false);
  });

  test("destroy leaves no port claim behind: the next feature gets the freed block, not a higher one", async () => {
    const noop = { migrate: async () => {}, seed: async () => {} };
    const first = await createFeature({
      projectDir: repo,
      issue: "77",
      slug: "demo",
      skipInstall: true,
      git,
      registryPath,
      ...noop,
    });
    expect(first.dev.ports.index).toBe(0);

    await destroyFeature({
      projectDir: first.worktree,
      identity: { project: "app", issue: "77", slug: "demo" },
      capabilities: [appCapability()],
      env: "feature",
      git,
      registryPath,
    });

    // Teardown leaves the worktree's files on disk by design, but `.dev.config.json` is a port claim —
    // the next create rebuilds the registry from the claims it finds, so a surviving one would hand the
    // destroyed feature its block straight back, permanently.
    await expect(readDevConfig(devConfigPath(first.worktree))).resolves.toBeNull();

    const second = await createFeature({
      projectDir: repo,
      issue: "78",
      slug: "next",
      skipInstall: true,
      git,
      registryPath,
      ...noop,
    });

    expect(second.dev.ports.index).toBe(0); // the freed block, reused
    const registry = JSON.parse(await readFile(registryPath, "utf8"));
    expect(Object.values(registry).flatMap((branches) => Object.keys(branches as object))).not.toContain(
      "feature/77-demo",
    );
    expect(Object.values(registry).flatMap((branches) => Object.keys(branches as object))).toEqual(["feature/78-next"]);
  });

  test("destroy is idempotent: running it with no worktree and no credentials exits cleanly", async () => {
    const report = await destroyFeature({
      projectDir: repo,
      identity: { project: "app", issue: "88", slug: "gone" },
      capabilities: [],
      env: "feature",
      git,
      registryPath,
    });
    expect(report.deleted).toEqual([]);
    expect(report.remote).toBe(false); // no provisioners passed → remote skipped
    expect(report.worktreePruned).toBe(false); // nothing to prune
  });
});
