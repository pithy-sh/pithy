// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { GIT_NO_MAINTENANCE, removeTempDir } from "../test-utils/tempRepo";
import { createWorktree, featureNames, mainRepoRoot, teardownWorktree } from "./worktree";

const run = promisify(execFile);

describe("worktree (real git)", () => {
  let repo: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    repo = await mkdtemp(join(tmpdir(), "pithy-worktree-"));
    await run("git", [...GIT_NO_MAINTENANCE, "init"], { cwd: repo });
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
    await removeTempDir(repo);
  });

  test("**a fresh branch is cut from local `main`, not from `origin/main`** — #454", async () => {
    /*
      The defect this replaces. `baseRef` preferred `refs/remotes/origin/main` whenever it existed, so a
      feature cut on a repository with unpushed work started *before* that work. On `pithy-sh/dashboard`
      that was 159 commits: the worktree's `apps/board/pithy.config.ts` predated a field the current kit
      requires, and `feature create` failed on a config error that said nothing about the base.

      The silent case is the one that matters. A project whose old config still parses gets no error at
      all — just a branch rooted in the past, found at merge.
    */
    const origin = await mkdtemp(join(tmpdir(), "pithy-worktree-origin-"));
    await run("git", [...GIT_NO_MAINTENANCE, "init", "--bare"], { cwd: origin });
    await run("git", ["remote", "add", "origin", origin], { cwd: repo });
    await run("git", ["push", "-u", "origin", "main"], { cwd: repo });

    // One commit that exists locally and has not been pushed. This is the whole scenario.
    await writeFile(join(repo, "LOCAL.md"), "unpushed\n");
    await run("git", ["add", "-A"], { cwd: repo });
    await run("git", ["commit", "-m", "local only"], { cwd: repo });
    const local = (await run("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
    const pushed = (await run("git", ["rev-parse", "origin/main"], { cwd: repo })).stdout.trim();
    expect(local).not.toBe(pushed);

    const made = await createWorktree({ issue: "454", slug: "base" });
    const cut = (await run("git", ["rev-parse", "HEAD"], { cwd: made.wtPath })).stdout.trim();
    expect(cut).toBe(local);
    // And the file that only exists locally is in the worktree, which is the fact an operator would notice.
    expect(existsSync(join(made.wtPath, "LOCAL.md"))).toBe(true);

    await removeTempDir(origin);
  });

  test("and it still cuts from HEAD when there is no local `main`", async () => {
    // A repository whose trunk is named something else, or a detached checkout. The old code fell back to
    // HEAD only when `origin/main` was absent; the fallback has to survive the change.
    await run("git", ["branch", "-M", "trunk"], { cwd: repo });
    const head = (await run("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
    const made = await createWorktree({ issue: "454", slug: "no-main" });
    expect((await run("git", ["rev-parse", "HEAD"], { cwd: made.wtPath })).stdout.trim()).toBe(head);
  });

  test("**a stale local `main` never beats the repository's real trunk** — review of #454", async () => {
    /*
      The regression the first fix introduced. Preferring `refs/heads/main` unconditionally meant a
      repository whose trunk is `master` — and which therefore has no `origin/main` — went from falling
      through to `HEAD` (right) to cutting from whatever stale `main` a rename left behind (wrong), with
      no warning, which is #454 again in a different repo shape.

      The trunk's *name* comes from `origin/HEAD`; the ref cut from is still local.
    */
    const origin = await mkdtemp(join(tmpdir(), "pithy-worktree-master-"));
    await run("git", [...GIT_NO_MAINTENANCE, "init", "--bare", "--initial-branch=master"], { cwd: origin });
    await run("git", ["branch", "-M", "master"], { cwd: repo });
    await run("git", ["remote", "add", "origin", origin], { cwd: repo });
    await run("git", ["push", "-q", "-u", "origin", "master"], { cwd: repo });
    await run("git", ["remote", "set-head", "origin", "master"], { cwd: repo });

    // The stale leftover, two commits behind the real trunk.
    await run("git", ["branch", "main", "HEAD"], { cwd: repo });
    await writeFile(join(repo, "TRUNK.md"), "on master\n");
    await run("git", ["add", "-A"], { cwd: repo });
    await run("git", ["commit", "-m", "master moves on"], { cwd: repo });
    const trunk = (await run("git", ["rev-parse", "master"], { cwd: repo })).stdout.trim();
    const stale = (await run("git", ["rev-parse", "main"], { cwd: repo })).stdout.trim();
    expect(trunk).not.toBe(stale);

    const made = await createWorktree({ issue: "454", slug: "trunk" });
    expect(made.base).toBe("master");
    expect((await run("git", ["rev-parse", "HEAD"], { cwd: made.wtPath })).stdout.trim()).toBe(trunk);
    await removeTempDir(origin);
  });

  test("**an attached branch reports no base, because none was chosen** — review of #454", async () => {
    // `createWorktree` attaches when the branch already exists — pushed by a colleague, or left by a
    // teardown — and its base is whatever they cut, months ago. The command prints how far the trunk is
    // behind its remote off this field, and on this path that sentence would be about somebody else's
    // decision. Null is what stops it being said.
    await run("git", ["branch", "feature/454-attached"], { cwd: repo });
    const made = await createWorktree({ issue: "454", slug: "attached" });
    expect(made.created).toBe(true);
    expect(made.base).toBeNull();
  });

  test("and an already-registered worktree reports no base either", async () => {
    const first = await createWorktree({ issue: "454", slug: "again" });
    expect(first.base).not.toBeNull();
    const second = await createWorktree({ issue: "454", slug: "again" });
    expect(second.created).toBe(false);
    expect(second.base).toBeNull();
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
