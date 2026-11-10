// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { join } from "node:path";
import { CATALOG } from "../capabilities/catalog";
import { readOptionalFile } from "../project/readOptionalFile";
import { memberName, workspaceMembers } from "../project/workspaceMembers";

/**
 * **Does the project root declare a capability a Worker already declares, as a runtime dependency?**
 *
 * A Worker declares the capabilities it composes in its own `package.json`, which is where `pithy add` installs
 * them, and two Workers composing one capability each declare it. The root has no Worker, so a capability in its
 * `dependencies` beside a Worker's is a second declaration that drifts from the first. A root `devDependency` is
 * how the root resolves what its Workers test config imports, and is never one. Report only: it prints, never fails
 * the exit.
 */

/** One capability the root declares beside a Worker. */
export interface DuplicateCapability {
  /** The capability's npm package. */
  package: string;
  /** The members declaring it as a runtime dependency, from the project root: `.` first, then each Worker. */
  members: string[];
}

/** What the check established. */
export interface DuplicateCapabilitiesCheck {
  /** `duplicated` when the root declares one a Worker does; `ok` otherwise; `could-not-check` when it threw. */
  state: "ok" | "duplicated" | "could-not-check";
  /** One entry per capability, in the root's declaration order. */
  duplicates: DuplicateCapability[];
}

/** The `package.json` field a package manager installs a runtime dependency from. */
interface Manifest {
  dependencies?: Record<string, string>;
}

const CAPABILITY_PACKAGES: ReadonlySet<string> = new Set(CATALOG.map((entry) => entry.package));

async function runtimeDependencies(projectDir: string, member: string): Promise<string[]> {
  const raw = await readOptionalFile(join(projectDir, member, "package.json"));
  if (raw === null) return [];
  return Object.keys((JSON.parse(raw) as Manifest).dependencies ?? {});
}

/** Read the root's and every Worker's `package.json` for a capability both declare at runtime. Files only. */
export async function checkDuplicateCapabilities(projectDir: string): Promise<DuplicateCapabilitiesCheck> {
  const root = (await runtimeDependencies(projectDir, ".")).filter((pkg) => CAPABILITY_PACKAGES.has(pkg));
  if (root.length === 0) return { state: "ok", duplicates: [] };
  const workers = (await workspaceMembers(projectDir)).filter((member) => /^apps\/[^/]+$/.test(member));
  const declaring = new Map<string, string[]>();
  for (const worker of workers) {
    for (const pkg of await runtimeDependencies(projectDir, worker)) {
      if (root.includes(pkg)) declaring.set(pkg, [...(declaring.get(pkg) ?? []), worker]);
    }
  }
  const duplicates = root.flatMap((pkg) => {
    const members = declaring.get(pkg);
    return members === undefined ? [] : [{ package: pkg, members: [".", ...members] }];
  });
  return { state: duplicates.length > 0 ? "duplicated" : "ok", duplicates };
}

/** One sentence for one capability. */
function describeOne({ package: pkg, members }: DuplicateCapability): string {
  const workers = members.filter((member) => member !== ".").map(memberName);
  return `${pkg} is a runtime dependency of the project root and of ${workers.join(" and ")}.`;
}

/** One line per capability, none when there is none, and one saying so when the check could not run. */
export function describeDuplicateCapabilities(check: DuplicateCapabilitiesCheck): string[] {
  if (check.state === "could-not-check") {
    return ["Could not compare the capabilities the project root and its Workers declare."];
  }
  return check.duplicates.map(describeOne);
}

/** The remedy line under the findings. */
export const DUPLICATE_CAPABILITIES_ACTION =
  "Take each out of the root package.json's dependencies. A Worker declares what it composes.";
