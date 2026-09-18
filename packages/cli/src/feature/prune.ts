// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { z } from "zod";
import { devConfigPath, readDevConfig } from "./devConfig";
import {
  freePortBlocks,
  type LockBudget,
  PortBlock,
  type PortsRegistry,
  type RepoPortBlocks,
  readPortsRegistry,
  resolveMainRepoRoot,
} from "./ports";
import { canonicalRepoPath, currentBranch, defaultGit, type GitRunner } from "./worktree";

/**
 * A feature block no checkout of its repository would bind — what `pithy feature prune` frees and what
 * `pithy doctor` marks (#637).
 */
export const OrphanedBlock = PortBlock.extend({
  branch: z.string().describe("The registry key the block is filed under — a branch, or `local:<path>` off one."),
}).describe("A port block under this checkout's root that no worktree of the repository would bind.");
export type OrphanedBlock = z.output<typeof OrphanedBlock>;

/** One entry of `git worktree list --porcelain`. */
interface ListedWorktree {
  /** The worktree's absolute path, as git reports it — the real path. */
  path: string;
  /** The branch checked out there, `refs/heads/` stripped, or `null` for a detached HEAD. */
  branch: string | null;
  /** A bare repository's entry, which has no checkout and binds nothing. */
  bare: boolean;
}

/**
 * Parse `git worktree list --porcelain`: one stanza per worktree, blank-line separated, the first always
 * the main checkout. Lines this does not read (`HEAD`, `locked`, `prunable`) are skipped, so a newer git
 * adding one costs nothing.
 */
function parseWorktreeList(porcelain: string): ListedWorktree[] {
  const worktrees: ListedWorktree[] = [];
  let current: ListedWorktree | null = null;
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length), branch: null, bare: false };
      worktrees.push(current);
    } else if (current !== null && line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (current !== null && line === "bare") {
      current.bare = true;
    }
  }
  return worktrees;
}

/** The branch a checkout's `.dev.config.json` pins, or `null` when it has none or it will not parse. */
async function pinnedBranch(checkout: string): Promise<string | null> {
  const config = await readDevConfig(devConfigPath(checkout)).catch(() => null);
  return config?.branch ?? null;
}

/**
 * Every registry key some checkout of this repository would bind, and the main checkout's root.
 *
 * **A key is live when `pithy dev` somewhere in the repository would bind it.** That is the question, and
 * three answers make it up, each the key `ensureDevConfig` actually uses:
 *
 * - **The branch checked out in each worktree** — main checkout included, whichever branch it is on.
 * - **`local:<path>` for a worktree in detached HEAD**, which is what `pithy dev` files one under.
 * - **The branch each worktree's `.dev.config.json` pins.** A pinned config keeps its own key whatever
 *   HEAD says now, so a worktree that was detached or switched still binds the block it was created with.
 *
 * **And the checkout this runs from, whatever it is on** — its branch, its pinned branch, and
 * `local:<cwd>` spelled the way `pithy dev` spells it there. The listing reports real paths and
 * `pithy dev` keys off the cwd it was given, so through a symlink those are two strings for one checkout;
 * the caller's own is never swept, on the rule `pruneDeadRoots`' `keep` states for roots.
 *
 * **Throws rather than answering empty.** No listing is not *no live branches*: it is a question nobody
 * answered, and read as the empty set it would free every block the checkout holds.
 */
export async function liveFeatureKeys(
  cwd: string,
  git: GitRunner = defaultGit,
): Promise<{ root: string; live: ReadonlySet<string> }> {
  let porcelain: string;
  try {
    porcelain = await git(["worktree", "list", "--porcelain"], cwd);
  } catch (err) {
    throw new InternalError({
      message: "Could not list this repository's worktrees.",
      action: "Run pithy feature prune from inside a git repository.",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
  const worktrees = parseWorktreeList(porcelain);
  const main = worktrees[0];
  if (main === undefined) {
    throw new InternalError({
      message: "Could not list this repository's worktrees.",
      action: "Run pithy feature prune from inside a git repository.",
      detail: "git worktree list --porcelain printed no worktree.",
    });
  }

  const live = new Set<string>();
  for (const worktree of worktrees) {
    if (worktree.bare) continue;
    live.add(worktree.branch ?? `local:${worktree.path}`);
    const pinned = await pinnedBranch(worktree.path);
    if (pinned !== null) live.add(pinned);
  }

  live.add(`local:${cwd}`);
  const here = await currentBranch(git, cwd);
  if (here !== null) live.add(here);
  const pinnedHere = await pinnedBranch(cwd);
  if (pinnedHere !== null) live.add(pinnedHere);

  // Canonical, so it compares equal to `resolveMainRepoRoot` — the key every writer files under.
  return { root: await canonicalRepoPath(main.path), live };
}

/**
 * **The predicate.** Which of one checkout's blocks no live key holds, in port order.
 *
 * Pure, and the only place the decision is made: `pithy feature prune` frees what this returns and
 * `pithy doctor` marks what this returns, so the two cannot disagree about a row (#637).
 */
export function orphanedFeatureBlocks(
  branches: RepoPortBlocks | undefined,
  live: ReadonlySet<string>,
): OrphanedBlock[] {
  return Object.entries(branches ?? {})
    .filter(([branch]) => !live.has(branch))
    .map(([branch, entry]) => ({ branch, block: entry.block, base: entry.base, size: entry.size }))
    .sort((a, b) => a.base - b.base || a.branch.localeCompare(b.branch));
}

/**
 * The orphaned blocks under `root`, judged from the repository at `cwd`.
 *
 * Refuses when the repository at `cwd` is not the checkout `root` names: a listing can only speak for the
 * repository it walked, and judging one checkout's blocks by another's worktrees frees everything.
 */
export async function findOrphanedFeatureBlocks(options: {
  registry: PortsRegistry;
  root: string;
  cwd: string;
  git?: GitRunner;
}): Promise<OrphanedBlock[]> {
  const { root, live } = await liveFeatureKeys(options.cwd, options.git);
  if (root !== options.root) {
    throw new InternalError({
      message: "This repository is not the checkout the registry key names.",
      action: "Run pithy feature prune from the checkout whose blocks it should free.",
      detail: `git worktree list names ${root}; the registry key is ${options.root}.`,
    });
  }
  return orphanedFeatureBlocks(options.registry[root], live);
}

/** What `pithy feature prune` did, or under `--dry-run` would do. */
export interface PruneReport {
  /** The main checkout root whose blocks were judged — the registry key. */
  root: string;
  /** Whether this was a dry run. Nothing was written when it was. */
  dryRun: boolean;
  /** The blocks freed, or on a dry run the blocks that would be, in port order. */
  freedBlocks: OrphanedBlock[];
}

/**
 * Free every feature block under this checkout's root that no worktree of the repository would bind (#637).
 *
 * The real run decides and frees in one locked read-modify-write — the listing is taken under the lock
 * too, so a `pithy feature create` that adds a worktree cannot land between the answer and the free. A
 * dry run reads, the way `pithy doctor` does, and takes no lock: nothing is written, not even the lock
 * file, and the registry is byte-identical afterward.
 */
export async function pruneFeatureBlocks(options: {
  /** The checkout this runs from. Never swept. */
  cwd: string;
  /** Absolute path to the registry — `<config>/dev-ports.json`. */
  registryPath: string;
  /** List what would be freed, and write nothing. */
  dryRun: boolean;
  /** The git runner. Defaults to the system `git`. */
  git?: GitRunner;
  /** How long to wait for the registry lock. */
  lock?: LockBudget;
}): Promise<PruneReport> {
  // `resolveMainRepoRoot`, like `feature destroy`: a command that frees blocks refuses without a
  // repository, rather than falling back to a key it cannot judge.
  const root = await resolveMainRepoRoot(options.cwd);
  const find = (registry: PortsRegistry) =>
    findOrphanedFeatureBlocks({ registry, root, cwd: options.cwd, ...(options.git ? { git: options.git } : {}) });

  if (options.dryRun) {
    return { root, dryRun: true, freedBlocks: await find(await readPortsRegistry(options.registryPath)) };
  }

  const freed = await freePortBlocks({
    registryPath: options.registryPath,
    root,
    select: async (registry) => (await find(registry)).map((entry) => entry.branch),
    ...(options.lock ? { lock: options.lock } : {}),
  });
  const freedBlocks = freed
    .map(({ branch, block, base, size }) => ({ branch, block, base, size }))
    .sort((a, b) => a.base - b.base || a.branch.localeCompare(b.branch));
  return { root, dryRun: false, freedBlocks };
}
