// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { stat } from "node:fs/promises";
import { join } from "node:path";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { portsRegistryPath, readPortsRegistry, registryRootExists, registryRootFor } from "../feature/ports";
import type { StatePathOptions } from "../notifier/state";

/**
 * One allocated block, flattened out of the registry's two levels of keys and told apart from its
 * neighbors (#436).
 *
 * Flat rather than nested because the listing is a number line: the question it answers is *what holds
 * 8827*, and a shape that has to be walked root-by-root to answer it is a shape the renderer would
 * flatten anyway. Nothing is recorded here that the registry does not already hold — `own` and `onDisk`
 * are the two facts about a row that the file cannot state about itself.
 */
export interface PortsRegistryEntry {
  /** The absolute main-checkout root that holds the block — the registry's outer key. */
  root: string;
  /** The branch the block is pinned to, e.g. `feature/12-auth`. */
  branch: string;
  /** The block index. Reported for `--json`; the text listing prints the range, which is the legible form. */
  block: number;
  /** The first port in the block. */
  base: number;
  /** How many ports the block spans. Registries written before `BLOCK_SIZE` changed carry mixed widths. */
  size: number;
  /**
   * Whether this block belongs to the checkout doctor is being run in.
   *
   * The report's two halves: own blocks answer "which ports am I on", everything else answers "and who
   * took the ones I am not on". `false` for every row when the root would not resolve — see
   * {@link PortsRegistryCheck.root}.
   */
  own: boolean;
  /**
   * Whether the root is still on disk, on `registryRootExists`' rule — only a definite `ENOENT` is absence.
   *
   * `false` is the one line in this report a developer can act on, and the only place it can ever be
   * said. Pruning cannot tell a deleted checkout from a moved one; it frees the blocks either way and
   * nothing anywhere reports that it happened. This row is taken **before** the sweep.
   */
  onDisk: boolean;
}

/**
 * Where this machine's dev-port registry is, what is in it, and whether an older CLI left one behind in
 * the checkout.
 *
 * **Why a diagnostic owns this at all.** The registry moved out of the main repo root in #435, and being
 * inside the checkout was the only thing that ever made it findable: it was git-ignored, but it was
 * *there* — in the file tree the developer already had open, in the `ls` they already ran. In the config
 * directory it is a file that decides every port `pithy dev` binds and that nothing in the project
 * mentions. `pithy doctor` already reports `Config dir:` and the dev-secrets file for exactly this
 * reason; this is the third of the same kind.
 *
 * **And why it reads the file rather than pointing at it (#436).** Naming the path answered *where*, and
 * left *why is this project on 8847* with no answer short of `cat`. The registry already holds every fact
 * the listing needs — it is `root → branch → PortBlock`, Zod-validated on read — so nothing new is
 * recorded anywhere to support this. It is the report, from the one record.
 *
 * **A location, never a fault.** Nothing here fails the exit code. The absent state is the correct state
 * on a machine that has not run `pithy feature create` yet, a stray file is untidy rather than broken,
 * and a checkout that is gone from disk is information — a stale root failing CI would be absurd.
 */
export interface PortsRegistryCheck {
  /**
   * The resolved absolute path, whether or not the file exists. Always set: telling a developer where the
   * file *would* go is most of what this check is for. The text renderer abbreviates it against `$HOME`;
   * `--json` carries it whole.
   */
  path: string;
  /** Whether the registry is on disk yet. */
  present: boolean;
  /**
   * A `.dev-ports.json` still sitting at this checkout's root, or `null`.
   *
   * Left by a CLI that predates #435. Nothing reads it, and nothing ever will — so it is neither a fault
   * nor something the CLI should delete on someone's behalf. It is named so that the developer wondering
   * why editing it changes no ports gets an answer, and so it gets deleted by the person who owns it.
   *
   * **Checked at `projectDir`, not at the main checkout root.** From a worktree those differ, and the
   * stray file is at the main root, which is where doctor is usually run. Unchanged by #436's resolving
   * that root: the resolution is allowed to fail, so a stray hunted through it would go unreported on the
   * machines that have no git — and untidy-but-silent is the smaller failure.
   */
  stray: string | null;
  /**
   * This checkout's main repo root — the registry key its own blocks are filed under — or `null` when
   * even the fallback would not answer.
   *
   * **`registryRootFor`, which is the key `pithy dev` allocates under, and never a second derivation of
   * it.** `git rev-parse` is what makes a worktree's blocks show as its own — the worktree's directory is
   * not the registry key, the main checkout's is — and where there is no repository the project's own
   * canonical path is the key, because that is what `dev` files under there. Asking `rev-parse` alone
   * reported a machine-with-no-git its own block as some other checkout's.
   *
   * `null` is unreachable through the default, which cannot reject; it is the state left for a
   * {@link PortsRegistryOptions.resolveRoot} seam that throws. The listing still prints — every row is
   * then somebody else's, which is more than the path-only line ever said.
   */
  root: string | null;
  /**
   * Why the registry could not be read and what to do about it, or `null`. `entries` is empty either way,
   * and the difference is everything: an unreadable registry is one `pithy dev` refuses to allocate
   * against at all, and a listing that showed it as empty would report the exact opposite of what is true.
   *
   * **The `action` is carried, not dropped.** It is the half naming the fix — *delete this file and
   * re-run `pithy feature create`*, *it is a directory, not a file* — and the audience on both surfaces
   * this reaches is the operator, whose field it is. The message alone told a developer their registry
   * was corrupt and left them to work out the rest, while the same failure through `pithy dev` named it.
   */
  unreadable: string | null;
  /**
   * Every block in the registry, this checkout's first and each set in port order.
   *
   * Own blocks lead because *which ports do I hold* is the question asked most; the rest follow as a
   * number line, which is what turns "8847, and I don't know why" into "because `other-app` holds
   * 8827–8846". Empty when there is no file yet, and when there is one nothing could read.
   */
  entries: PortsRegistryEntry[];
}

/** Inputs to {@link checkPortsRegistry} — the config-directory resolution, plus the one seam a test needs. */
export interface PortsRegistryOptions extends StatePathOptions {
  /**
   * How the registry key for this project is resolved. Defaults to {@link registryRootFor} — the same
   * function `pithy dev` allocates under, so the two cannot disagree about which blocks are this
   * checkout's.
   *
   * A seam because the default spawns `git`, and a suite that had to build a repository to assert which
   * rows are its own would be testing git.
   */
  resolveRoot?: (cwd: string) => Promise<string>;
}

/** Whether a path is a readable file. Never throws: an unreachable path is simply not a file we found. */
async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** The legacy location — the one every project carried before #435. */
const LEGACY_REGISTRY_FILE_NAME = ".dev-ports.json";

/**
 * The checkout root, or `null` if it would not resolve.
 *
 * The whole reason this check can afford a `git` spawn it was written to avoid: the answer is which rows
 * are yours, and no cheaper question produces it. Guarded, so the contract that this never throws is the
 * catch rather than the absence of the call — the default cannot reach it, and an injected seam can.
 */
async function ownRoot(projectDir: string, resolveRoot: (cwd: string) => Promise<string>): Promise<string | null> {
  try {
    return await resolveRoot(projectDir);
  } catch {
    return null;
  }
}

/**
 * A failure as the operator needs it: what went wrong, then what to do. Both halves, because both are
 * theirs — see {@link PortsRegistryCheck.unreadable}.
 */
function operatorSentence(err: unknown): string {
  if (err instanceof PithyError) {
    const { message, action } = err.payload;
    return action ? `${message} ${action}` : message;
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * Read the registry, or say why not. One reader with the allocator (`readPortsRegistry`), so doctor can
 * never list a row an allocation would refuse to touch.
 */
async function readEntries(
  registryPath: string,
  root: string | null,
): Promise<{ entries: PortsRegistryEntry[]; unreadable: string | null }> {
  let registry: Awaited<ReturnType<typeof readPortsRegistry>>;
  try {
    registry = await readPortsRegistry(registryPath);
  } catch (err) {
    return { entries: [], unreadable: operatorSentence(err) };
  }

  const entries: PortsRegistryEntry[] = [];
  for (const [entryRoot, branches] of Object.entries(registry)) {
    const onDisk = await registryRootExists(entryRoot);
    for (const [branch, block] of Object.entries(branches)) {
      entries.push({ root: entryRoot, branch, ...block, own: entryRoot === root, onDisk });
    }
  }
  // Own first, then a number line. `base` alone would interleave the two halves, and a registry holding
  // mixed block widths (#435 left some at 10) has no index order that reads as one anyway.
  entries.sort((a, b) => Number(b.own) - Number(a.own) || a.base - b.base || a.branch.localeCompare(b.branch));
  return { entries, unreadable: null };
}

/**
 * Resolve the registry path, read what is in it, and look for a stray legacy file beside the checkout.
 *
 * Never throws, on the rule every probe in this report follows: a diagnostic that can fail the command it
 * is diagnosing is worse than one that says less.
 */
export async function checkPortsRegistry(
  projectDir: string,
  options: PortsRegistryOptions = {},
): Promise<PortsRegistryCheck> {
  const path = portsRegistryPath(options);
  const legacy = join(projectDir, LEGACY_REGISTRY_FILE_NAME);
  const root = await ownRoot(projectDir, options.resolveRoot ?? registryRootFor);
  const { entries, unreadable } = await readEntries(path, root);
  return {
    path,
    present: await isFile(path),
    stray: (await isFile(legacy)) ? legacy : null,
    root,
    unreadable,
    entries,
  };
}

/**
 * The verdict half of the `Ports:` line, or `null` when the path alone says everything.
 *
 * Ordered by what a developer can do about it. An unreadable registry wins outright: every other state
 * here is about a file that works, and this one is a file no allocation will get past — the listing under
 * it is empty for that reason and not for the innocent one. The stray comes next, because "the file you
 * can see is not the file in use" is the sentence that closes a gap nothing else can, and it is worth
 * more than restating that the real registry is present.
 */
export function describePortsRegistry(check: PortsRegistryCheck): string | null {
  if (check.unreadable !== null) {
    // Three short sentences rather than one nested in a parenthesis: the listing is missing, here is why,
    // here is the fix. The last of those is the error's own `action`, which is the operator's field.
    return `could not be read. ${check.unreadable}`;
  }
  if (check.stray !== null) {
    return `${check.stray} is left over and nothing reads it — delete it`;
  }
  if (!check.present) {
    return "no file yet; the first pithy dev or feature create writes it";
  }
  return null;
}
