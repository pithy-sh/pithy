// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { existsSync, readdirSync, readFileSync } from "node:fs";
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

/** A workspace package, as the gate sees it: where it lives and what licence it claims. */
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
 * is not a package and must not be reported as one missing a licence.
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
 * It stays because `tooling/*` cannot reach the primitive: the workspace is installed isolated and this
 * package declares no dependency on `@pithy-sh/cli`, so the import resolves in neither `tsc` nor the runtime
 * — and a relative import out of `src` is refused by this package's `rootDir`. Routing it means adding that
 * edge to `package.json`, or moving the walk somewhere both trees reach. Neither was chosen silently: the
 * gate in `ci/sourceFiles.test.ts` carries this module by name with the reason attached, and will fail if
 * the walk is removed without the entry going with it.
 *
 * What that costs, honestly: the ENOENT tolerance and the vendored-`packages/cli/templates` exclusion the
 * primitive has accumulated (#185, #192) are not here. Neither has bitten — this reads `<pkg>/src`, which no
 * suite scaffolds into and which holds no vendored copy — and that is an argument about today's tree, not a
 * property of the code.
 */
export function sourceFiles(packageDir: string): string[] {
  const src = join(packageDir, "src");
  if (!existsSync(src)) return [];

  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
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
