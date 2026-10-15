// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

/**
 * **Which checkout a directory belongs to, synchronously and without git (#759).**
 *
 * Read-only on purpose. These probes follow links — a `.git` reached through a linked checkout is still
 * that checkout's — and the module that writes the bindings must not be the one that probes, so they live
 * here, where nothing is written.
 */

/** `path`'s real path, or `path` when it cannot be resolved — the {@link canonicalRepoPath} rule, synchronously. */
function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * The main checkout a directory belongs to *as a checkout root*, or `null` when it holds no `.git`.
 *
 * **No git call, because the credential seam is synchronous.** A `.git` directory makes `dir` its own
 * root. A `.git` *file* is a linked worktree: `gitdir: <main>/.git/worktrees/<name>`, and that directory's
 * `commondir` names the main `.git` relative to it. Its parent, canonicalised, is the same string
 * `resolveMainRepoRoot` derives from `git rev-parse --git-common-dir` — which is what makes a binding
 * written through the async path findable through this one.
 */
export function checkoutRootSync(dir: string): string | null {
  const dotGit = join(dir, ".git");
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(dotGit);
  } catch {
    return null;
  }
  if (stats.isDirectory()) return canonical(dir);
  try {
    const pointer = /^gitdir:\s*(.+)\s*$/m.exec(readFileSync(dotGit, "utf8"))?.[1]?.trim();
    if (!pointer) return null;
    const gitDir = isAbsolute(pointer) ? pointer : resolve(dir, pointer);
    let commonDir = gitDir;
    try {
      const relative = readFileSync(join(gitDir, "commondir"), "utf8").trim();
      if (relative) commonDir = isAbsolute(relative) ? relative : resolve(gitDir, relative);
    } catch {
      // No `commondir`: a submodule's gitdir, which is its own common directory.
    }
    return canonical(dirname(commonDir));
  } catch {
    return null;
  }
}

/** Every directory from `start` up to the filesystem root, nearest first. */
export function ancestors(start: string): string[] {
  const out: string[] = [];
  let dir = canonical(resolve(start));
  for (;;) {
    out.push(dir);
    const parent = dirname(dir);
    if (parent === dir) return out;
    dir = parent;
  }
}

/**
 * The key a binding for `dir` is filed under: its repository's main checkout when it is inside one, and
 * its own canonical path otherwise. The nearest `.git` decides, so binding `apps/api` binds the project.
 */
export function bindingKeySync(dir: string): string {
  for (const candidate of ancestors(dir)) {
    const root = checkoutRootSync(candidate);
    if (root !== null) return root;
  }
  return canonical(resolve(dir));
}
