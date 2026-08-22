// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { stat } from "node:fs/promises";
import { join } from "node:path";
import { portsRegistryPath } from "../feature/ports";
import type { StatePathOptions } from "../notifier/state";

/**
 * Where this machine's dev-port registry is, and whether an older CLI left one behind in the checkout.
 *
 * **Why a diagnostic owns this at all.** The registry moved out of the main repo root in #435, and being
 * inside the checkout was the only thing that ever made it findable: it was git-ignored, but it was
 * *there* — in the file tree the developer already had open, in the `ls` they already ran. In the config
 * directory it is a file that decides every port `pithy dev` binds and that nothing in the project
 * mentions. `pithy doctor` already reports `Config dir:` and the dev-secrets file for exactly this
 * reason; this is the third of the same kind.
 *
 * **A location, never a fault.** Nothing here fails the exit code. The absent state is the correct state
 * on a machine that has not run `pithy feature create` yet, and a stray file is untidy rather than
 * broken — nothing reads it any more, which is the whole point of naming it.
 */
export interface PortsRegistryCheck {
  /**
   * The resolved absolute path, whether or not the file exists. Always set: telling a developer where the
   * file *would* go is most of what this check is for. The text renderer abbreviates it against `$HOME`;
   * `--json` carries it whole.
   */
  path: string;
  /** Whether the registry is on disk yet. */
  present: boolean;
  /**
   * A `.dev-ports.json` still sitting at this checkout's root, or `null`.
   *
   * Left by a CLI that predates #435. Nothing reads it, and nothing ever will — so it is neither a fault
   * nor something the CLI should delete on someone's behalf. It is named so that the developer wondering
   * why editing it changes no ports gets an answer, and so it gets deleted by the person who owns it.
   *
   * **Checked at `projectDir`, not at the main checkout root.** From a worktree those differ, and closing
   * the gap costs a `git` spawn inside a check whose contract is that it never throws. The file is at the
   * main root, which is where doctor is usually run — a worktree run saying nothing is a smaller failure
   * than a diagnostic that can raise.
   */
  stray: string | null;
}

/** Whether a path is a readable file. Never throws: an unreachable path is simply not a file we found. */
async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** The legacy location — the one every project carried before #435. */
const LEGACY_REGISTRY_FILE_NAME = ".dev-ports.json";

/**
 * Resolve the registry path and look for both the real file and a stray legacy one.
 *
 * Never throws, on the rule every probe in this report follows: a diagnostic that can fail the command it
 * is diagnosing is worse than one that says less.
 */
export async function checkPortsRegistry(
  projectDir: string,
  options: StatePathOptions = {},
): Promise<PortsRegistryCheck> {
  const path = portsRegistryPath(options);
  const legacy = join(projectDir, LEGACY_REGISTRY_FILE_NAME);
  return {
    path,
    present: await isFile(path),
    stray: (await isFile(legacy)) ? legacy : null,
  };
}

/**
 * The verdict half of the `Ports:` line, or `null` when the path alone says everything.
 *
 * The stray wins when there is one: "the file you can see is not the file in use" is the sentence that
 * closes the gap, and it is worth more than restating that the real registry is present.
 */
export function describePortsRegistry(check: PortsRegistryCheck): string | null {
  if (check.stray !== null) {
    return `${check.stray} is left over and nothing reads it — delete it`;
  }
  if (!check.present) {
    return "no file yet; the first pithy dev or feature create writes it";
  }
  return null;
}
