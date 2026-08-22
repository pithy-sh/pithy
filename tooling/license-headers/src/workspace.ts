// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { type Dirent, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The workspace directories that hold packages, in the order they are reported.
 *
 * `packages/*` publishes to npm; `tooling/*` never does. Both are ours and both need headers — the
 * groups differ only in whether a `LICENSE` file has anyone to reach.
 */
export const PACKAGE_GROUPS = ["packages", "tooling"] as const;

/** Which workspace directory a package lives in. */
export type PackageGroup = (typeof PACKAGE_GROUPS)[number];

/** A workspace package, as the gate sees it: where it lives and what license it claims. */
export interface WorkspacePackage {
  /** The `name` from its `package.json`. */
  name: string;
  /** Absolute path to the package directory. */
  dir: string;
  /** The declared SPDX id, or `null` when the manifest omits `license`. */
  license: string | null;
  /** The workspace directory it was found in. */
  group: PackageGroup;
}

/** Directories that never hold first-party source, wherever they turn up. */
const SKIP_DIRS = new Set(["node_modules", "dist", ".turbo"]);

/**
 * Every package across {@link PACKAGE_GROUPS}, sorted by name within each group.
 *
 * Keyed on the presence of `package.json`, not on the directory existing: a stale folder left by a
 * rename (`packages/wallet` still held `dist/` and `node_modules/` long after the `ledger` rename)
 * is not a package and must not be reported as one missing a license.
 */
export function discoverPackages(root: string): WorkspacePackage[] {
  const found: WorkspacePackage[] = [];

  for (const group of PACKAGE_GROUPS) {
    const groupDir = join(root, group);
    if (!existsSync(groupDir)) continue;

    const inGroup: WorkspacePackage[] = [];
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(groupDir, entry.name);
      const manifestPath = join(dir, "package.json");
      if (!existsSync(manifestPath)) continue;

      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { name?: string; license?: string };
      inGroup.push({ name: manifest.name ?? entry.name, dir, license: manifest.license ?? null, group });
    }

    found.push(...inGroup.sort((a, b) => a.name.localeCompare(b.name)));
  }

  return found;
}

/**
 * Every `.ts`/`.tsx` under the package's `src`, sorted, at any depth. Empty when it has no `src`.
 *
 * **This is the one walk in the repository that is not `packages/cli/src/ci/sourceFiles.ts`**, and saying so
 * is the point. #185 consolidated six private traversals and claimed in a changeset that it had got them
 * all; five had not been, and this was one of them, unnoticed for two releases because a release note is not
 * something a build can fail on (#202).
 *
 * It stays **by decision, not by obstacle** (#211). `tooling/*` cannot resolve `@pithy-sh/cli` today — the
 * workspace installs isolated and this package declares no dependency on it — but that is one manifest line
 * away, so "it does not resolve" was never the argument. The argument is direction. This package is the gate
 * that stamps `packages/cli`'s own headers, and it runs in `lint-staged` on every commit; making the linter a
 * dependent of the largest thing it lints points the graph backwards, and drags every CLI change into its
 * `--affected` set. `audit.ts` next door could not be routed even with the edge, so buying it would remove one
 * of this package's two walks and leave the reader to know which of two answers applied where.
 *
 * What that costs, priced rather than waved at. Of the three properties the primitive has accumulated, two are
 * already here: a symlinked directory is not descended, because `withFileTypes` reports a link as a link and
 * `isDirectory()` is false for it; and the vendored `packages/cli/templates` (#192) is out of range, because
 * this reads `<pkg>/src` and that copy is a sibling of `src`. The third was the real gap — #185's unguarded
 * listing — and it needed no dependency to close. It is closed below.
 *
 * None of it is silent: the gate in `ci/sourceFiles.test.ts` carries this module by name with the decision
 * attached, and fails if the walk is removed without the entry going with it.
 */
export function sourceFiles(packageDir: string): string[] {
  const src = join(packageDir, "src");
  if (!existsSync(src)) return [];

  const found: string[] = [];
  const walk = (dir: string): void => {
    // A directory that cannot be listed contributes nothing, rather than throwing out of the walk (#185).
    // `existsSync` above answers for the root only, and answers it one syscall before the listing — the
    // window between the two is the whole defect. This runs on every commit through `lint-staged` and in
    // CI over a tree other suites are scaffolding into; a license gate that dies on somebody else's
    // teardown is a license gate people learn to skip with `--no-verify`.
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(path);
      } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
        found.push(path);
      }
    }
  };
  walk(src);

  return found.sort();
}
