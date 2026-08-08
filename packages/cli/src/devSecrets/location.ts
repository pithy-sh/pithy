// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { join } from "node:path";
import { type StatePathOptions, stateDir } from "../notifier/state";
import { loadProject, requireProjectName } from "../project/config";
import { ensureOwnerOnlyDirFor } from "./mode";

/**
 * Where a project's dev secrets live: `<config>/<project>/secrets.jsonc` — **outside the checkout, and
 * with nothing inside it pointing at them** (#156).
 *
 * **Why not in the repo.** `.dev.vars` sits in a worker's directory because *wrangler* reads it there;
 * the location is not ours to choose. Nothing but our own CLI reads the secrets file, and the CLI
 * resolves its own paths — so the file does not need to appear in the project, it needs to be *found*.
 * Everything that followed from having it in the project followed from that one unexamined assumption:
 * a mint into a file the project did not ignore, a `.tmp` sibling one SIGINT away from a published
 * tarball (#145), a worktree with no secrets at all (#155), and an `rm -rf` on a checkout taking every
 * dev credential with it. Not a symlink either: a link puts the file back in the field of view of
 * every tool that follows one.
 *
 * **This is #131's directory, not a second convention.** `<config>/<project>/dev.json` was already
 * there; this is its neighbour, resolved through the same {@link stateDir} — `$PITHY_CONFIG_DIR`, then
 * `%APPDATA%\pithy`, then `$XDG_CONFIG_HOME/pithy`, then `~/.config/pithy`. Two implementations of
 * "where does config live" is the defect shape, and the Windows branch is the half a second one forgets.
 *
 * **Keyed on the project name, which is a collision an adopter can hit.** Two unrelated projects both
 * called `app` share one file, and renaming a project orphans the old directory. Dev-only values, so
 * this is friction rather than danger — but it is invisible friction, so `pithy doctor` prints the
 * resolved path on every run and names an orphaned directory when it finds one.
 */

/** The file's name inside the project's config directory. Undotted: nothing here is hidden from anything. */
export const DEV_SECRETS_FILE_NAME = "secrets.jsonc";

/** The project's own directory under the Pithy config directory — the same one `dev.json` sits in. */
export function devSecretsDir(project: string, options: StatePathOptions = {}): string {
  return join(stateDir(options), project);
}

/** `<config>/<project>/secrets.jsonc`, from a project name that has already been resolved. */
export function devSecretsFile(project: string, options: StatePathOptions = {}): string {
  return join(devSecretsDir(project, options), DEV_SECRETS_FILE_NAME);
}

/**
 * The secrets file for a project root: load its `pithy.config.ts`, require a `name`, resolve the path.
 *
 * **`requireProjectName`, never a guess.** It is the same gate every provisioned resource name goes
 * through, and the reason is the same one: a fallback that can differ between checkouts — an
 * alphabetically-first worker, a directory basename — would give a worktree a different set of secrets
 * from the checkout it was cut from, silently, which is the failure #155 reported. A nameless project
 * gets that command's actionable error rather than a file somewhere nobody can predict.
 *
 * Throws. A caller that must not — `pithy doctor` — catches, and every one that must not proceed
 * without a place to put a credential should not proceed.
 */
export async function resolveDevSecretsFile(projectDir: string, options: StatePathOptions = {}): Promise<string> {
  return devSecretsFile(requireProjectName(await loadProject(projectDir)), options);
}

/**
 * Make sure the directory holding `file` exists and is `0700`, on this call and on every later one.
 *
 * `mkdir`'s `mode` only applies to a directory it creates, and it is masked by the umask besides — so a
 * directory already there keeps whatever mode it was made with. The narrowing runs unconditionally for
 * the same reason the file's does: the case it exists for is the directory somebody else created.
 *
 * The listing is the finding, not just the bytes. `ls <config>/<project>/` names every secret this
 * project has — which provider, which vendor, which capability — and that is worth 0700 on its own.
 */
export function ensureDevSecretsDir(file: string): Promise<void> {
  return ensureOwnerOnlyDirFor(file);
}
