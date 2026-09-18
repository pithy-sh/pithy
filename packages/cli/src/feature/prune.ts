// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { lstat, readdir } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
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
import { currentBranch, defaultGit, type GitRunner } from "./worktree";

/**
 * A feature block nothing holds — what `pithy feature prune` frees and what `pithy doctor` marks (#637).
 */
export const OrphanedBlock = PortBlock.extend({
  branch: z.string().describe("The registry key the block is filed under — a branch, or `local:<path>` off one."),
}).describe("A port block under this checkout's root whose worktree directory and branch are both gone.");
export type OrphanedBlock = z.output<typeof OrphanedBlock>;

/** One entry of `git worktree list --porcelain -z`. */
interface ListedWorktree {
  /** The worktree's absolute path, as git reports it — the real path. */
  path: string;
  /** The branch checked out there, `refs/heads/` stripped, or `null` for a detached HEAD. */
  branch: string | null;
  /** A bare repository's entry, which has no checkout and holds nothing. */
  bare: boolean;
}

/**
 * Parse `git worktree list --porcelain -z`: every attribute NUL-terminated, a stanza ended by an empty one.
 *
 * **NUL, not newline.** A path may hold a newline, and read line by line it splits into a path that does
 * not exist and an attribute nobody recognizes — so a directory on disk was never looked in. Attributes this
 * does not read (`HEAD`, `detached`, `locked`, `prunable`) are skipped, so a newer git adding one costs
 * nothing. `prunable` is deliberately not the test for a gone worktree: git says it both of a directory
 * deleted by hand and of one whose gitlink was dropped, and only the first is gone from disk.
 */
function parseWorktreeList(porcelain: string): ListedWorktree[] {
  const worktrees: ListedWorktree[] = [];
  let current: ListedWorktree | null = null;
  for (const field of porcelain.split("\0")) {
    if (field.startsWith("worktree ")) {
      current = { path: field.slice("worktree ".length), branch: null, bare: false };
      worktrees.push(current);
    } else if (current !== null && field.startsWith("branch ")) {
      current.branch = field.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (current !== null && field === "bare") {
      current.bare = true;
    }
  }
  return worktrees;
}

/**
 * Whether a path is on disk. **Only a definite absence says no** — `ENOENT`, or `ENOTDIR` for a path through
 * a file. A directory that cannot be read is still there, and when in doubt a block is kept.
 */
async function onDisk(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code !== "ENOENT" && code !== "ENOTDIR";
  }
}

/**
 * The branch a directory's `.dev.config.json` pins, or `null` when it has none.
 *
 * **A config that will not parse is a refusal, not a `null`.** It is a directory on disk holding some
 * block, and nobody can say which; read as *pins nothing*, the block it holds would be freed.
 */
async function pinnedBranch(dir: string): Promise<string | null> {
  try {
    return (await readDevConfig(devConfigPath(dir)))?.branch ?? null;
  } catch (err) {
    throw new InternalError({
      message: "A .dev.config.json will not parse, so the block it holds is unknown.",
      action: "Fix or delete that .dev.config.json, then run this again.",
      detail: `${devConfigPath(dir)}: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

/**
 * What a repository says holds a block — read once per decision, then asked per key by {@link isBlockHeld}.
 */
export interface Holdings {
  /** The main checkout's root, canonical: `resolveMainRepoRoot`'s answer, the key every writer files under. */
  root: string;
  /**
   * Whether that key may be shared with another repository. `resolveMainRepoRoot` keys a checkout by the
   * directory holding its git dir, which is the checkout itself only when the git dir is `<root>/.git`. A
   * bare repository's is the directory it sits in, beside any other; a submodule's is the superproject's
   * `.git/modules`, the same for every submodule it has.
   */
  shared: boolean;
  /** Every local branch, `refs/heads/` stripped. */
  branches: ReadonlySet<string>;
  /** Every branch a directory on disk holds: checked out in a worktree still there, or pinned by a config in one. */
  heldOnDisk: ReadonlySet<string>;
}

/**
 * Read what holds a block, from the repository at `cwd`.
 *
 * The directories looked in are every worktree `git worktree list` names that is still on disk, every
 * directory under `<root>/.worktrees` whether git still registers it or not, and `cwd` itself. In each, the
 * pinned config is read at its root **and at `cwd`'s place in its own checkout** — `pithy dev` runs where
 * the project is, and a project in `app/` pins `<worktree>/app/.dev.config.json`.
 *
 * **Throws rather than answering empty.** No listing is not *nothing holds anything*: it is a question
 * nobody answered, and read as the empty set it would free every block the checkout has.
 */
export async function readHoldings(cwd: string, git: GitRunner = defaultGit): Promise<Holdings> {
  const ask = async (args: string[]): Promise<string> => {
    try {
      return await git(args, cwd);
    } catch (err) {
      throw new InternalError({
        message: "Could not read this repository's worktrees and branches.",
        action: "Run this from inside a git repository.",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  };
  const root = await resolveMainRepoRoot(cwd);
  const commonDir = await ask(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const worktrees = parseWorktreeList(await ask(["worktree", "list", "--porcelain", "-z"]));
  if (worktrees.length === 0) {
    throw new InternalError({
      message: "Could not read this repository's worktrees and branches.",
      action: "Run this from inside a git repository.",
      detail: "git worktree list --porcelain -z printed no worktree.",
    });
  }
  const branches = new Set(
    (await ask(["for-each-ref", "--format=%(refname)", "refs/heads/"]))
      .split("\n")
      .filter((ref) => ref.startsWith("refs/heads/"))
      .map((ref) => ref.slice("refs/heads/".length)),
  );
  // Where `cwd` sits in its own checkout — `app/` for a project in a subdirectory, empty at the top.
  const prefix = await ask(["rev-parse", "--show-prefix"]);

  const held = new Set<string>();
  const dirs = new Set<string>([cwd]);
  for (const worktree of worktrees) {
    if (worktree.bare || !(await onDisk(worktree.path))) continue;
    dirs.add(worktree.path);
    if (worktree.branch !== null) held.add(worktree.branch);
  }
  const parked = join(root, ".worktrees");
  const entries = await readdir(parked, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) if (entry.isDirectory()) dirs.add(join(parked, entry.name));

  const here = await currentBranch(git, cwd);
  if (here !== null) held.add(here);
  for (const dir of dirs) {
    for (const place of new Set([dir, join(dir, prefix)])) {
      const pinned = await pinnedBranch(place);
      if (pinned !== null) held.add(pinned);
    }
  }

  return { root, shared: basename(commonDir) !== ".git", branches, heldOnDisk: held };
}

/**
 * **The predicate: whether a registry key's block is held.** One answer for `pithy feature prune`, for
 * `pithy doctor`'s marker, and for the reclaim that rebuilds a lost registry (#637).
 *
 * **A block is freed only when its worktree's directory is gone from disk and its branch is gone too.**
 * Either one surviving keeps it:
 *
 * - **The branch exists locally** — checked out anywhere or nowhere. A branch you switched away from, or
 *   whose worktree you removed, is a feature you may come back to, and it keeps its ports until you delete it.
 * - **A directory on disk holds it** — a worktree still there with the branch checked out, a
 *   `.dev.config.json` there pinning it, or `.worktrees/<slug>`, where `pithy feature create` puts it. A
 *   directory a gitlink-drop teardown left behind counts, whether or not git still registers it.
 *
 * A branch key is matched in both of `pithy dev`'s spellings: `rev-parse --abbrev-ref HEAD` says
 * `heads/<branch>` when a tag of the same name shadows it. A `local:<path>` key has no branch, so its
 * directory is the whole answer. Anything that cannot be decided — a relative path, an unreadable
 * directory — is held.
 */
export async function isBlockHeld(key: string, holdings: Holdings): Promise<boolean> {
  if (key.startsWith("local:")) {
    const path = key.slice("local:".length);
    return !isAbsolute(path) || (await onDisk(path));
  }
  const branch = key.startsWith("heads/") ? key.slice("heads/".length) : key;
  if ([key, branch].some((name) => holdings.branches.has(name) || holdings.heldOnDisk.has(name))) return true;
  return onDisk(join(holdings.root, ".worktrees", branch.replace(/^feature\//, "")));
}

/**
 * The reservations a reclaim may put back: the ones {@link isBlockHeld} holds, judged from `cwd`.
 *
 * `pithy dev` and `pithy feature sync` rebuild a lost registry from the blocks `.dev.config.json` files
 * still pin, and this is the filter they share with prune — so a block prune frees is never put back, and a
 * block prune keeps is never left off a rebuilt registry for somebody else to be handed. **When the
 * repository cannot answer, every reservation is kept**: the cost of a stale one is a block held too long,
 * and the cost of dropping a live one is two features bound to the same ports.
 */
export async function heldReservations<T extends { branch: string }>(
  cwd: string,
  reservations: readonly T[],
  git: GitRunner = defaultGit,
): Promise<T[]> {
  if (reservations.length === 0) return [];
  let holdings: Holdings;
  try {
    holdings = await readHoldings(cwd, git);
  } catch {
    return [...reservations];
  }
  if (holdings.shared) return [...reservations];
  const held: T[] = [];
  for (const reservation of reservations) {
    if (await isBlockHeld(reservation.branch, holdings)) held.push(reservation);
  }
  return held;
}

/**
 * Which of one checkout's blocks nothing holds, in port order — {@link isBlockHeld} over each.
 *
 * The only place the decision is made for a registry: `pithy feature prune` frees what this returns and
 * `pithy doctor` marks what this returns, so the two cannot disagree about a row (#637).
 */
export async function orphanedFeatureBlocks(
  branches: RepoPortBlocks | undefined,
  holdings: Holdings,
): Promise<OrphanedBlock[]> {
  const orphaned: OrphanedBlock[] = [];
  for (const [branch, entry] of Object.entries(branches ?? {})) {
    if (!(await isBlockHeld(branch, holdings))) {
      orphaned.push({ branch, block: entry.block, base: entry.base, size: entry.size });
    }
  }
  return orphaned.sort((a, b) => a.base - b.base || a.branch.localeCompare(b.branch));
}

/**
 * The orphaned blocks under `root`, judged from the repository at `cwd`.
 *
 * Refuses when the repository at `cwd` is not the checkout `root` names — a listing can only speak for the
 * repository it walked — and in a bare repository or a submodule, whose key other repositories may share
 * (see {@link Holdings.shared}): their branches are not this repository's, so every one would look deleted.
 */
export async function findOrphanedFeatureBlocks(options: {
  registry: PortsRegistry;
  root: string;
  cwd: string;
  git?: GitRunner;
}): Promise<OrphanedBlock[]> {
  const holdings = await readHoldings(options.cwd, options.git);
  if (holdings.shared) {
    throw new InternalError({
      message: "This checkout is in a bare repository or a submodule, whose registry key other repositories can share.",
      action:
        "Free these blocks with pithy feature destroy from each feature's worktree. Prune cannot judge blocks other repositories may hold.",
      detail: `The registry key is ${holdings.root}, the directory holding this repository's git dir.`,
    });
  }
  if (holdings.root !== options.root) {
    throw new InternalError({
      message: "This repository is not the checkout the registry key names.",
      action: "Run pithy feature prune from the checkout whose blocks it should free.",
      detail: `This repository's key is ${holdings.root}; the registry key is ${options.root}.`,
    });
  }
  return orphanedFeatureBlocks(options.registry[holdings.root], holdings);
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
 * Free every feature block under this checkout's root whose worktree directory and branch are both gone
 * (#637) — every block {@link isBlockHeld} does not hold.
 *
 * The real run decides and frees in one locked read-modify-write — the listing is taken under the lock
 * too, so a `pithy feature create` that adds a worktree cannot land between the answer and the free. A
 * dry run reads, the way `pithy doctor` does, and takes no lock: nothing is written, not even the lock
 * file, and the registry is byte-identical afterward.
 */
export async function pruneFeatureBlocks(options: {
  /** The checkout this runs from. Never swept: it is on disk. */
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
