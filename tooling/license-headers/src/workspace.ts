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

/** Every `.ts`/`.tsx` under the package's `src`, sorted, at any depth. Empty when it has no `src`. */
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
