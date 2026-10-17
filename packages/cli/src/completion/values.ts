// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { existsSync } from "node:fs";
import { join } from "node:path";
import { ENVIRONMENTS } from "@pithy-sh/core/src/naming/environment";
import { CATALOG } from "../capabilities/catalog";
import { defaultGit, featureBranches } from "../feature/worktree";
import { workerDirectoryNames } from "../project/workers";

/**
 * **The values a Tab can offer without a network, a credential or a write (#765).**
 *
 * Four sources, each read off the machine: the kit's environments, the capability catalog, the project's
 * `apps/` directory, and the repository's `feature/` branches. Nothing here resolves an account, opens a
 * session or reads a secret, and nothing writes. A Tab that waits on Cloudflare is worse than no Tab, and
 * a Tab that changed something would be a command nobody ran.
 *
 * **Project values need a project.** The Workers and the feature branches are offered only where the
 * working directory holds a root `pithy.config.ts`, the file every command treats as the project root.
 * Anywhere else they are empty, which is the honest answer: there is nothing to name.
 */

/** One answer to a Tab: what is inserted, and what a shell that shows one prints beside it. */
export interface Candidate {
  /** The word the shell inserts. */
  value: string;
  /** One line for the shells that show one (zsh, fish, PowerShell). Empty when there is nothing to say. */
  description: string;
}

/** Where the values come from. Each is a seam, so the walk is tested without a disk or a repository. */
export interface ValueSources {
  /** The environments `--env` takes. */
  environments(): readonly string[];
  /** The capabilities `pithy add` and `pithy remove` take, each with why a project would enable it. */
  capabilities(): readonly Candidate[];
  /** The project's Workers, by the directory name `--worker` and `--app` take. */
  workers(cwd: string): Promise<readonly string[]>;
  /** The project's feature branches, the names `pithy feature destroy --branch` takes. */
  featureBranches(cwd: string): Promise<readonly string[]>;
}

/** Whether `cwd` is a Pithy project root. */
function isProject(cwd: string): boolean {
  return existsSync(join(cwd, "pithy.config.ts"));
}

/** The sources the binary reads. */
export const defaultSources: ValueSources = {
  environments: () => [...ENVIRONMENTS],
  capabilities: () => CATALOG.map((entry) => ({ value: entry.name, description: entry.whenToEnable })),
  workers: async (cwd) => (isProject(cwd) ? workerDirectoryNames(cwd) : []),
  featureBranches: async (cwd) => (isProject(cwd) ? featureBranches(defaultGit, cwd) : []),
};

/** What a value is being asked for: the command's path, and the flag or the positional it fills. */
export interface ValueQuery {
  /** The command, from the root down: `["feature", "destroy"]`. */
  path: readonly string[];
  /** The flag's declared name, without dashes. */
  flag?: string;
  /** The positional's declared name. */
  positional?: string;
  /** The flag's or positional's fixed set, when its contract declares one. */
  enum?: readonly string[];
}

/** Plain values, as candidates with nothing to say beside them. */
function plain(values: readonly string[]): Candidate[] {
  return values.map((value) => ({ value, description: "" }));
}

/**
 * **The characters a value may hold to be offered at all.** A shell inserts a candidate as typed text, and
 * neither the bash shim nor the PowerShell one quotes it, so a value is live syntax on the line. A Worker is
 * named by a directory in `apps/` and a branch by whoever pushed it: a cloned repository holding
 * `apps/$(cmd)/` would otherwise put `$(cmd)` on the line after `--app <Tab>`, and Enter would run it. So a
 * value is offered only when every character is one no shell reads as syntax — letters, digits, and
 * `_ . + / : = -`. A name outside that set is not offered, and is still typed by hand.
 */
const SAFE_VALUE = /^[A-Za-z0-9_.+/:=-]+$/;

/**
 * The values one flag or positional takes, less any {@link SAFE_VALUE} refuses. A fixed set the command
 * declares comes first; then the four sources, each attached to the names that take it. Anything else takes
 * a value only its caller knows, so it completes nothing — never a file name it did not ask for.
 */
export async function valuesFor(query: ValueQuery, cwd: string, sources: ValueSources): Promise<Candidate[]> {
  const values = await unfilteredValuesFor(query, cwd, sources);
  return values.filter((candidate) => SAFE_VALUE.test(candidate.value));
}

/** The values one flag or positional takes, before {@link SAFE_VALUE} is applied. */
async function unfilteredValuesFor(query: ValueQuery, cwd: string, sources: ValueSources): Promise<Candidate[]> {
  if (query.enum !== undefined) return plain(query.enum);
  const command = query.path.join(" ");
  if (query.flag !== undefined) {
    if (query.flag === "env") return plain(sources.environments());
    if (query.flag === "worker" || query.flag === "app") return plain(await sources.workers(cwd));
    if (query.flag === "branch" && command === "feature destroy") return plain(await sources.featureBranches(cwd));
    return [];
  }
  if (query.positional === "capability" && (command === "add" || command === "remove")) {
    return [...sources.capabilities()];
  }
  if (query.positional === "name" && command === "env") return plain(sources.environments());
  return [];
}
