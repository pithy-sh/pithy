// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { lstat, readlink, stat, symlink, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
// `project/scaffold` imports this module back, for `pithy init`'s own wiring. The cycle is real and it is
// harmless: both sides reach across only from inside a function body, so neither is evaluated before the
// other has finished. The alternative was a second copy of the gate, which is the mistake this whole
// series has been undoing.
import { ensureScaffoldPath } from "../project/scaffold";
import type { WorkerTarget } from "../project/workers";

/**
 * `.dev.vars` is **one shared file for the whole repo**: the main checkout owns it, and every worktree —
 * and every worker inside a worktree — symlinks to it. wrangler loads one `.dev.vars` from each worker's
 * own directory and does not merge, so the symlink is what gives every worker the same team secrets from a
 * single source of truth; editing the main checkout's file propagates everywhere at once, with no copies to
 * drift.
 *
 * That sharing is precisely why per-feature values do **not** live here — one feature's ports would clobber
 * another's. Those live in the per-worktree `.dev.config.json` ({@link ./devConfig}).
 */

/** One directory the wiring did not touch, and why — so a caller can name it rather than pass over it. */
export interface KeptDevVars {
  /** The directory whose `.dev.vars` was left as it is. */
  dir: string;
  /** `file`: a real `.dev.vars` is there. `link`: a symlink that reaches a file other than the shared one. */
  reason: "file" | "link";
  /** For `reason: "link"`, where the link ends up — the path a caller reports. */
  points?: string;
}

/** The outcome of {@link wireFeatureDevVars}: the shared file linked to, and what happened at each target. */
export interface WireDevVarsResult {
  /** The shared `.dev.vars` in the main checkout that everything points at, or null when it has none. */
  source: string | null;
  /** The directories whose `.dev.vars` reaches the shared file — newly linked, or already pointing at it. */
  wired: string[];
  /**
   * The directories left alone, with the reason. Reported rather than replaced — see the policy on
   * {@link wireFeatureDevVars} — so a caller can say so.
   */
  kept: KeptDevVars[];
}

/**
 * Point the worktree — and each of its workers — at the main checkout's shared `.dev.vars`. A worker whose
 * directory *is* the worktree root is already covered by the worktree-root link. No-ops cleanly when the
 * main checkout has no `.dev.vars`.
 *
 * **Nothing that reaches a real file is replaced. One policy, for a link and a file alike.** A regular
 * `.dev.vars` holds the only copy of itself — the file is git-ignored, so what is deleted here is gone
 * from the machine and from history both. A link holds no content, but it decides *which secrets a worker
 * runs with*, and swinging it back to the shared file is the same silent substitution by another route.
 * That matters because every caller wires *every* worker it discovers: one command touching one worker
 * used to rewrite the `.dev.vars` of all of them — `pithy worker add web` took a secret only `apps/board`
 * had, replaced it with the root file's contents, and exited 0 without a word. And {@link ../dev/orchestrator}
 * now runs this on every `pithy dev`, so a link a developer deliberately pointed elsewhere was undone
 * daily. Such a directory is reported in {@link WireDevVarsResult.kept} instead, with which of the two it
 * was, so the adopter is told rather than robbed.
 *
 * **A link is re-pointed when, and only when, it points at nothing.** That is the case with nothing to
 * preserve and the one this exists to repair: an absolute link written before the relative-link fix below
 * dangles the moment the tree moves, and wrangler then reports every secret absent while the file sits
 * right there. A link that already reaches the shared file is left exactly as it is — unlinking and
 * re-creating a correct link only opens a window where the worker has no `.dev.vars` at all.
 *
 * **The link is relative wherever one can reach.** An absolute link into the checkout survives nothing that
 * moves the tree — `mv`, `cp -a`, rsync, a Docker build context — and a dangling `.dev.vars` makes wrangler
 * report every secret absent while the file sits right there, which is the exact misleading failure the
 * wiring exists to end. Relative when the target is inside `mainRoot` (init, and every `.worktrees/<x>/`),
 * absolute only when the target genuinely lives outside the tree, where nothing relative could reach.
 */
export async function wireFeatureDevVars(options: {
  /** The main checkout root — owner of the one shared `.dev.vars`. */
  mainRoot: string;
  /** The worktree root to wire. */
  worktreePath: string;
  /** The workers discovered in the worktree. */
  workers: WorkerTarget[];
}): Promise<WireDevVarsResult> {
  const source = join(options.mainRoot, ".dev.vars");
  if (!(await exists(source))) return { source: null, wired: [], kept: [] };

  const wired: string[] = [];
  const kept: KeptDevVars[] = [];
  const targets = [options.worktreePath, ...options.workers.map((worker) => worker.dir)];
  for (const dir of new Set(targets)) {
    if (dir === options.mainRoot) continue; // never link the shared file to itself.
    // The directory, gated before anything is written into it. `discoverWorkers` builds `apps/<name>`
    // out of a `readdir` that follows whatever `apps` is, so a symlink there or at `apps/<name>` had this
    // planting a `.dev.vars` symlink — pointing at the project's shared credential file — inside a
    // directory outside the project. Whoever can write that directory then reads the team's secrets
    // through it. And the wiring runs over *every* discovered worker, not just the one a command names,
    // so `pithy worker add web` was enough, and `pithy dev` repeats it on every run.
    //
    // The check stops at the directory, never at `.dev.vars` itself: a symlink there is what this
    // function is for, and the policy for that one is below — a real file and a live link are kept.
    await ensureScaffoldPath(options.worktreePath, dir);
    const target = join(dir, ".dev.vars");
    const outcome = await link({ source, target, mainRoot: options.mainRoot });
    if (outcome === null) wired.push(dir);
    else kept.push({ dir, ...outcome });
  }
  return { source, wired, kept };
}

/**
 * Point `target` at `source`. Answers `null` when the target now reaches the shared file — freshly linked,
 * or already pointing at it — and why it was left alone otherwise.
 */
async function link(options: {
  source: string;
  target: string;
  mainRoot: string;
}): Promise<Omit<KeptDevVars, "dir"> | null> {
  if (options.target === options.source) return null;
  const present = await lstatOrNull(options.target);
  if (present && !present.isSymbolicLink()) return { reason: "file" };
  if (present) {
    const points = await resolveLink(options.target);
    // Compared by identity, not by spelling: the link is relative (`../../.dev.vars`), and either path
    // may reach the file through a symlinked ancestor — `/tmp`, a home directory on another volume.
    const reached = await statOrNull(points);
    const shared = await statOrNull(options.source);
    if (reached && shared && reached.dev === shared.dev && reached.ino === shared.ino) return null;
    if (reached) return { reason: "link", points };
    // Reaches nothing — dangling, or a chain that loops. There is no content to preserve in a link, and
    // repairing exactly this is the point: wrangler reports every secret absent while the file sits there.
    await unlink(options.target);
  }
  await symlink(linkPath(options.source, options.target, options.mainRoot), options.target);
  return null;
}

/** How many links deep the chain from a target may go before it is called a loop rather than followed. */
const MAX_LINK_DEPTH = 16;

/** Where a chain of symlinks ends. A dangling link resolves to the path it names — nothing is there. */
async function resolveLink(path: string): Promise<string> {
  let current = path;
  for (let depth = 0; depth <= MAX_LINK_DEPTH; depth += 1) {
    const present = await lstatOrNull(current);
    if (!present?.isSymbolicLink()) return current;
    let link: string;
    try {
      link = await readlink(current);
    } catch {
      return current;
    }
    current = isAbsolute(link) ? link : resolve(dirname(current), link);
  }
  return current; // A chain this deep loops; `statOrNull` then reaches nothing and the link is re-pointed.
}

/** The `stat` of a path, following links, or null when nothing is reachable there (absent, or a loop). */
async function statOrNull(path: string): Promise<Awaited<ReturnType<typeof stat>> | null> {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

/**
 * How the link should spell its source: relative from the target's directory when the target lives inside
 * `mainRoot`, absolute otherwise. `relative` alone cannot answer it — it happily walks up out of the tree
 * with `../..`, which is exactly the link that breaks the moment either end moves independently.
 */
function linkPath(source: string, target: string, mainRoot: string): string {
  const inside = relative(mainRoot, target);
  if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) return source;
  return relative(dirname(target), source);
}

/** The `lstat` of a path, or null when nothing is there. Follows no links — the link itself is the answer. */
async function lstatOrNull(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(path);
  } catch {
    return null;
  }
}

/** Whether a path exists, following no links (a dangling symlink still counts as present). */
async function exists(path: string): Promise<boolean> {
  return (await lstatOrNull(path)) !== null;
}
