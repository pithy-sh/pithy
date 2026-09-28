// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { removeTempDir } from "../test-utils/tempRepo";
import { destroyFeature } from "./destroy";
import { devConfigPath } from "./devConfig";
import type { GitRunner } from "./worktree";

/**
 * **A teardown that has nothing local to do says so — #660.**
 *
 * `pithy feature destroy --branch` is run by a merged pull request's runner, which has no worktree and no
 * port-registry entry: both are machine-local, and the machine is a fresh container. The local half must
 * therefore be a truthful no-op rather than a failure — and truthful is the operative word, because
 * `portsFreed` was the literal `true` whatever the registry held.
 *
 * That literal is the shape `#435` warned about from the other side: *a free that no-ops while still
 * reporting `portsFreed: true`, over a block that leaks forever*. There it was caused by two spellings of
 * the registry key; the report said `true` either way, so the key bug could only be found by reading the
 * registry. The report answers from the write now.
 */

/**
 * A git runner for a checkout holding no feature worktree and no feature branch.
 *
 * `worktree list` answers the root and nothing else, so nothing is registered at the feature's path; every
 * other query **throws**, which is what real git does when `rev-parse --verify` is asked for a ref that is
 * not there. A stub that answered `""` would make `gitTry` read every absent ref as present and report a
 * branch deleted that never existed — the report this file is about.
 */
function gitWithNoWorktrees(root: string): GitRunner {
  return async (args) => {
    if (args[0] === "worktree" && args[1] === "list") return `worktree ${root}\n`;
    throw new Error(`git ${args.join(" ")} failed`);
  };
}

/** A registry holding one block for one branch under one root — what a developer's machine has. */
async function registryHolding(root: string, branch: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pithy-destroy-registry-"));
  const path = join(dir, "dev-ports.json");
  await writeFile(path, `${JSON.stringify({ [root]: { [branch]: { block: 0, base: 8787, size: 20 } } })}\n`);
  return path;
}

describe("the local half of a teardown reports what it did — #660", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    for (const dir of dirs.splice(0)) await removeTempDir(dir);
  });

  /** A checkout that is not a feature worktree — a CI runner's, or somebody's main. */
  async function checkout(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "pithy-destroy-"));
    dirs.push(dir);
    return dir;
  }

  test("**with no worktree and no port block, nothing is claimed**", async () => {
    const root = await checkout();
    const registryPath = join(await checkout(), "dev-ports.json");

    const report = await destroyFeature({
      projectDir: root,
      identity: { project: "replay", issue: "12", slug: "x" },
      capabilities: [],
      workers: [],
      env: "feature",
      git: gitWithNoWorktrees(root),
      registryPath,
      root,
      inWorktree: false,
    });

    expect(report).toEqual({
      command: "feature.destroy",
      deleted: [],
      remote: false,
      portsFreed: false,
      worktreePruned: false,
      branchDeleted: false,
    });
  });

  test("a block that was there is freed, and reported freed", async () => {
    const root = await checkout();
    const registryPath = await registryHolding(root, "feature/12-x");
    dirs.push(registryPath);

    const report = await destroyFeature({
      projectDir: root,
      identity: { project: "replay", issue: "12", slug: "x" },
      capabilities: [],
      workers: [],
      env: "feature",
      git: gitWithNoWorktrees(root),
      registryPath,
      root,
      inWorktree: false,
    });

    expect(report.portsFreed).toBe(true);
  });

  /**
   * **`.dev.config.json` is the feature worktree's port claim, and `--branch` is not run from one.**
   *
   * Teardown removes that file so a later `feature create` cannot hand the block straight back. On the
   * inferred path the cwd *is* the worktree, so removing it there is removing the feature's own claim.
   * Under `--branch` the cwd is some other checkout — a runner's, or a developer's main — whose
   * `.dev.config.json` belongs to a different branch entirely and is a live `pithy dev` reservation.
   */
  test("the checkout's own dev config is not this feature's, and is left alone", async () => {
    const root = await checkout();
    await writeFile(devConfigPath(root), `${JSON.stringify({ version: 1, branch: "main" })}\n`);
    const registryPath = join(await checkout(), "dev-ports.json");

    await destroyFeature({
      projectDir: root,
      identity: { project: "replay", issue: "12", slug: "x" },
      capabilities: [],
      workers: [],
      env: "feature",
      git: gitWithNoWorktrees(root),
      registryPath,
      root,
      inWorktree: false,
    });

    expect(existsSync(devConfigPath(root))).toBe(true);
  });

  /** The inferred path is unchanged: standing in the worktree, its own claim still goes. */
  test("standing in the feature's worktree, its dev config still goes", async () => {
    const root = await checkout();
    const worktree = join(root, ".worktrees", "12-x");
    await mkdir(worktree, { recursive: true });
    await writeFile(devConfigPath(worktree), `${JSON.stringify({ version: 1, branch: "feature/12-x" })}\n`);
    const registryPath = join(await checkout(), "dev-ports.json");

    await destroyFeature({
      projectDir: worktree,
      identity: { project: "replay", issue: "12", slug: "x" },
      capabilities: [],
      workers: [],
      env: "feature",
      git: gitWithNoWorktrees(root),
      registryPath,
      root,
    });

    expect(existsSync(devConfigPath(worktree))).toBe(false);
  });
});
