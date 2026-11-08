/**
 * Git-worktree lifecycle for feature work. Two idempotent subcommands:
 *
 *   bun scripts/worktree.ts setup    <issue> <slug>
 *   bun scripts/worktree.ts teardown <issue> <slug>
 *
 * Given an issue number and a short kebab slug, it composes both names itself —
 * branch `feature/<issue>-<slug>`, folder `.worktrees/<issue>-<slug>` — so callers
 * never format paths. `setup` creates and wires the worktree (or no-ops if it
 * already exists); `teardown` prunes the registration, removes the directory, and drops the branch.
 *
 * Dependency-free and runtime-agnostic. `pithy feature create/destroy` is the product's
 * version of this, with the port allocator and ephemeral Cloudflare resources on top.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

/** Run git, return trimmed stdout. Throws on a non-zero exit. */
function git(args: string[], cwd?: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** Run git, swallow the error, return whether it succeeded. For best-effort steps. */
function gitTry(args: string[], cwd?: string): boolean {
  try {
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * The main checkout's root. The first `git worktree list` entry is always the
 * primary worktree, so this resolves the same path whether we're invoked from the
 * root or from inside another worktree.
 */
function mainRoot(): string {
  const first = git(["worktree", "list", "--porcelain"]).split("\n")[0];
  const path = first.startsWith("worktree ") ? first.slice("worktree ".length) : "";
  if (!path) throw new Error("could not resolve the main worktree root.");
  return path;
}

/** Is a worktree registered at this absolute path? */
function isRegistered(wtPath: string): boolean {
  return git(["worktree", "list", "--porcelain"])
    .split("\n")
    .some((line) => line === `worktree ${wtPath}`);
}

/** Does this ref exist locally or on origin? */
function branchExists(branch: string): boolean {
  return (
    gitTry(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]) ||
    gitTry(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`])
  );
}

/**
 * The commit a new branch is cut from, after fetching `origin/main`: whichever of local `main` and `origin/main`
 * holds the other, so the branch has every merge either side knows about.
 *
 * - Local `main` behind, nothing of its own: `origin/main`. The main checkout is not moved.
 * - Local `main` ahead, or level: local `main`. A merge made here and not yet pushed is kept.
 * - Diverged: local `main`, with a note, because neither side holds the other and choosing is a person's call.
 *
 * The fetch is best-effort, so an offline run cuts from what this clone last saw. A repository with no
 * `origin/main` cuts from local `main`.
 */
export function cutBase(root: string): { base: string; note: string | null } {
  gitTry(["fetch", "--quiet", "origin", "main"], root);
  if (!gitTry(["rev-parse", "--verify", "--quiet", "refs/remotes/origin/main"], root))
    return { base: "main", note: null };
  const behind = git(["rev-list", "--count", "main..origin/main"], root);
  const ahead = git(["rev-list", "--count", "origin/main..main"], root);
  if (behind === "0") return { base: "main", note: null };
  if (ahead === "0")
    return { base: "origin/main", note: `main is ${behind} commit(s) behind origin/main. Cutting from origin/main.` };
  return {
    base: "main",
    note: `main and origin/main have diverged: ${ahead} commit(s) here, ${behind} there. Cutting from local main.`,
  };
}

type Names = { branch: string; dir: string; wtPath: string; root: string };

function names(issue: string, slug: string): Names {
  const root = mainRoot();
  const dir = `${issue}-${slug}`;
  return { branch: `feature/${issue}-${slug}`, dir, wtPath: join(root, ".worktrees", dir), root };
}

function setup(issue: string, slug: string): void {
  const { branch, wtPath, root } = names(issue, slug);

  if (isRegistered(wtPath)) {
    // Nothing to repair: a worktree holds no link into the main checkout, so one that exists is correct.
    console.log(`Worktree exists. ${wtPath}`);
    return;
  }

  // A branch that already exists is attached as it is: a re-run after teardown left it on the remote.
  if (branchExists(branch)) {
    git(["worktree", "add", wtPath, branch]);
  } else {
    const { base, note } = cutBase(root);
    if (note) console.warn(note);
    // No upstream: cut from `origin/main`, git would track it, and the branch's own push sets the real one.
    git(["worktree", "add", "--no-track", wtPath, "-b", branch, base]);
  }

  configure(wtPath);

  console.log(`Worktree ready. ${wtPath}`);
  console.log(`Branch ${branch}.`);
}

/**
 * Configure a freshly-created worktree so the gates and integration tests run inside it: install deps.
 *
 * Nothing else is wired. Each `.dev.vars` is generated from sources outside every checkout, and the dev
 * secrets file lives at `<config>/<project>/`, found by the project's name from any worktree.
 *
 * Idempotent.
 */
function configure(wtPath: string): void {
  // Install so typecheck/biome/vitest run inside the tree.
  execFileSync("bun", ["install"], { cwd: wtPath, stdio: "inherit" });
}

/**
 * Whether a `pithy dev` session is still supervising this worktree. `.dev-state.json` records the
 * supervising pid; `kill(pid, 0)` asks the kernel whether it is there without signaling it. Fails safe:
 * only the absence of the file is a confident "no session". A file that will not read or carries no
 * numeric pid counts as live, which is what a session killed mid-write leaves behind. `EPERM` counts as
 * live too — the process exists and is somebody else's.
 */
function hasLiveDevSession(wtPath: string): boolean {
  const statePath = join(wtPath, ".dev-state.json");
  if (!existsSync(statePath)) return false;
  let pid: unknown;
  try {
    pid = JSON.parse(readFileSync(statePath, "utf8")).pid;
  } catch {
    return true; // fails safe: a file that will not read is what a session killed mid-write leaves
  }
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function teardown(issue: string, slug: string): void {
  const { branch, wtPath, root } = names(issue, slug);

  if (isRegistered(wtPath)) {
    // Drop the gitlink, prune the registration, then remove the directory — in that order. Never
    // `git worktree remove`, which recursed while git still held the registration; by the time the
    // delete runs here git has forgotten the tree and it is an ordinary directory.
    const gitlink = join(wtPath, ".git");
    if (existsSync(gitlink)) rmSync(gitlink);
    git(["worktree", "prune"], root);
    console.log(`Worktree pruned. ${wtPath}`);
    // A live `pithy dev` session keeps its files: deleting thousands of node_modules paths out from
    // under a running watcher is the shape that has crashed a box (CLAUDE.md), and the supervising pid
    // in `.dev-state.json` is the half of that this can detect. An editor's watcher cannot be.
    if (existsSync(wtPath) && hasLiveDevSession(wtPath)) {
      console.log("A pithy dev session is still running there, so the files were kept.");
      console.log("Stop it and re-run, or clear the directory with `pithy feature prune`.");
    } else if (existsSync(wtPath)) {
      rmSync(wtPath, { recursive: true, force: true });
      console.log("Directory removed.");
    }
  } else {
    console.log("No worktree to remove.");
  }

  // Drop the local branch. Lowercase -d refuses an unmerged branch, so this is
  // safe: an open, not-yet-merged feature keeps its branch.
  if (gitTry(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], root)) {
    if (gitTry(["branch", "-d", branch], root)) {
      console.log(`Branch ${branch} deleted.`);
    } else {
      console.log(`Branch ${branch} kept — not merged.`);
    }
  }
}

function usage(): never {
  console.error("Usage: bun scripts/worktree.ts <setup|teardown> <issue> <slug>");
  process.exit(2);
}

function main(): void {
  const [command, issue, slug] = process.argv.slice(2);
  if (!command || !issue || !slug) usage();
  if (!/^\d+$/.test(issue)) {
    console.error(`Issue must be a number. Got "${issue}".`);
    process.exit(2);
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    console.error(`Slug must be kebab-case. Got "${slug}".`);
    process.exit(2);
  }

  if (command === "setup") setup(issue, slug);
  else if (command === "teardown") teardown(issue, slug);
  else usage();
}

if (import.meta.main) main();
