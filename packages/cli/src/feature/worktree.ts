// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { ConflictError, InternalError } from "@pithy-sh/core/src/error/pithyError";
import { devStatePath } from "../dev/state";

const run = promisify(execFile);

/**
 * The git worktree/branch core behind `pithy feature create`/`destroy`. It is the same proven shape as
 * the repo's `scripts/worktree.ts` — compose `feature/<issue>-<slug>` + `.worktrees/<issue>-<slug>` from
 * the issue and slug, attach-or-cut the branch, and tear down by dropping the gitlink and pruning the
 * registration (never `git worktree remove`) before removing the directory —
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
 * One spelling of a repository path, whoever asked and however they got there.
 *
 * **Two things derive the main checkout's root and they must agree, because it is a registry key now**
 * (#435): {@link mainRepoRoot} below, off `git worktree list`, and `resolveMainRepoRoot` in `ports.ts`,
 * off `git rev-parse --git-common-dir`. Under the old design both were a *place to put a file* and any
 * two spellings of one directory addressed the same file, so a difference could not be observed. As keys
 * they are two entries for one repository — `pithy feature create` reserving under one while `destroy`
 * frees under the other, `freePortBlock` no-opping, and `portsFreed: true` reported over a block that
 * leaks forever.
 *
 * They diverge two ways, one per platform, and neither shows up in CI (every job is `ubuntu-24.04`).
 * On POSIX, `--git-common-dir` answers `.git` and resolving that against the working directory keeps
 * whatever symlinks were walked to get there, while `worktree list` always reports the real path. On
 * **Windows** git emits forward slashes — `C:/code/app` — while `dirname`/`realpath` give `C:\code\app`.
 * `realpath` settles both: it resolves the links and returns the platform's own separators.
 *
 * A failure is not worth refusing a command over — the path came from git, so it exists — and the
 * uncanonicalised answer stands in.
 */
export function canonicalRepoPath(path: string): Promise<string> {
  return realpath(path).catch(() => path);
}

/**
 * The main checkout's root. The first `git worktree list` entry is always the primary worktree, so this
 * resolves the same path whether invoked from the root or from inside another worktree.
 *
 * Canonicalised through {@link canonicalRepoPath}, which is what makes it the *same string* as the other
 * derivation rather than merely the same directory.
 */
/**
 * The branch a checkout is on, or `null` off one — no repository, or a detached HEAD.
 *
 * `null` rather than a guess, and every caller treats it as *nothing to inherit* rather than as `main`.
 * A detached HEAD has no branch, and naming one anyway would copy a stranger's local answer into a new
 * feature on the strength of a default.
 */
export async function currentBranch(git: GitRunner = defaultGit, cwd?: string): Promise<string | null> {
  try {
    const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd)).trim();
    return branch === "" || branch === "HEAD" ? null : branch;
  } catch {
    return null;
  }
}

export async function mainRepoRoot(git: GitRunner = defaultGit): Promise<string> {
  const first = (await git(["worktree", "list", "--porcelain"])).split("\n")[0] ?? "";
  const path = first.startsWith("worktree ") ? first.slice("worktree ".length) : "";
  if (!path) {
    throw new InternalError({
      message: "Could not resolve the main repository root.",
      action: "Run pithy feature from inside a git repository.",
    });
  }
  return canonicalRepoPath(path);
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

/** Run git for its output, or `null` when it fails. The `gitTry` of answers rather than of exit codes. */
async function gitOut(git: GitRunner, args: string[], cwd?: string): Promise<string | null> {
  try {
    const out = (await git(args, cwd)).trim();
    return out === "" ? null : out;
  } catch {
    return null;
  }
}

/** Whether a ref exists locally or on origin. */
async function branchExists(git: GitRunner, branch: string, cwd?: string): Promise<boolean> {
  return (
    (await gitTry(git, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], cwd)) ||
    (await gitTry(git, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`], cwd))
  );
}

/**
 * The name of this repository's trunk — `main` unless the remote says otherwise.
 *
 * **Read from `origin/HEAD`, which is the remote's answer to "what is the default branch".** Only the
 * *name* comes from the remote; the ref cut from is always the local branch of that name. A repository
 * whose trunk is `master` and which also carries a stale local `main` — a rename left behind, a fork —
 * would otherwise have every feature cut from the stale one, silently, which is `#454` again in a
 * different shape.
 *
 * `main` when there is no remote to ask. That is this project family's convention and what
 * `scripts/worktree.ts` has always assumed; a repository with no remote and a non-`main` trunk is the
 * one case still open, and it resolves through {@link baseRef}'s fallback rather than guessing.
 */
async function trunkName(git: GitRunner): Promise<string> {
  const named = await gitOut(git, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  return named === null ? "main" : named.replace(/^origin\//, "");
}

/**
 * The trunk to cut a fresh feature branch from: the local trunk branch when it exists, else `HEAD`.
 *
 * **Local, never `origin/<trunk>` — `#454`.** It preferred the remote whenever the ref existed, which meant
 * a feature cut on a repository holding unpushed work started before that work. On `pithy-sh/dashboard`
 * that was 159 commits, and the symptom was a config error naming a field the branch was too old to have —
 * a sentence that says nothing about the base it was cut from. Where the old config still parses there is
 * no symptom at all: the branch is simply rooted in the past, and the operator learns at merge.
 *
 * A remote that is *ahead* is the ordinary case and not this function's business: cutting from a trunk that
 * is a few commits behind is usually fine and sometimes deliberate. {@link behindRemote} is how the operator
 * gets told, because being told is what stops it becoming a surprise at merge time.
 */
async function baseRef(git: GitRunner): Promise<string> {
  const trunk = await trunkName(git);
  return (await gitTry(git, ["rev-parse", "--verify", "--quiet", `refs/heads/${trunk}`])) ? trunk : "HEAD";
}

/**
 * How many commits the local trunk is behind its remote, or `null` when the question does not arise —
 * no remote ref, no local trunk, or nothing behind.
 *
 * Reported rather than refused, and the caller decides how to say it. A repository with no `origin` is the
 * ordinary case for a fresh `pithy init`, and a count of zero is the ordinary case for everybody else.
 */
export async function behindRemote(git: GitRunner = defaultGit): Promise<number | null> {
  const trunk = await trunkName(git);
  if (!(await gitTry(git, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${trunk}`]))) return null;
  if (!(await gitTry(git, ["rev-parse", "--verify", "--quiet", `refs/heads/${trunk}`]))) return null;
  const behind = Number.parseInt(await git(["rev-list", "--count", `${trunk}..origin/${trunk}`]), 10);
  return Number.isFinite(behind) && behind > 0 ? behind : null;
}

/** The outcome of {@link createWorktree}: the composed names and whether a new worktree was created. */
export interface CreateWorktreeResult extends FeatureNames {
  /** The main checkout root the worktree lives under. */
  root: string;
  /** True when a new worktree was created; false when one already existed (idempotent re-run). */
  created: boolean;
  /**
   * The ref a fresh branch was cut from — the trunk's name, or `"HEAD"`. **Null when nothing was cut**:
   * an already-registered worktree, or a branch that already existed and was attached to.
   *
   * A caller reporting a base has to know that difference. `feature create` prints how far the trunk is
   * behind its remote, and on the attach path that sentence would be about a branch somebody else cut
   * months ago — a false sentence about a base, which is the thing `#454` is about.
   */
  base: string | null;
}

/**
 * Create the feature's branch and worktree, or no-op if the worktree is already registered. Attaches to
 * the branch when it already exists (a re-run after teardown left the branch behind); otherwise cuts a
 * fresh one from the trunk. Idempotent **only** while the worktree stays registered — a re-run after
 * {@link teardownWorktree} (which keeps them only when a dev session may still be watching) fails with an actionable
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
    return { ...names, root, created: false, base: null };
  }

  if (hasLeftoverFiles(names.wtPath)) {
    throw new ConflictError({
      message: `${names.wtPath} already exists and is not empty.`,
      action:
        "Teardown removes the directory, so something else left this one: a 'pithy dev' session that was " +
        "running when the feature was destroyed, or a tree made by hand. Remove it yourself " +
        `(rm -r ${names.wtPath}) and re-run 'pithy feature create'.`,
      detail: `git worktree add would fail: ${names.wtPath} is an unregistered, non-empty directory.`,
    });
  }

  if (await branchExists(git, names.branch)) {
    // Attached, not cut. The branch already exists — pushed by a colleague, or left behind by a teardown —
    // so its base is whatever it was cut from, months ago and by somebody else. Nothing about this trunk.
    await git(["worktree", "add", names.wtPath, names.branch]);
    return { ...names, root, created: true, base: null };
  }
  const base = await baseRef(git);
  await git(["worktree", "add", names.wtPath, "-b", names.branch, base]);
  return { ...names, root, created: true, base };
}

/**
 * The feature's own worktree: where it is, and whether this machine has it (#660).
 *
 * **The feature's record lives there and nowhere else.** `.pithy-feature.json` is what teardown deletes by
 * exact id, and the branch's `apps/<name>/pithy.config.ts` is what it recomputes names from — both are the
 * *feature's*, not the checkout's, and `pithy feature destroy --branch` is by definition run from
 * somewhere else. Asking where that worktree is, rather than assuming the cwd is it, is the difference
 * between deleting what the feature provisioned and deleting what the current branch happens to declare.
 *
 * **`existsSync`, not `git worktree list`.** Teardown deliberately leaves a pruned worktree's files on
 * disk (CLAUDE.md: never `rm -rf` a node_modules tree on Linux), so a directory git no longer registers
 * still holds the manifest — and a half-torn-down feature is exactly when the record matters. The
 * directory is the test, the same one `feature prune` applies.
 *
 * `present: false` is the runner's answer, and it is not a failure: the registry, the worktree and the
 * manifest are all machine-local, and the machine is a fresh container. It is a fact the run reports.
 */
export async function featureWorktree(options: {
  issue: string;
  slug: string;
  /**
   * The issue as it was spelled, when that differs from the canonical one — `012` for `12` (#660
   * review). Tried only when nothing is at the canonical path: a feature created before the issue was
   * canonicalised filed its worktree under the padded spelling, and nothing else knows that.
   */
  spelled?: string;
  git?: GitRunner;
}): Promise<FeatureRecord> {
  const git = options.git ?? defaultGit;
  const root = await mainRepoRoot(git);
  const canonical = featureNames(options.issue, options.slug, root).wtPath;
  if (existsSync(canonical)) return { dir: canonical, present: true };
  if (options.spelled !== undefined && options.spelled !== options.issue) {
    const padded = featureNames(options.spelled, options.slug, root).wtPath;
    if (existsSync(padded)) return { dir: padded, present: true };
  }
  // Canonical either way when there is nothing to find: that is the path a reader should be shown, and
  // the one a feature created from here on has.
  return { dir: canonical, present: false };
}

/**
 * Where a feature's own record lives, and whether this machine has it (#660).
 *
 * On the inferred path the two are the cwd and `true`: the run is standing in the feature. Under
 * `pithy feature destroy --branch` the feature's worktree is somewhere else, or nowhere — and
 * `present: false` is the runner's ordinary answer, not a failure.
 */
export interface FeatureRecord {
  /** The feature's own worktree. */
  dir: string;
  /** Whether that directory is on this machine. */
  present: boolean;
}

/** The outcome of {@link teardownWorktree}: what was actually removed. */
/**
 * Whether a `pithy dev` session may still be supervising this worktree. `.dev-state.json` records the
 * supervising pid; `kill(pid, 0)` asks the kernel whether it is there without signaling it.
 *
 * **It fails safe, and deliberately does not parse through {@link DevState}.** The only question here is
 * "may something still be watching", and the answer gates a recursive delete — so anything short of proof
 * that the process is gone keeps the files. No file at all is the one confident "no": the file is
 * ephemeral and its absence is the ordinary case. A file that will not read, will not parse, or carries no
 * numeric pid counts as live, because that is exactly what a session killed mid-write leaves behind.
 * `EPERM` counts as live too — the process exists and belongs to somebody else.
 */
function hasLiveDevSession(worktreePath: string): boolean {
  const statePath = devStatePath(worktreePath);
  if (!existsSync(statePath)) return false;
  let pid: unknown;
  try {
    pid = JSON.parse(readFileSync(statePath, "utf8")).pid;
  } catch {
    return true;
  }
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface TeardownWorktreeResult extends FeatureNames {
  /** True when a registered worktree was pruned. */
  pruned: boolean;
  /** True when the local branch was deleted (a merged branch); false when kept (unmerged) or absent. */
  branchDeleted: boolean;
}

/**
 * Tear down the feature's worktree and drop its branch. Drops the gitlink, prunes the registration, then
 * removes the directory. Never `git worktree remove`, which is what recursed while git still held the
 * registration; the order here is what makes the delete ordinary — by the time it runs, git has forgotten
 * the tree entirely.
 *
 * **This only ever runs on a teardown that got that far.** `featureDestroy` throws before reaching it when
 * the remote half fails, precisely so the checkout a re-run happens from — and the `.pithy-feature.json`
 * saying what is left to delete — survive. Deleting here is therefore scoped to the case where nothing is
 * left to resume.
 *
 * **A live `pithy dev` session keeps its files.** Removing thousands of `node_modules` paths out from under
 * a running watcher is the one shape that has crashed a box (CLAUDE.md), and a supervising session is the
 * half of that this can actually detect: `.dev-state.json` names the pid. When one is alive the directory
 * is kept and said so, and `pithy feature prune` clears it later. An editor's watcher cannot be detected
 * from here and remains the operator's to know.
 *
 * The lowercase `-d` refuses an unmerged branch, so an open feature keeps its branch. Idempotent for
 * repeated teardowns: nothing registered / no branch is a clean no-op.
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

  // Remove the directory once git no longer knows about it. Guarded on a live dev session only: see the
  // docstring for why that is the one watcher this can see.
  if (existsSync(names.wtPath) && !hasLiveDevSession(names.wtPath)) {
    rmSync(names.wtPath, { recursive: true, force: true });
  }

  let branchDeleted = false;
  if (await gitTry(git, ["rev-parse", "--verify", "--quiet", `refs/heads/${names.branch}`], root)) {
    branchDeleted = await gitTry(git, ["branch", "-d", names.branch], root);
  }
  return { ...names, pruned, branchDeleted };
}
