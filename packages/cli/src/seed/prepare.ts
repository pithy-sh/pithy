// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseDevVars } from "@pithy-sh/cloudflare/src/env/devVars";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { SEED_ARTIFACT_DIR } from "@pithy-sh/core/src/seed/devLogin";
import type { SeedArtifact } from "@pithy-sh/core/src/seed/seed";
import { type StatePathOptions, stateDir } from "../notifier/state";
import { writeFileAtomic } from "../project/atomic";

/**
 * The CLI half of the prepared-set seam: everything a `SeedSet.prepare` hook needs from the machine, kept
 * here because a capability module is bundled into the Worker and cannot reach the filesystem at all.
 * The hook gets values and callbacks; the disk stays on this side.
 */

/**
 * Where a developer states their machine-local preferences for one project: `<stateDir()>/<project>/dev.json`
 * — `%APPDATA%\pithy\<project>\dev.json` on Windows, `$XDG_CONFIG_HOME/pithy/<project>/dev.json` when that
 * is set, else `~/.config/pithy/<project>/dev.json`.
 *
 * Outside the repo on purpose. A machine opts itself in with no commit and no per-run flag, and two
 * developers sharing one checkout can be different people. The project segment stays for the same reason
 * one level down: a developer with two Pithy projects checked out wants to be a different user in each.
 *
 * **Under Pithy's own config directory, not straight under the config root.** This used to resolve
 * `$XDG_CONFIG_HOME/<project>/dev.json`, which squatted on a namespace the CLI does not own: a Pithy project
 * name is short and generic by design — `dash`, `api`, `web` — so `~/.config/dash/` is a plausible collision
 * with an unrelated program, and the loser is whichever wrote second.
 *
 * **Resolved through {@link stateDir} rather than by hand.** The hand-rolled version had no `win32` branch
 * at all, so a Windows developer's file landed where nothing reads it while the resolver three files away
 * got it right. Delegating deletes that logic instead of adding a third copy of it, and it makes this the
 * directory `pithy doctor` already reports — which is what lets doctor name this file at all.
 *
 * One behavioural consequence, taken deliberately: `stateDir` reads the home directory from `os.homedir()`,
 * not from `$HOME`, so exporting `HOME` no longer relocates the preference file. That is the same rule the
 * state file has always followed, and one rule is the point.
 */
export function devPreferencesPath(project: string, options: StatePathOptions = {}): string {
  return join(stateDir(options), project, "dev.json");
}

/**
 * Read {@link devPreferencesPath}, parsed but unvalidated — the set that consumes it owns its shape.
 *
 * An absent file is the default (and means "seed nothing extra"), so it is `undefined`, not an error. So is
 * an unparseable one: this file is hand-edited, and a half-typed preference should not fail a whole seed
 * run. A file that parses but says the wrong thing is a different matter, and the set rejects it loudly.
 */
export async function readDevPreferences(project: string, options: StatePathOptions = {}): Promise<unknown> {
  try {
    return JSON.parse(await readFile(devPreferencesPath(project, options), "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Read a named secret out of the project's `.dev.vars`.
 *
 * That is where local dev's secrets genuinely live: `secretsStore` resolves every secret from an injected
 * `.dev.vars` string when `ENVIRONMENT` is not a managed environment, whatever the registry backend says.
 * So this reads the same value the running Worker will, from the same place — no store, no master key.
 *
 * A deployed environment's secrets are not on the operator's disk, so this answers `undefined` there. A set
 * that needs a secret is therefore a `dev`-only set, which is exactly the guard rail the one caller wants.
 */
export function devSecretReader(projectDir: string): (name: string) => Promise<string | undefined> {
  return async (name: string) => {
    try {
      return parseDevVars(await readFile(join(projectDir, ".dev.vars"), "utf8"))[name];
    } catch {
      return undefined;
    }
  };
}

/**
 * The mode a freshly written artifact lands with. `logs/dev-login.json` holds a **live session cookie** —
 * one `cat` from being anybody's login — and the umask is not a permission policy.
 */
const ARTIFACT_MODE = 0o600;

/**
 * Write one prepared artifact under the project's `logs/`, returning the path written.
 *
 * The directory is not the fixture's to choose: `logs/` is gitignored by the starter template, and the one
 * artifact that exists holds a live session cookie. A `file` carrying any directory part is refused rather
 * than normalized — a fixture that tried it is a bug, and silently relocating it would hide the bug.
 *
 * **Through {@link writeFileAtomic}, for the same two reasons `.dev.vars` is.** A plain `writeFile` follows
 * a symlink at the target wherever it points, so a foreign-owned link left at `logs/dev-login.json` carried
 * a live session cookie out of the project; and it lands the file at whatever the umask allows, which for
 * a credential is a decision nobody made. The primitive owns both rules — an ownership check on every link
 * it follows, and a mode the file is *born* with rather than widened from. A file already there keeps its
 * own mode: those permissions are the adopter's.
 */
export async function writeSeedArtifact(projectDir: string, artifact: SeedArtifact): Promise<string> {
  if (artifact.file !== basename(artifact.file) || artifact.file.startsWith(".")) {
    throw new ValidationError({
      message: "A seed artifact must be a plain file name.",
      action: `Name the file itself; it is always written into ${SEED_ARTIFACT_DIR}/.`,
      detail: `artifact file "${artifact.file}" is not a plain basename`,
    });
  }
  const dir = join(projectDir, SEED_ARTIFACT_DIR);
  await mkdir(dir, { recursive: true });
  const path = join(dir, artifact.file);
  await writeFileAtomic(path, artifact.contents, { mode: ARTIFACT_MODE });
  return path;
}
