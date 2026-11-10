// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { dirname, join, relative, sep } from "node:path";
import { readFileOutcome } from "./readOptionalFile";
import { workspaceMembers } from "./workspaceMembers";

/** Whether `target` is `root` or a directory inside it. */
function within(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep) && !/^[A-Za-z]:/.test(rel));
}

/**
 * The directories whose `node_modules` code in `fromDir` resolves through, nearest first, ending at `projectDir`.
 * A `fromDir` outside the project is the root alone.
 */
export function resolutionChain(projectDir: string, fromDir: string): string[] {
  if (!within(projectDir, fromDir)) return [projectDir];
  const dirs: string[] = [];
  let dir = fromDir;
  for (;;) {
    dirs.push(dir);
    if (relative(projectDir, dir) === "") return dirs;
    dir = dirname(dir);
  }
}

/**
 * The directory whose `node_modules` holds `pkg` for code in `fromDir`, or `null`.
 *
 * Node's lookup from `fromDir`: its own `node_modules`, then each parent's, so a Worker's own install wins over
 * the root's. Bounded at `projectDir`: an ancestor outside the project is a place anyone can leave a
 * `node_modules`, and what this answers is wired into a config that `pithy migrate` imports. A `fromDir` outside
 * the project asks the root alone. An install is a `package.json`, not a directory: an empty one is left behind
 * by a half-finished remove.
 */
export async function installedPackageBase(projectDir: string, fromDir: string, pkg: string): Promise<string | null> {
  for (const base of resolutionChain(projectDir, fromDir)) {
    const read = await readFileOutcome(join(base, "node_modules", ...pkg.split("/"), "package.json"));
    if (read.state !== "absent") return base;
  }
  return null;
}

/** The version of `pkg` that code in `fromDir` resolves, or `null` when none is installed or it names none. */
export async function installedVersion(projectDir: string, fromDir: string, pkg: string): Promise<string | null> {
  const base = await installedPackageBase(projectDir, fromDir, pkg);
  if (base === null) return null;
  const read = await readFileOutcome(join(base, "node_modules", ...pkg.split("/"), "package.json"));
  if (read.state !== "read") return null;
  try {
    const version = (JSON.parse(read.text) as { version?: unknown }).version;
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}

/**
 * Where a package manager runs to give `workerDir` a dependency: the Worker's own directory when it is a workspace
 * member with a `package.json`, so the dependency is declared there and nowhere else, and the project root
 * otherwise. Every supported manager run inside a member writes that member's `package.json` and the root's
 * lockfile.
 */
export async function installDirFor(projectDir: string, workerDir: string): Promise<string> {
  const rel = relative(projectDir, workerDir).split(sep).join("/");
  if (rel === "" || !within(projectDir, workerDir)) return projectDir;
  if ((await readFileOutcome(join(workerDir, "package.json"))).state === "absent") return projectDir;
  return (await workspaceMembers(projectDir)).includes(rel) ? workerDir : projectDir;
}

/** Whether the `package.json` in `dir` declares `pkg` in any field a package manager's remove takes it out of. */
async function declares(dir: string, pkg: string): Promise<boolean> {
  const read = await readFileOutcome(join(dir, "package.json"));
  if (read.state !== "read") return false;
  try {
    const doc = JSON.parse(read.text) as Record<string, unknown>;
    return ["dependencies", "devDependencies", "optionalDependencies"].some((field) => {
      const entries = doc[field];
      return typeof entries === "object" && entries !== null && pkg in entries;
    });
  } catch {
    return false;
  }
}

/**
 * Where a package manager runs to take `pkg` away from `workerDir`: the directory whose `package.json` declares it.
 * The Worker's own member first, then the root; a package neither declares goes where {@link installDirFor} would
 * install it. A member Worker whose package only the root declares is uninstalled at the root, where a sibling may
 * resolve the same copy.
 */
export async function uninstallDirFor(projectDir: string, workerDir: string, pkg: string): Promise<string> {
  const install = await installDirFor(projectDir, workerDir);
  if (install === projectDir || (await declares(install, pkg))) return install;
  return (await declares(projectDir, pkg)) ? projectDir : install;
}
