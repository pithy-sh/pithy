// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { basename, join } from "node:path";
import type { PackageManager } from "../project/packageManager";
import { frozenInstallArgs } from "../setup/install";

/** What {@link isolatedCheckNotice} needs to name. */
export interface IsolatedCheckNoticeOptions {
  /** The absolute worktree path. */
  worktree: string;
  /** The main checkout the worktree sits under. */
  root: string;
  /** The project's package manager, which spells the frozen install. */
  packageManager: PackageManager;
}

/** A path as one POSIX shell word: bare when it holds nothing the shell reads, single-quoted otherwise. */
function shellWord(path: string): string {
  return /^[\w@%+=:,./-]+$/.test(path) ? path : `'${path.replaceAll("'", `'\\''`)}'`;
}

/**
 * The lines `pithy feature create` (and the kit's own `scripts/worktree.ts setup`) prints after it stands a worktree up. Node walks up from the worktree to
 * the main checkout's `node_modules` for any package the worktree's own lacks, so a dependency change can pass
 * in the worktree and fail on a clean install. The check copies the worktree to a temporary directory, which
 * has no checkout above it, and runs a frozen install there.
 */
export function isolatedCheckNotice(options: IsolatedCheckNoticeOptions): string[] {
  const { worktree, root, packageManager } = options;
  return [
    `A package this worktree's node_modules lacks resolves from ${join(root, "node_modules")}, so a dependency change can pass here and fail on a clean install. Verify one outside the checkout:`,
    `  dir="$(mktemp -d)" && cp -R ${shellWord(worktree)} "$dir" && cd "$dir/${basename(worktree)}"`,
    `  ${[packageManager, ...frozenInstallArgs(packageManager)].join(" ")}`,
    "  Then run your typecheck, lint and tests there.",
  ];
}
