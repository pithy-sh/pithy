/**
 * Git-worktree lifecycle for feature work. Two idempotent subcommands:
 *
 *   bun scripts/worktree.ts setup    <issue> <slug>
 *   bun scripts/worktree.ts teardown <issue> <slug>
 *
 * Given an issue number and a short kebab slug, it composes both names itself —
 * branch `feature/<issue>-<slug>`, folder `.worktrees/<issue>-<slug>` — so callers
 * never format paths. `setup` creates and wires the worktree (or no-ops if it
 * already exists); `teardown` removes it the Linux-safe way and prunes the branch.
 *
 * Dependency-free and runtime-agnostic on purpose: this is the minimal core the
 * future `pithy feature create/destroy` command (issue #25) will wrap, adding the
 * port allocator, `.dev.vars` generation, and ephemeral CF resources on top.
 */

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, rmSync, symlinkSync } from "node:fs";
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

type Names = { branch: string; dir: string; wtPath: string; root: string };

function names(issue: string, slug: string): Names {
  const root = mainRoot();
  const dir = `${issue}-${slug}`;
  return { branch: `feature/${issue}-${slug}`, dir, wtPath: join(root, ".worktrees", dir), root };
}

function setup(issue: string, slug: string): void {
  const { branch, wtPath, root } = names(issue, slug);

  if (isRegistered(wtPath)) {
    // Re-wire rather than return. A worktree outlives the link into it: renaming the main checkout
    // leaves it pointing at nothing, and re-running `setup` is the obvious thing to reach for. It used
    // to be the one thing that could not fix it. The install is skipped, because that is the slow half
    // and an existing worktree has already had it.
    console.log(`Worktree exists. ${wtPath}`);
    wireShared(wtPath, root);
    return;
  }

  // Attach to the branch if it already exists (a re-run after teardown left the
  // remote branch behind); otherwise cut a fresh one from origin/main.
  if (branchExists(branch)) {
    git(["worktree", "add", wtPath, branch]);
  } else {
    git(["worktree", "add", wtPath, "-b", branch, "origin/main"]);
  }

  configure(wtPath, root);

  console.log(`Worktree ready. ${wtPath}`);
  console.log(`Branch ${branch}.`);
}

/**
 * Configure a freshly-created worktree so the gates and integration tests run inside it: install
 * deps, then share the main checkout's `.dev.vars`.
 *
 * **`.dev.vars` is the only file that needs wiring, and wrangler is the reason.** Wrangler reads it
 * from the worker's own directory, so it is linked at the worktree root and again into each package by
 * the `vars:local` turbo task — a location that is not ours to choose.
 *
 * **The dev secrets file needs nothing, and that is #156.** It lives at `<config>/<project>/`, resolved
 * from the project's *name*, so every worktree of this repo finds the same file with no link, no copy,
 * and no step here. #155 asked for a link exactly like `.dev.vars`'s; moving the file removed the
 * question instead — and with it the dangling link a renamed checkout used to leave behind.
 *
 * Idempotent.
 */
function configure(wtPath: string, root: string): void {
  // Install so typecheck/biome/vitest run inside the tree.
  execFileSync("bun", ["install"], { cwd: wtPath, stdio: "inherit" });
  wireShared(wtPath, root);
}

/**
 * Point the worktree at the main checkout's `.dev.vars`. Separate from {@link configure} because
 * this half is idempotent and cheap, so `setup` can run it against a worktree that already exists to
 * repair its links without paying for a second install.
 */
function wireShared(wtPath: string, root: string): void {
  if (share(root, wtPath, ".dev.vars")) {
    execFileSync("bun", ["run", "vars:local"], { cwd: wtPath, stdio: "inherit" });
    console.log("Linked .dev.vars (root + per-package via vars:local).");
  }
}

/**
 * Link `name` in the worktree to the main checkout's copy. Returns whether the worktree ended up with
 * one — false when the main checkout has none, which is the normal state of a fresh clone.
 *
 * `lstatSync` rather than `existsSync` for the target, because `existsSync` follows the link: a stale
 * one left by a renamed or deleted main checkout reads as *absent*, and `symlinkSync` then fails
 * `EEXIST` on a path that resolves to nothing. Replacing it is the repair, and it is why a re-run over
 * an existing worktree is worth something.
 */
function share(root: string, wtPath: string, name: string): boolean {
  const source = join(root, name);
  if (!existsSync(source)) return false;

  const target = join(wtPath, name);
  try {
    lstatSync(target);
    rmSync(target, { force: true });
  } catch {
    // Nothing there. Fine.
  }
  symlinkSync(source, target);
  return true;
}

function teardown(issue: string, slug: string): void {
  const { branch, wtPath, root } = names(issue, slug);

  if (isRegistered(wtPath)) {
    // Linux-safe removal: drop the gitlink, then prune the registration. Never
    // `rm -rf` or `git worktree remove` — recursive deletion over a node_modules
    // tree triggers inotify storms that crash the box (CLAUDE.md).
    const gitlink = join(wtPath, ".git");
    if (existsSync(gitlink)) rmSync(gitlink);
    git(["worktree", "prune"], root);
    console.log(`Worktree pruned. ${wtPath}`);
    console.log("Files remain on disk by design; the directory is git-ignored. Remove it when no watchers are active.");
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

main();
