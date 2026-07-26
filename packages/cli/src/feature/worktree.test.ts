import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createWorktree, featureNames, mainRepoRoot, teardownWorktree } from "./worktree";

const run = promisify(execFile);

describe("worktree (real git)", () => {
  let repo: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    repo = await mkdtemp(join(tmpdir(), "pithy-worktree-"));
    await run("git", ["init"], { cwd: repo });
    await run("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    await run("git", ["config", "user.name", "Test"], { cwd: repo });
    await writeFile(join(repo, "README.md"), "hello\n");
    await run("git", ["add", "-A"], { cwd: repo });
    await run("git", ["commit", "-m", "init"], { cwd: repo });
    await run("git", ["branch", "-M", "main"], { cwd: repo });
    process.chdir(repo);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(repo, { recursive: true, force: true });
  });

  test("createWorktree creates the branch and worktree, and is idempotent", async () => {
    const first = await createWorktree({ issue: "77", slug: "demo" });
    expect(first.branch).toBe("feature/77-demo");
    expect(first.created).toBe(true);

    const names = featureNames("77", "demo", await mainRepoRoot());
    expect(first.wtPath).toBe(names.wtPath);
    expect(existsSync(first.wtPath)).toBe(true);

    const list = await run("git", ["worktree", "list"], { cwd: repo });
    expect(list.stdout).toContain(first.wtPath);

    const second = await createWorktree({ issue: "77", slug: "demo" });
    expect(second.created).toBe(false);
    expect(second.wtPath).toBe(first.wtPath);
  });

  test("teardownWorktree prunes the worktree and deletes the merged branch, and is idempotent", async () => {
    const created = await createWorktree({ issue: "77", slug: "demo" });

    const first = await teardownWorktree({ issue: "77", slug: "demo" });
    expect(first.pruned).toBe(true);
    expect(first.branchDeleted).toBe(true);

    const list = await run("git", ["worktree", "list"], { cwd: repo });
    expect(list.stdout).not.toContain(created.wtPath);
    expect(existsSync(join(created.wtPath, ".git"))).toBe(false);

    const branches = await run("git", ["branch", "--list", "feature/77-demo"], { cwd: repo });
    expect(branches.stdout.trim()).toBe("");

    const second = await teardownWorktree({ issue: "77", slug: "demo" });
    expect(second.pruned).toBe(false);
  });

  test("recreating after teardown fails with an actionable PithyError, not a raw git error", async () => {
    const created = await createWorktree({ issue: "77", slug: "demo" });
    await teardownWorktree({ issue: "77", slug: "demo" });

    // Teardown deliberately left the files behind (CLAUDE.md forbids recursive delete on Linux).
    expect(existsSync(created.wtPath)).toBe(true);
    expect(existsSync(join(created.wtPath, ".git"))).toBe(false);

    const failure = await createWorktree({ issue: "77", slug: "demo" }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PithyError);
    const error = failure as PithyError;
    expect(error.payload.message).toContain(created.wtPath);
    expect(error.payload.action).toBeTruthy();
    expect(error.payload.action).not.toMatch(/fatal:/);

    // The leftover directory is untouched — no recursive delete happened on its behalf.
    expect(existsSync(created.wtPath)).toBe(true);
  });
});
