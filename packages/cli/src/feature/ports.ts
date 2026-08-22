// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFile } from "node:child_process";
import { open, stat, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fromZodError, InternalError } from "@pithy-sh/core/src/error/pithyError";
import { z } from "zod";
import { ensureOwnerOnlyDirFor } from "../devSecrets/mode";
import { type StatePathOptions, stateDir } from "../notifier/state";
import { writeFileAtomic } from "../project/atomic";
import { readOptionalFile } from "../project/readOptionalFile";
import { canonicalRepoPath } from "./worktree";

const execFileAsync = promisify(execFile);

/**
 * The remedy for a file that is there and would not open, chosen from the errno (#217).
 *
 * `readOptionalFile`'s `unreadable` is **every errno but `ENOENT`**. *Check permissions on X* answers
 * one of them, and a registry that is a directory, a symlink loop, or a failing disk got the same
 * sentence. See `manifest.ts` for the same helper over the same decision, and for why two copies are
 * under this repository's threshold for hoisting it.
 */
function unreadableAction(code: string | undefined, name: string): string {
  switch (code) {
    case "EACCES":
    case "EPERM":
      return `Check permissions on ${name}.`;
    case "EISDIR":
      return `${name} is a directory, not a file. Remove it, then re-run.`;
    case "ELOOP":
      return `${name} is a symlink loop. Replace it with a regular file, then re-run.`;
    default:
      return `${name} is there and would not open (${code ?? "unknown error"}). Check that file, then re-run.`;
  }
}

/**
 * The remedy for a registry that will not parse. One function because it is one sentence, and it used to
 * be written out at both throw sites — which is how two copies of a sentence drift.
 *
 * **It names the absolute path, not the file name.** The registry left the checkout in #435, so *delete
 * `.dev-ports.json`* names a file no `ls` in the project finds and no editor's file tree reaches. Same
 * argument `pithy doctor`'s `Secrets:` line is built on: knowing a file is broken is not the same as
 * having a way to get at it.
 */
function corruptAction(registryPath: string): string {
  return `Delete ${registryPath} and re-run pithy feature create to rebuild it.`;
}

/** Read a property off an unknown throwable without widening anything to `any`. */
function prop(cause: unknown, key: string): unknown {
  if (typeof cause !== "object" || cause === null) return undefined;
  return (cause as Record<string, unknown>)[key];
}

/**
 * The remedy for a failed `git rev-parse`, chosen from the failure (#217).
 *
 * *Run pithy from inside a git repository* is right for one of the three ways this can fail, and it is
 * the one an adopter is least likely to be in — a machine without `git` on PATH fails to **spawn**, and
 * the sentence tells them to go somewhere they already are. Duck-typed on purpose: `execFile`'s rejection
 * is not required to be an `Error` subclass by anything the CLI controls, and its `code` is a string
 * errno for a spawn failure and a number for a non-zero exit.
 */
function gitResolveAction(cause: unknown): string {
  const code = prop(cause, "code");
  if (code === "ENOENT") return "Install git, or put it on PATH, then re-run.";
  const stderr = prop(cause, "stderr");
  const text = typeof stderr === "string" ? stderr : "";
  if (/not a git repository|this operation must be run in a work tree/i.test(text)) {
    return "Run pithy from inside a git repository.";
  }
  return "git rev-parse --git-common-dir failed. Run it here to see why, then re-run.";
}

/** First port of block 0. */
export const BASE_PORT = 8787;
/**
 * Ports per feature block — one port per member of the dev set, so the width is a ceiling on what
 * `pithy dev` can start.
 *
 * **Sized for `apps/*` plus every composed capability host** (pithy-sh/pithy#410). A host Worker is an
 * ordinary member of the dev set and takes a pinned port like any other, and the kit ships eight of
 * them. Ten covered a default two-Worker scaffold composing all of them *exactly*, so a third Worker
 * turned `pithy dev` into a refusal to start anything. `ports.test.ts` pins the width against the host
 * registry, so a ninth capability host fails there rather than in somebody's session.
 */
export const BLOCK_SIZE = 20;

/** How many times `withLock` retries acquiring the lock before giving up. */
export const LOCK_MAX_ATTEMPTS = 50;
/** Delay between lock-acquire retries, in ms. */
export const LOCK_RETRY_DELAY_MS = 100;

/**
 * How long a caller is willing to wait for the lock. Both values default to the two constants above,
 * which are what every command uses; nothing in the CLI passes this.
 *
 * **It exists so a test can assert the rule rather than the clock** (#194). The one test that has to
 * *exhaust* the budget — a fresh lock must not be reclaimed, so every retry must fail — cost
 * `LOCK_MAX_ATTEMPTS × LOCK_RETRY_DELAY_MS`, which is 5000ms, which is vitest's default timeout to the
 * millisecond. It passed on an idle machine and failed on a busy one, having proved nothing that three
 * attempts at 10ms do not: the assertion is that a fresh lock survives a spent budget, and the size of
 * the budget is not part of it. Two unrelated numbers matching is what made it marginal, and a test one
 * scheduling hiccup from red now runs on every pull request (#173).
 */
export interface LockBudget {
  /** Attempts before giving up. Defaults to {@link LOCK_MAX_ATTEMPTS}. */
  maxAttempts?: number;
  /** Delay between attempts, in ms. Defaults to {@link LOCK_RETRY_DELAY_MS}. */
  retryDelayMs?: number;
}
/**
 * A lock file older than this is treated as abandoned, not held. A legitimate hold only ever spans one
 * registry read-modify-write — a single small JSON file, no network calls — so it never approaches this.
 * Anything this old can only be a lock a process left behind by dying mid-hold (Ctrl-C, SIGKILL), which
 * used to brick the registry — and, worse, block `feature destroy` teardown — forever. 30s leaves a wide
 * margin over real hold times while still recovering promptly.
 */
export const LOCK_STALE_MS = 30_000;

/** A contiguous block of ports assigned to one feature branch. */
export const PortBlock = z
  .object({
    block: z.number().int().nonnegative().describe("The block index (0-based)."),
    base: z.number().int().positive().describe("The first port in the block."),
    size: z.number().int().positive().describe("How many ports the block spans."),
  })
  .describe("A contiguous block of ports assigned to one feature branch.");
export type PortBlock = z.output<typeof PortBlock>;

/** One checkout's allocations: branch name → its allocated block. */
export const RepoPortBlocks = z
  .record(z.string().describe('A branch name, e.g. "feature/69-media-cli".'), PortBlock)
  .describe("One main checkout's allocations: branch name → its allocated block.");
export type RepoPortBlocks = z.output<typeof RepoPortBlocks>;

/**
 * The registry file shape: absolute main-checkout root → branch → its allocated block.
 *
 * **Keyed on the checkout, not the project name (#435).** The file is machine-wide now, so the key is
 * the only partition left, and a project `name` is not one: `devSecrets/location.ts` already documents
 * that two unrelated projects both called `app` collide on it, and here that collision would hand them
 * the same ports — the exact defect this key exists to prevent. The root is also the key the pruner
 * asks the filesystem about, which is what stops a machine-lifetime file from growing forever.
 */
export const PortsRegistry = z
  .record(z.string().describe("The absolute path of a main checkout root."), RepoPortBlocks)
  .describe("The registry file shape: absolute main-checkout root → branch → its allocated block.");
export type PortsRegistry = z.output<typeof PortsRegistry>;

/** Inputs to `allocatePortBlock`. */
export interface AllocateOptions {
  /** Absolute path to the registry — `<config>/dev-ports.json`, see {@link portsRegistryPath}. */
  registryPath: string;
  /** The absolute main-checkout root this branch belongs to — the registry's outer key. */
  root: string;
  /** The feature branch key, e.g. "feature/69-media-cli". */
  branch: string;
  /** Ports per block (default BLOCK_SIZE). */
  size?: number;
  /** How long to wait for the registry lock. Defaults to the production budget — see {@link LockBudget}. */
  lock?: LockBudget;
}

/** Inputs to `freePortBlock`. */
export interface FreeOptions {
  /** Absolute path to the registry — `<config>/dev-ports.json`, see {@link portsRegistryPath}. */
  registryPath: string;
  /** The absolute main-checkout root the branch belongs to — the registry's outer key. */
  root: string;
  /** The feature branch key to release. */
  branch: string;
  /** How long to wait for the registry lock. Defaults to the production budget — see {@link LockBudget}. */
  lock?: LockBudget;
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/** Identifying content written into a freshly-acquired lock file, so a stuck one can be diagnosed by hand. */
function lockContents(): string {
  return JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() });
}

/**
 * If `lockPath` is older than `LOCK_STALE_MS`, remove it so the next `open(lockPath, "wx")` attempt can
 * succeed. Staleness is judged from the file's own mtime, not its JSON content — the content write happens
 * a moment after the atomic create, so trusting mtime avoids treating that narrow window as corrupt.
 *
 * Never assumes the removal wins: another process racing the same stale lock may reclaim or release it
 * first, in which case this is a harmless no-op and the caller's next `open` attempt settles who gets it.
 */
async function reclaimIfStale(lockPath: string): Promise<void> {
  let mtimeMs: number;
  try {
    ({ mtimeMs } = await stat(lockPath));
  } catch {
    return; // Already gone — released or reclaimed by someone else. The next open() attempt will settle it.
  }

  if (Date.now() - mtimeMs < LOCK_STALE_MS) {
    return; // Fresh enough that another process may genuinely be holding it.
  }

  await unlink(lockPath).catch(() => {}); // Tolerate losing the race to reclaim it.
}

/**
 * Acquire an advisory lock on `${registryPath}.lock`, retrying until it succeeds or times out. A lock
 * left behind by a process that died mid-hold is reclaimed once it goes stale (see `LOCK_STALE_MS`)
 * instead of bricking the registry forever.
 */
async function acquireLock(registryPath: string, budget: LockBudget = {}): Promise<string> {
  const lockPath = `${registryPath}.lock`;
  const maxAttempts = budget.maxAttempts ?? LOCK_MAX_ATTEMPTS;
  const retryDelayMs = budget.retryDelayMs ?? LOCK_RETRY_DELAY_MS;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(lockContents());
      } finally {
        await handle.close();
      }
      return lockPath;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        await reclaimIfStale(lockPath);
      }
      await sleep(retryDelayMs);
    }
  }
  // The budget that was actually spent, not the constant — a refusal naming 50 after 3 attempts is a
  // refusal that sends the reader to the wrong number.
  throw new InternalError({
    message: "Could not lock the port registry.",
    action: `If no other pithy process is running, delete ${lockPath} by hand and retry.`,
    detail: `Timed out acquiring ${lockPath} after ${maxAttempts} attempts (stale threshold ${LOCK_STALE_MS}ms).`,
  });
}

/** Release the advisory lock, swallowing any error (e.g. already removed). */
async function releaseLock(lockPath: string): Promise<void> {
  await unlink(lockPath).catch(() => {});
}

/**
 * Make sure the directory holding the registry exists, before anything tries to open a file in it.
 *
 * **The lock cannot report this failure (#435).** `acquireLock` opens `${registryPath}.lock` with `"wx"`
 * and treats every errno that is not `EEXIST` the same way — sleep, retry — so a missing config directory
 * would spend the whole 50 × 100ms budget and then refuse with *delete the lock file by hand*, naming a
 * file that was never created inside a directory that does not exist. Loudly wrong about the wrong thing,
 * and it reads as a lock bug forever. The registry left the checkout, so its directory is no longer one
 * some earlier command already made — and on a fresh machine this can be the first thing to create it.
 *
 * **Which is why it goes through {@link ensureOwnerOnlyDirFor} and not a bare `mkdir`.** `<config>` itself
 * is `0700`: `cloudflare.json` sits directly in it, and the writer that mints one narrows this exact
 * directory on every write. A private `mkdir` here would be the fourth writer under this root, and
 * `mode.ts` says in as many words what the fourth writer does — *a private copy per writer is how the
 * third one lands at the umask default*. First command on a new machine being `pithy dev` would leave
 * `~/.config/pithy` at `0755` for as long as nobody happened to write a credential.
 *
 * A failure is a `PithyError` like every other refusal in this module. The raw errno out of `mkdir` would
 * surface through `allocatePortBlock` with no action line, from a path the operator cannot see.
 */
async function ensureRegistryDir(registryPath: string): Promise<void> {
  try {
    await ensureOwnerOnlyDirFor(registryPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new InternalError({
      message: "Could not open the Pithy config directory.",
      action: `${unreadableAction(code, dirname(registryPath))} It holds the dev port registry; PITHY_CONFIG_DIR moves it.`,
      detail: `${code ?? "unknown error"}: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

/** Run `fn` while holding the advisory lock on `registryPath`, always releasing it after. */
async function withLock<T>(registryPath: string, fn: () => Promise<T>, budget?: LockBudget): Promise<T> {
  await ensureRegistryDir(registryPath);
  const lockPath = await acquireLock(registryPath, budget);
  try {
    return await fn();
  } finally {
    await releaseLock(lockPath);
  }
}

/**
 * Read the registry file. A **missing** file is an empty registry; invalid JSON/shape throws
 * `InternalError`, and so does one that is there and will not open.
 *
 * That distinction is {@link readOptionalFile}'s. It matters here as much as anywhere: every writer
 * below is a read-modify-write, so a registry read as empty is a registry rewritten holding only this
 * branch — and every other feature's block handed straight back out.
 *
 * **Exported for `pithy doctor`'s listing (#436), which reads it and never writes.** One reader, because
 * the alternative is a second, laxer parse of the same file: doctor would then print rows an allocation
 * refuses to touch, or an empty listing for a registry that is simply corrupt — and "nothing holds any
 * ports" is the opposite of what a corrupt registry means. The throw is the report's material, not a
 * problem for it; the caller catches it and says so on the line.
 */
export async function readPortsRegistry(registryPath: string): Promise<PortsRegistry> {
  const raw = await readOptionalFile(registryPath, {
    unreadable: ({ code, cause }) =>
      new InternalError({
        message: "Could not read the port registry.",
        action: unreadableAction(code, registryPath),
        detail: `${code ?? "unknown error"}: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  });
  if (raw === null) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new InternalError({
      message: "The port registry is corrupt.",
      action: corruptAction(registryPath),
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  const result = PortsRegistry.safeParse(parsed);
  if (!result.success) {
    throw fromZodError(result.error, {
      message: "The port registry is corrupt.",
      action: corruptAction(registryPath),
    });
  }

  return result.data;
}

/**
 * Whether a checkout root is still on disk.
 *
 * **Only a definite `ENOENT` is absence.** Every other errno is the process failing to *reach* the path
 * rather than the path being gone — a repo under a mount that is not up, a `PITHY_CONFIG_DIR` on a
 * network share, a parent that stopped being a directory. Treating those as gone deletes a live
 * checkout's whole allocation set in one atomic write, and the reclaim scan that could rebuild it cannot
 * run for a root this process could not stat either.
 *
 * **Exported so `pithy doctor`'s listing marks the same roots this would sweep (#436).** The report's one
 * actionable line is *this checkout is gone and its blocks are about to be freed*, and a second answer to
 * "is it there" would let doctor promise a sweep the pruner does not make, or stay silent about one it does.
 */
export async function registryRootExists(root: string): Promise<boolean> {
  try {
    await stat(root);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

/**
 * Drop every checkout that is gone from disk, and every one left holding no branches. Returns whether
 * anything changed, so the caller knows whether a write is owed.
 *
 * **This is what pays for the file being machine-wide (#435).** At the main repo root the registry died
 * with the checkout, so `rm -rf` freed a project's ports for nothing. In the config directory nothing
 * ever frees them, and a file that only grows is a file whose block indices only climb.
 *
 * `keep` is never pruned. The root being allocated for is the caller's own answer to "where am I", and a
 * seam may legitimately hand over one that does not exist on disk; refusing to prune it costs nothing and
 * removes a way for this function to delete the allocation it was called to make.
 *
 * **It cannot tell a deleted checkout from a moved one, and does not try.** Both are `ENOENT`, and the
 * only thing that could separate them is a record of where a repository used to be — which is a second
 * source of truth about identity, kept in the file whose whole problem was that it outlives what it
 * describes. A moved repository's blocks are freed, and the next `pithy dev` in it re-registers the block
 * its `.dev.config.json` still pins — see `ensureDevConfig`, which had to start doing that on the pinned
 * path before this sentence was true of the command anybody runs. The window in between is one where
 * another project can be handed one, and `pithy dev`'s dual-stack port check turns that into a reported
 * conflict rather than two Workers on one port.
 */
async function pruneDeadRoots(registry: PortsRegistry, keep: string): Promise<boolean> {
  let changed = false;
  for (const root of Object.keys(registry)) {
    if (root === keep) continue;
    const branches = registry[root];
    if (Object.keys(branches ?? {}).length === 0 || !(await registryRootExists(root))) {
      delete registry[root];
      changed = true;
    }
  }
  return changed;
}

/** Write the registry file atomically as pretty-printed JSON with a trailing newline. */
async function writeRegistry(registryPath: string, registry: PortsRegistry): Promise<void> {
  await writeFileAtomic(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
}

/**
 * The lowest block index that is neither taken nor overlapping a block already in the registry.
 *
 * The index alone is not enough, and that is the whole reason this takes the ranges. A block's ports
 * are `BASE_PORT + index × size`, so two allocations of the *same* width can never overlap and the
 * index is the whole answer — but a registry written before {@link BLOCK_SIZE} changed keeps its own
 * entries verbatim, and a wide block 2 lands straight through a narrow block 4's ports. Two features
 * would then bind one port, which is the collision this whole registry exists to prevent.
 */
function lowestFreeBlock(taken: ReadonlySet<number>, size: number, held: readonly PortBlock[]): number {
  const clashes = (base: number): boolean =>
    held.some((block) => base < block.base + block.size && base + size > block.base);
  let i = 0;
  while (taken.has(i) || clashes(BASE_PORT + i * size)) {
    i++;
  }
  return i;
}

/**
 * Allocate (or return the existing) port block for a branch, under a file lock. Idempotent: if the
 * branch already has a block, returns it unchanged. Otherwise assigns the LOWEST free block index not
 * overlapping any taken block, writes the registry atomically, and returns it.
 */
export async function allocatePortBlock(options: AllocateOptions): Promise<PortBlock> {
  const { registryPath, root, branch } = options;
  const size = options.size ?? BLOCK_SIZE;

  return withLock(
    registryPath,
    async () => {
      const registry = await readPortsRegistry(registryPath);
      const pruned = await pruneDeadRoots(registry, root);

      const existing = registry[root]?.[branch];
      if (existing) {
        // Deliberately still a write when something was pruned. Pruning is the *only* thing that frees a
        // deleted project's ports, and a machine whose whole steady state is `pithy dev` on branches it
        // already allocated never reaches the path below — so pruning only there would let the file grow
        // for the life of the machine while block indices climbed past every dead checkout.
        if (pruned) await writeRegistry(registryPath, registry);
        return existing;
      }

      // Every block in every checkout, because the file is machine-wide now: a taken-set built from one
      // root's blocks would put every project back at block 0, which is #435 reintroduced one flatMap up.
      const held = Object.values(registry).flatMap((branches) => Object.values(branches));
      const taken = new Set(held.map((entry) => entry.block));
      const block = lowestFreeBlock(taken, size, held);
      const allocated: PortBlock = { block, base: BASE_PORT + block * size, size };

      const branches = registry[root] ?? {};
      branches[branch] = allocated;
      registry[root] = branches;
      await writeRegistry(registryPath, registry);

      return allocated;
    },
    options.lock,
  );
}

/**
 * Re-register blocks that a worktree already holds but the registry has lost, under the lock.
 *
 * **What it guards narrowed in #435, and it did not go away.** At the main repo root the registry was
 * git-ignored, so a fresh clone or a stray `git clean` took it while the worktrees allocated from it
 * lived on with their ports pinned in `.dev.config.json`. In the config directory no checkout operation
 * can reach it — only a wiped config directory, a new machine, or a `PITHY_CONFIG_DIR` pointed somewhere
 * else. Rarer, and identical in consequence: without this the next allocation restarts at block 0 and
 * hands out a block a live feature is already using.
 *
 * Reservations belong to **one** checkout, named by `root` — a worktree scan can only speak for the
 * repository it walked, and writing its branches under anyone else's key is how one project's recovery
 * would corrupt another's allocations.
 *
 * Only fills gaps: a branch already in the registry is left exactly as it is, so this never overwrites a
 * live allocation. Returns the branches it re-registered.
 */
export async function reclaimPortBlocks(options: {
  /** The central registry path — `<config>/dev-ports.json`, see {@link portsRegistryPath}. */
  registryPath: string;
  /** The absolute main-checkout root the reservations were scanned from. */
  root: string;
  /** Blocks observed on disk, one per existing worktree. */
  reservations: { branch: string; block: PortBlock }[];
  /** How long to wait for the registry lock. Defaults to the production budget — see {@link LockBudget}. */
  lock?: LockBudget;
}): Promise<string[]> {
  if (options.reservations.length === 0) return [];

  return withLock(
    options.registryPath,
    async () => {
      const registry = await readPortsRegistry(options.registryPath);
      const branches = registry[options.root] ?? {};
      registry[options.root] = branches;
      const reclaimed: string[] = [];
      for (const { branch, block } of options.reservations) {
        if (branch in branches) continue; // a live allocation always wins.
        branches[branch] = block;
        reclaimed.push(branch);
      }
      if (reclaimed.length > 0) await writeRegistry(options.registryPath, registry);
      return reclaimed;
    },
    options.lock,
  );
}

/** Free a branch's block under the lock (idempotent: a missing branch/checkout/registry is a no-op). */
export async function freePortBlock(options: FreeOptions): Promise<void> {
  const { registryPath, root, branch } = options;

  await withLock(
    registryPath,
    async () => {
      const registry = await readPortsRegistry(registryPath);
      const branches = registry[root];
      if (branches === undefined || !(branch in branches)) {
        return;
      }
      delete branches[branch];
      // A checkout holding nothing is not a checkout the registry has anything to say about, and leaving
      // the empty object behind would keep a deleted project in the file until the pruner reached it.
      if (Object.keys(branches).length === 0) delete registry[root];
      await writeRegistry(registryPath, registry);
    },
    options.lock,
  );
}

/**
 * `<config>/dev-ports.json` — one port space per machine, spanning every checkout on it (#435).
 *
 * **At the config root, not `<config>/<project>/`.** A per-project directory is the partition this file
 * moved to get rid of: the registry sat at each main repo root, so every project kept its own, every one
 * started empty, and every one handed out block 0 — two projects on their default branch bound the same
 * twenty ports before either had done anything unusual. Nesting it under a project name would put the
 * same defect back one directory down.
 *
 * The resolution is {@link stateDir}'s, unchanged and unrepeated — `$PITHY_CONFIG_DIR`, then
 * `%APPDATA%\pithy`, then `$XDG_CONFIG_HOME/pithy`, then `~/.config/pithy`. Two implementations of "where
 * does config live" is the defect shape `devSecrets/location.ts` names, and the Windows branch is the
 * half a second one forgets.
 */
export function portsRegistryPath(options: StatePathOptions = {}): string {
  // The name is inline, not a constant. `state.test.ts` decides from the text whether a segment joined
  // onto `stateDir()` is safe, and the only two answers it takes are a literal this repository typed and
  // a validator's return — a `const` reads as neither. Undotted, on the `state.json` rule: nothing here
  // is hidden from anything.
  return join(stateDir(options), "dev-ports.json");
}

/**
 * The main checkout's root, from any cwd inside the repository — the main checkout itself or any of its
 * worktrees. This is the registry's outer key.
 *
 * It used to be welded to the registry's location, because they were the same answer: the file sat at
 * this path. They are different questions now, and a single function that answered both would be a
 * second derivation of a location that has exactly one (#435).
 */
export async function resolveMainRepoRoot(cwd: string): Promise<string> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("git", ["rev-parse", "--git-common-dir"], { cwd }));
  } catch (err) {
    // Three failures reach here and one sentence used to answer all of them (#217). `git` absent from
    // PATH is a spawn `ENOENT` and no amount of standing in a repository fixes it; a non-repository is
    // the exit-128 case the sentence was written for; anything else gets no remedy, only git's own words.
    // Duck-typed: `code` is the string errno on a spawn failure and the numeric exit status otherwise.
    throw new InternalError({
      message: "Could not resolve the repo's git directory.",
      action: gitResolveAction(err),
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  const commonDir = stdout.trim();
  const absoluteCommonDir = isAbsolute(commonDir) ? commonDir : resolve(cwd, commonDir);
  const root = dirname(absoluteCommonDir);

  // **Canonical, because the root is a key now and not a place to put a file** (#435). The same helper
  // `mainRepoRoot` uses, and it has to be both of them: canonicalising one side alone fixes POSIX and
  // breaks Windows, where git's forward slashes matched `dirname`'s output and stop matching
  // `realpath`'s. See {@link canonicalRepoPath} for both divergences and why neither shows up in CI.
  return canonicalRepoPath(root);
}

/**
 * The registry key for a project directory, repository or not — {@link resolveMainRepoRoot}, and the
 * project's own canonical path when there is no repository to ask.
 *
 * **One function because two callers must produce the same key or the registry lies** (#436). `pithy dev`
 * allocated through this fallback while `pithy doctor` had its own, narrower answer, so on a machine with
 * no `git` — or in a project that is not a repository — `dev` filed a block under the project directory
 * and `doctor` reported that very block as some other checkout's, `own: false` and all. Every caller that
 * wants "which key are my blocks under" asks here; only a caller that must *refuse* without a repository
 * (`feature destroy`) reaches past it to `resolveMainRepoRoot`.
 *
 * Never rejects: {@link canonicalRepoPath} answers the uncanonicalised path rather than throwing, so the
 * fallback always produces a key.
 */
export async function registryRootFor(projectDir: string): Promise<string> {
  try {
    return await resolveMainRepoRoot(projectDir);
  } catch {
    // Canonical for the same reason `resolveMainRepoRoot` is: the answer is a registry key, and a project
    // reached once through a symlink and once through the real path would occupy two of them.
    return canonicalRepoPath(projectDir);
  }
}
