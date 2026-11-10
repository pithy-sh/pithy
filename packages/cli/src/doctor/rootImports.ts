// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { join } from "node:path";
import { installedPackageBase } from "../project/installedPackage";
import { readOptionalFile } from "../project/readOptionalFile";
import { importedPackages, memberRange } from "../project/rootConfigImports";
import { WORKERS_TEST_CONFIG } from "../project/workersTestConfig";

/**
 * **Does the project root resolve every package its Workers test config imports?**
 *
 * `vitest.workers.config.ts` loads from the root, and under a package manager that does not hoist the root resolves
 * only what the root's own `package.json` declares and the install linked there. A package only a Worker declares is
 * linked beside that Worker, so the Workers tests fail with `ERR_MODULE_NOT_FOUND` after a clean install, and a
 * feature worktree can hide it by resolving the main checkout's `node_modules` one level up. Resolution here stops
 * at the project root, the way {@link installedPackageBase} reads it. Report only: it prints, never fails the exit.
 */

/** One package the config imports that the root does not resolve. */
export interface UnresolvedRootImport {
  /** The config, from the project root. */
  file: string;
  /** The package the import resolves through. */
  package: string;
  /** Whether the root `package.json` declares it already, so only the install is missing. */
  declared: boolean;
  /** The `devDependencies` line to add, at the range a workspace member declares, or `null` when there is none. */
  line: string | null;
}

/** What the check established. */
export interface RootImportsCheck {
  /** `unresolved` when an import does not resolve from the root; `ok` otherwise; `could-not-check` when it threw. */
  state: "ok" | "unresolved" | "could-not-check";
  /** One entry per package, in import order. */
  unresolved: UnresolvedRootImport[];
}

/** A `package.json` as this check reads one. */
interface Manifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

/** Read the project's Workers test config against what the project root resolves. Files only. */
export async function checkRootImports(projectDir: string): Promise<RootImportsCheck> {
  const source = await readOptionalFile(join(projectDir, WORKERS_TEST_CONFIG));
  if (source === null) return { state: "ok", unresolved: [] };
  const raw = await readOptionalFile(join(projectDir, "package.json"));
  const root = raw === null ? {} : (JSON.parse(raw) as Manifest);
  const unresolved: UnresolvedRootImport[] = [];
  for (const pkg of importedPackages(source)) {
    if ((await installedPackageBase(projectDir, projectDir, pkg)) !== null) continue;
    const declared = [root.dependencies, root.devDependencies, root.optionalDependencies, root.peerDependencies].some(
      (field) => field?.[pkg] !== undefined,
    );
    const range = declared ? undefined : await memberRange(projectDir, pkg);
    unresolved.push({
      file: WORKERS_TEST_CONFIG,
      package: pkg,
      declared,
      line: range === undefined ? null : `${JSON.stringify(pkg)}: ${JSON.stringify(range)}`,
    });
  }
  return { state: unresolved.length > 0 ? "unresolved" : "ok", unresolved };
}

/** One sentence for one unresolved import. */
function describeOne({ file, package: pkg, declared, line }: UnresolvedRootImport): string {
  if (declared) return `${file} imports ${pkg}, which the project root declares and has not installed.`;
  return `${file} imports ${pkg}, which the project root does not resolve. Add ${line ?? pkg} to devDependencies in the root package.json.`;
}

/** One line per unresolved import, none when every one resolves, and one saying so when the check could not run. */
export function describeRootImports(check: RootImportsCheck): string[] {
  if (check.state === "could-not-check") {
    return [`Could not check what ${WORKERS_TEST_CONFIG} imports against the project root.`];
  }
  return check.unresolved.map(describeOne);
}

/** The remedy line under the findings. */
export const ROOT_IMPORTS_ACTION = "Then run your package manager's install at the project root.";
