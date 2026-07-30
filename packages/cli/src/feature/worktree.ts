// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFile } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { ConflictError, InternalError } from "@pithy-sh/core/src/error/pithyError";

const run = promisify(execFile);

/**
 * The git worktree/branch core behind `pithy feature create`/`destroy`. It is the same proven shape as
 * the repo's `scripts/worktree.ts` — compose `feature/<issue>-<slug>` + `.worktrees/<issue>-<slug>` from
 * the issue and slug, attach-or-cut the branch, and tear down the Linux-safe way (`rm .git` +
 * `git worktree prune`, never `rm -rf`/`git worktree remove`, which trigger inotify storms on Linux) —
 * ported into the CLI: async (no `execFileSync`), runtime- and package-manager-agnostic, and free of the
 * `.dev.vars` symlinking, which the richer consolidated composition (`devVars.ts`) supersedes.
 */

/** Runs git and returns trimmed stdout; throws on a non-zero exit. Injectable so tests fake git. */
export type GitRunner = (args: string[], cwd?: string) => Promise<string>;

/** The default git runner — shells out to the system `git`. */
export const defaultGit: GitRunner = async (args, cwd) => {
  const { stdout } = await run("git", args, cwd ? { cwd } : {});
  return stdout.trim();
};

/** Run git, swallow the error, and report whether it succeeded — for best-effort steps. */
async function gitTry(git: GitRunner, args: string[], cwd?: string): Promise<boolean> {
  try {
    await git(args, cwd);
    return true;
  } catch {
    return false;
  }
}

/** The composed names for a feature: the branch, the worktree dir name, and its absolute path. */
export interface FeatureNames {
  /** The feature branch, `feature/<issue>-<slug>`. */
  branch: string;
  /** The worktree directory name, `<issue>-<slug>`. */
  dir: string;
  /** The absolute worktree path, `<root>/.worktrees/<issue>-<slug>`. */
  wtPath: string;
}

/** Compose the branch, dir, and worktree path for an issue + slug under a main-checkout root. */
export function featureNames(issue: string, slug: string, root: string): FeatureNames {
  const dir = `${issue}-${slug}`;
  return { branch: `feature/${issue}-${slug}`, dir, wtPath: join(root, ".worktrees", dir) };
}

/**
 * The main checkout's root. The first `git worktree list` entry is always the primary worktree, so this
 * resolves the same path whether invoked from the root or from inside another worktree.
 */
export async function mainRepoRoot(git: GitRunner = defaultGit): Promise<string> {
  const first = (await git(["worktree", "list", "--porcelain"])).split("\n")[0] ?? "";
  const path = first.startsWith("worktree ") ? first.slice("worktree ".length) : "";
  if (!path) {
    throw new InternalError({
      message: "Could not resolve the main repository root.",
      action: "Run pithy feature from inside a git repository.",
    });
  }
  return path;
}

/** Whether a worktree is registered at this absolute path. */
async function isRegistered(git: GitRunner, wtPath: string): Promise<boolean> {
  return (await git(["worktree", "list", "--porcelain"])).split("\n").some((line) => line === `worktree ${wtPath}`);
}

/**
 * Whether a non-empty, unregistered directory already sits at `wtPath` — the leftover files a prior
 * {@link teardownWorktree} deliberately left behind. `git worktree add` refuses to write into such a
 * directory, so this is checked first to fail with an actionable error instead of a raw git one.
 */
function hasLeftoverFiles(wtPath: string): boolean {
  if (!existsSync(wtPath)) return false;
  return readdirSync(wtPath).length > 0;
}

/** Whether a ref exists locally or on origin. */
async function branchExists(git: GitRunner, branch: string, cwd?: string): Promise<boolean> {
  return (
    (await gitTry(git, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], cwd)) ||
    (await gitTry(git, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`], cwd))
  );
}

/** The trunk to cut a fresh feature branch from: `origin/main` when it exists, else the current `HEAD`. */
async function baseRef(git: GitRunner): Promise<string> {
  return (await gitTry(git, ["rev-parse", "--verify", "--quiet", "refs/remotes/origin/main"])) ? "origin/main" : "HEAD";
}

/** The outcome of {@link createWorktree}: the composed names and whether a new worktree was created. */
export interface CreateWorktreeResult extends FeatureNames {
  /** The main checkout root the worktree lives under. */
  root: string;
  /** True when a new worktree was created; false when one already existed (idempotent re-run). */
  created: boolean;
}

/**
 * Create the feature's branch and worktree, or no-op if the worktree is already registered. Attaches to
 * the branch when it already exists (a re-run after teardown left the branch behind); otherwise cuts a
 * fresh one from the trunk. Idempotent **only** while the worktree stays registered — a re-run after
 * {@link teardownWorktree} (which deliberately leaves the files on disk) fails with an actionable
 * `ConflictError` instead of a raw git error, because those leftover files must not be recursively
 * deleted on Linux (CLAUDE.md).
 */
export async function createWorktree(options: {
  issue: string;
  slug: string;
  git?: GitRunner;
}): Promise<CreateWorktreeResult> {
  const git = options.git ?? defaultGit;
  const root = await mainRepoRoot(git);
  const names = featureNames(options.issue, options.slug, root);

  if (await isRegistered(git, names.wtPath)) {
    return { ...names, root, created: false };
  }

  if (hasLeftoverFiles(names.wtPath)) {
    throw new ConflictError({
      message: `${names.wtPath} already exists and is not empty.`,
      action:
        "A previous 'pithy feature destroy' left these files on disk by design. Once no file watcher or editor " +
        `has it open, remove the directory yourself (rm -r ${names.wtPath}) and re-run 'pithy feature create'.`,
      detail: `git worktree add would fail: ${names.wtPath} is an unregistered, non-empty directory.`,
    });
  }

  if (await branchExists(git, names.branch)) {
    await git(["worktree", "add", names.wtPath, names.branch]);
  } else {
    await git(["worktree", "add", names.wtPath, "-b", names.branch, await baseRef(git)]);
  }
  return { ...names, root, created: true };
}

/** The outcome of {@link teardownWorktree}: what was actually removed. */
export interface TeardownWorktreeResult extends FeatureNames {
  /** True when a registered worktree was pruned. */
  pruned: boolean;
  /** True when the local branch was deleted (a merged branch); false when kept (unmerged) or absent. */
  branchDeleted: boolean;
}

/**
 * Tear down the feature's worktree the Linux-safe way and drop its branch. Drops the gitlink then prunes
 * the registration — never `rm -rf` or `git worktree remove`, whose recursive delete over a node_modules
 * tree triggers inotify storms that crash the box (CLAUDE.md). Files remain on disk by design (the dir is
 * git-ignored). The lowercase `-d` refuses an unmerged branch, so an open feature keeps its branch.
 * Idempotent for repeated teardowns: nothing registered / no branch is a clean no-op. Recreating the same
 * feature afterwards is **not** automatically idempotent — the leftover files on disk make
 * {@link createWorktree} fail loudly until an operator clears them; see its docstring.
 */
export async function teardownWorktree(options: {
  issue: string;
  slug: string;
  git?: GitRunner;
}): Promise<TeardownWorktreeResult> {
  const git = options.git ?? defaultGit;
  const root = await mainRepoRoot(git);
  const names = featureNames(options.issue, options.slug, root);

  let pruned = false;
  if (await isRegistered(git, names.wtPath)) {
    const gitlink = join(names.wtPath, ".git");
    if (existsSync(gitlink)) rmSync(gitlink);
    await git(["worktree", "prune"], root);
    pruned = true;
  }

  let branchDeleted = false;
  if (await gitTry(git, ["rev-parse", "--verify", "--quiet", `refs/heads/${names.branch}`], root)) {
    branchDeleted = await gitTry(git, ["branch", "-d", names.branch], root);
  }
  return { ...names, pruned, branchDeleted };
}
