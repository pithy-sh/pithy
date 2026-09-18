// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkPortsRegistry } from "../doctor/portsRegistry";
import { buildDevConfig, devConfigPath, writeDevConfig } from "./devConfig";
import { BASE_PORT, BLOCK_SIZE, type PortsRegistry, type RepoPortBlocks } from "./ports";
import { pruneFeatureBlocks } from "./prune";

/**
 * Every test here runs against a real repository with real worktrees (#637). The predicate's whole input
 * is `git worktree list --porcelain`, and a mocked listing would assert the parser against the shape the
 * test author believed git prints — which is the belief the test exists to check.
 */
describe("pruneFeatureBlocks", () => {
  let dir: string;
  let registryPath: string;
  /** The main checkout, canonical — the registry key git reports for it. */
  let root: string;

  const git = (args: string[], cwd = root): string =>
    execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" }).trim();

  const block = (index: number): RepoPortBlocks[string] => ({
    block: index,
    base: BASE_PORT + index * BLOCK_SIZE,
    size: BLOCK_SIZE,
  });

  const writeRegistry = async (value: PortsRegistry): Promise<string> => {
    const text = `${JSON.stringify(value, null, 2)}\n`;
    await writeFile(registryPath, text, "utf8");
    return text;
  };

  const readRegistry = async (): Promise<PortsRegistry> =>
    JSON.parse(await readFile(registryPath, "utf8")) as PortsRegistry;

  /** `pithy feature create`'s shape: `.worktrees/<issue>-<slug>` on `feature/<issue>-<slug>`. */
  const addWorktree = (name: string, branch: string): string => {
    const path = join(root, ".worktrees", name);
    git(["worktree", "add", "-q", "-b", branch, path]);
    return path;
  };

  /**
   * Remove a worktree the way `feature destroy` does and the way an adopter's own teardown does — drop the
   * gitlink, then prune the registration. The files stay on disk and the branch survives, which is
   * exactly the state that stranded the dashboard's five blocks.
   */
  const removeWorktree = async (path: string): Promise<void> => {
    await unlink(join(path, ".git"));
    git(["worktree", "prune"]);
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-prune-"));
    registryPath = join(dir, "config", "dev-ports.json");
    await mkdir(join(dir, "config"));
    await mkdir(join(dir, "repo"));
    root = await realpath(join(dir, "repo"));
    git(["init", "-q"]);
    git(["config", "user.email", "t@t.dev"]);
    git(["config", "user.name", "T"]);
    git(["commit", "-q", "--allow-empty", "-m", "init"]);
    git(["branch", "-M", "main"]);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("frees only the block whose worktree is gone, not main's and not a live worktree's", async () => {
    addWorktree("1-live", "feature/1-live");
    await removeWorktree(addWorktree("2-gone", "feature/2-gone"));
    await writeRegistry({ [root]: { main: block(0), "feature/1-live": block(1), "feature/2-gone": block(2) } });

    const report = await pruneFeatureBlocks({ cwd: root, registryPath, dryRun: false });

    expect(report.freedBlocks).toEqual([{ branch: "feature/2-gone", ...block(2) }]);
    expect(report.root).toBe(root);
    expect(report.dryRun).toBe(false);
    expect(await readRegistry()).toEqual({ [root]: { main: block(0), "feature/1-live": block(1) } });
  });

  it("keeps a feature branch checked out in the main checkout", async () => {
    // The main checkout is a worktree like any other, and nothing says it has to be on `main`.
    const live = addWorktree("1-live", "feature/1-live");
    git(["switch", "-q", "-c", "feature/3-here"]);
    await writeRegistry({ [root]: { "feature/1-live": block(1), "feature/3-here": block(3) } });

    // Run from the other worktree, so the main checkout's listing is the only thing vouching for it.
    const report = await pruneFeatureBlocks({ cwd: live, registryPath, dryRun: false });

    expect(report.freedBlocks).toEqual([]);
    expect(await readRegistry()).toEqual({ [root]: { "feature/1-live": block(1), "feature/3-here": block(3) } });
  });

  it("never frees the checkout it runs from, even when its key looks unused", async () => {
    // Detached HEAD, reached through a symlink. `pithy dev` keys a checkout off a branch as
    // `local:<the cwd it ran from>`, and the listing spells the same checkout by its real path — so the
    // only thing standing between this block and the sweep is the rule that the caller's own checkout is
    // never freed. The same rule as `pruneDeadRoots`'s `keep`.
    const link = join(dir, "link");
    await symlink(root, link, "dir");
    git(["switch", "-q", "--detach"]);
    await writeRegistry({ [root]: { [`local:${link}`]: block(4) } });

    const report = await pruneFeatureBlocks({ cwd: link, registryPath, dryRun: false });

    expect(report.freedBlocks).toEqual([]);
    expect(await readRegistry()).toEqual({ [root]: { [`local:${link}`]: block(4) } });
  });

  it("never frees the block the checkout it runs from has pinned, whatever it is on now", async () => {
    // `pithy dev` keys a checkout with a `.dev.config.json` off the branch that file pins, not off HEAD —
    // so a worktree that has since been detached still binds `feature/5-pinned`'s block.
    const wt = addWorktree("5-pinned", "feature/5-pinned");
    await writeDevConfig(
      devConfigPath(wt),
      buildDevConfig({ branch: "feature/5-pinned", block: block(5), workers: [], previous: null }),
    );
    git(["switch", "-q", "--detach"], wt);
    await writeRegistry({ [root]: { main: block(0), "feature/5-pinned": block(5) } });

    const report = await pruneFeatureBlocks({ cwd: wt, registryPath, dryRun: false });

    expect(report.freedBlocks).toEqual([]);
    expect(await readRegistry()).toEqual({ [root]: { main: block(0), "feature/5-pinned": block(5) } });
  });

  it("keeps the block another worktree's .dev.config.json pins, run from elsewhere", async () => {
    // The pinned key is live wherever prune runs from, not only from inside that worktree: its
    // `pithy dev` binds the pinned block whatever HEAD says, so freeing it hands a live feature's ports out.
    const wt = addWorktree("5-pinned", "feature/5-pinned");
    await writeDevConfig(
      devConfigPath(wt),
      buildDevConfig({ branch: "feature/5-pinned", block: block(5), workers: [], previous: null }),
    );
    git(["switch", "-q", "--detach"], wt);
    await writeRegistry({ [root]: { main: block(0), "feature/5-pinned": block(5) } });

    const report = await pruneFeatureBlocks({ cwd: root, registryPath, dryRun: false });

    expect(report.freedBlocks).toEqual([]);
  });

  it("doctor marks nothing where there is no repository to list", async () => {
    // `registryRootFor` falls back to the project's own path off a repository, so doctor does have a root
    // there — and a listing nobody could take must not read as a checkout with no live branches.
    const plain = await realpath(await mkdtemp(join(dir, "plain-")));
    await writeRegistry({ [plain]: { [`local:${plain}`]: block(0), "feature/1-x": block(1) } });

    const check = await checkPortsRegistry(plain, {
      env: { PITHY_CONFIG_DIR: join(dir, "config") },
      platform: "linux",
    });

    expect(check.root).toBe(plain);
    expect(check.entries.map((entry) => [entry.branch, entry.own, entry.orphaned])).toEqual([
      [`local:${plain}`, true, false],
      ["feature/1-x", true, false],
    ]);
  });

  it("keeps a detached worktree's own local: key", async () => {
    const wt = addWorktree("6-detached", "feature/6-detached");
    git(["switch", "-q", "--detach"], wt);
    await writeRegistry({ [root]: { main: block(0), [`local:${wt}`]: block(6), "feature/6-detached": block(7) } });

    const report = await pruneFeatureBlocks({ cwd: root, registryPath, dryRun: false });

    // The branch is checked out nowhere now; the detached checkout is still one `pithy dev` runs in.
    expect(report.freedBlocks.map((entry) => entry.branch)).toEqual(["feature/6-detached"]);
  });

  it("--dry-run lists what it would free and leaves the registry byte-identical", async () => {
    await removeWorktree(addWorktree("2-gone", "feature/2-gone"));
    const before = await writeRegistry({ [root]: { main: block(0), "feature/2-gone": block(2) } });

    const report = await pruneFeatureBlocks({ cwd: root, registryPath, dryRun: true });

    expect(report.dryRun).toBe(true);
    expect(report.freedBlocks).toEqual([{ branch: "feature/2-gone", ...block(2) }]);
    expect(await readFile(registryPath, "utf8")).toBe(before);
    // Not even the lock file: a dry run reads, and a read takes no lock.
    await expect(stat(`${registryPath}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never touches another checkout's blocks", async () => {
    const other = join(dir, "other-app");
    await mkdir(other);
    await removeWorktree(addWorktree("2-gone", "feature/2-gone"));
    await writeRegistry({
      [root]: { main: block(0), "feature/2-gone": block(2) },
      [other]: { main: block(8), "feature/9-elsewhere": block(9) },
    });

    await pruneFeatureBlocks({ cwd: root, registryPath, dryRun: false });

    expect((await readRegistry())[other]).toEqual({ main: block(8), "feature/9-elsewhere": block(9) });
  });

  it("drops the checkout's key once nothing under it is left", async () => {
    const wt = addWorktree("2-gone", "feature/2-gone");
    await removeWorktree(wt);
    git(["switch", "-q", "--detach"]);
    await writeRegistry({ [root]: { "feature/2-gone": block(2) } });

    await pruneFeatureBlocks({ cwd: root, registryPath, dryRun: false });

    expect(await readRegistry()).toEqual({});
  });

  it("refuses outside a git repository, and writes nothing", async () => {
    // A registry shared across projects may hold a root that is not a repository. With no listing to ask,
    // every block would look unused — so no listing is a refusal, never an empty set of live branches.
    const plain = join(dir, "plain");
    await mkdir(plain);
    const before = await writeRegistry({ [plain]: { [`local:${plain}`]: block(0) } });

    await expect(pruneFeatureBlocks({ cwd: plain, registryPath, dryRun: false })).rejects.toSatisfy(
      (error: PithyError) => {
        expect(error.payload.action).toMatch(/git repository/i);
        return true;
      },
    );
    expect(await readFile(registryPath, "utf8")).toBe(before);
  });

  it("with no registry at all, frees nothing and creates nothing", async () => {
    const report = await pruneFeatureBlocks({ cwd: root, registryPath, dryRun: true });
    expect(report.freedBlocks).toEqual([]);
    await expect(stat(registryPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  /**
   * **Doctor and the command cannot disagree** (#637). Doctor's listing marks a feature block *orphaned*
   * and names `pithy feature prune` as the action; the promise in that line is that running the command
   * frees exactly those rows. So every scenario above is asked of both, from the same checkout, and the
   * two answers must be the same set.
   */
  it("doctor marks exactly the blocks the command frees, from every checkout", async () => {
    const live = addWorktree("1-live", "feature/1-live");
    await removeWorktree(addWorktree("2-gone", "feature/2-gone"));
    const pinned = addWorktree("5-pinned", "feature/5-pinned");
    await writeDevConfig(
      devConfigPath(pinned),
      buildDevConfig({ branch: "feature/5-pinned", block: block(5), workers: [], previous: null }),
    );
    git(["switch", "-q", "--detach"], pinned);
    const other = join(dir, "other-app");
    await mkdir(other);
    await writeRegistry({
      [root]: {
        main: block(0),
        "feature/1-live": block(1),
        "feature/2-gone": block(2),
        "feature/5-pinned": block(5),
        [`local:${root}/nowhere`]: block(6),
      },
      [other]: { "feature/9-elsewhere": block(9) },
    });
    const configDir = join(dir, "config");

    for (const cwd of [root, live, pinned]) {
      const report = await pruneFeatureBlocks({ cwd, registryPath, dryRun: true });
      const check = await checkPortsRegistry(cwd, { env: { PITHY_CONFIG_DIR: configDir }, platform: "linux" });
      const flagged = check.entries.filter((entry) => entry.orphaned).map((entry) => entry.branch);

      expect(flagged.sort()).toEqual(report.freedBlocks.map((entry) => entry.branch).sort());
      // And the answer is not vacuous: the gone worktree is always among them.
      expect(flagged).toContain("feature/2-gone");
    }
  });
});
