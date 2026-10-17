// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { stripVTControlCharacters } from "node:util";
import { commandName } from "@pithy-sh/core/src/cli/command";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import {
  detectLockfile,
  type InstallRunner,
  type PackageManager,
  packageManagerFromUserAgent,
  runPackageManager,
} from "../project/packageManager";

/**
 * **`pithy setup`'s first step: the project's dependencies, installed against the lockfile it has (#764).**
 *
 * The manager is the lockfile's — the same resolution `pithy add` installs through — so a clone is never
 * installed by a manager its maintainers do not use. And the install is the one each manager offers that
 * refuses to move the lockfile: a clone that installs something its lockfile does not name is a clone whose
 * `git status` is dirty before anyone has written a line, and whose dependencies differ from the ones the
 * project was tested on.
 *
 * **A project with no lockfile yet gets the one install that writes its first.** That is the project
 * `pithy init` just made: nothing is installed and nothing is locked, so there is nothing to rewrite. The
 * manager is the one that launched `pithy`, which is the best evidence there is before a lockfile exists —
 * the rule `pithy init` follows for the same moment.
 */

/** The install `pithy setup` would run: which manager, against which lockfile, as which command line. */
export interface InstallPlan {
  /** The project's package manager. */
  packageManager: PackageManager;
  /** The lockfile it installs against, by name, or `null` when the project has none yet. */
  lockfile: string | null;
  /** The executable. */
  command: string;
  /** Its arguments. */
  args: string[];
}

/** Each manager's install that refuses to change its lockfile. */
export function frozenInstallArgs(pm: PackageManager): string[] {
  // `npm ci` is npm's spelling of it; the other three take one flag on `install`. Yarn 2 and later read
  // `--frozen-lockfile` as `--immutable`, so one spelling covers Yarn 1 and Yarn 4 alike.
  return pm === "npm" ? ["ci"] : ["install", "--frozen-lockfile"];
}

/**
 * Decide the install from what is on disk. Reads; runs nothing.
 *
 * With no lockfile, the manager that launched `pithy`, then Bun when `pithy` itself runs under Bun — a CLI
 * installed with `bun add --global` and started bare has no user agent to read, and is no evidence for npm —
 * and npm only after both.
 */
export async function planInstall(
  projectDir: string,
  env: NodeJS.ProcessEnv = process.env,
  versions: Partial<NodeJS.ProcessVersions> = process.versions,
): Promise<InstallPlan> {
  const found = await detectLockfile(projectDir);
  if (found !== null) {
    return {
      packageManager: found.pm,
      lockfile: found.lockfile,
      command: found.pm,
      args: frozenInstallArgs(found.pm),
    };
  }
  const pm = packageManagerFromUserAgent(env) ?? (versions.bun !== undefined ? "bun" : "npm");
  return { packageManager: pm, lockfile: null, command: pm, args: ["install"] };
}

/** What {@link installDependencies} needs. */
export interface InstallDependenciesOptions {
  /** The project root — where the lockfile lives and the install runs. */
  projectDir: string;
  /** Read for the manager that launched `pithy`, when there is no lockfile. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Spawn seam. Defaults to the real, narrated package-manager spawn. */
  run?: InstallRunner;
}

/** Run the planned install. Throws a sentence naming the command line when it fails. */
export async function installDependencies(options: InstallDependenciesOptions): Promise<InstallPlan> {
  const plan = await planInstall(options.projectDir, options.env);
  try {
    await (options.run ?? runPackageManager)(plan.command, plan.args, options.projectDir);
  } catch (cause) {
    const line = [plan.command, ...plan.args].join(" ");
    throw new InternalError({
      message: `${line} failed.`,
      // The one failure a frozen install has that a plain one does not: the lockfile is behind
      // `package.json`. Updating it is a change somebody commits, so it is named and never done here.
      action:
        plan.lockfile === null
          ? `Run ${line} by hand to see why, then run ${commandName("setup")} again.`
          : `Setup never rewrites ${plan.lockfile}. If package.json changed, run ${plan.command} install, commit the lockfile, and run ${commandName("setup")} again.`,
      detail: stripVTControlCharacters(cause instanceof Error ? cause.message : String(cause)),
    });
  }
  return plan;
}
