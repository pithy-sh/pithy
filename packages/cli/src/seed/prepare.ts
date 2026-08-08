// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { ConflictError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { SEED_ARTIFACT_DIR } from "@pithy-sh/core/src/seed/devLogin";
import type { SeedArtifact } from "@pithy-sh/core/src/seed/seed";
import { currentValue } from "@pithy-sh/secrets/src/crypto/versionedValue";
import type { DevSecretsFile } from "@pithy-sh/secrets/src/dev/devSecretsFile";
import { storedSecretValue } from "@pithy-sh/secrets/src/dev/seedDevSecrets";
import type { SecretRegistry } from "@pithy-sh/secrets/src/registry";
import { readDevSecrets } from "../devSecrets/file";
import { devSecretsFile } from "../devSecrets/location";
import { projectConfigDir, type StatePathOptions, stateDir } from "../notifier/state";
import { writeFileAtomic } from "../project/atomic";

/**
 * The CLI half of the prepared-set seam: everything a `SeedSet.prepare` hook needs from the machine, kept
 * here because a capability module is bundled into the Worker and cannot reach the filesystem at all.
 * The hook gets values and callbacks; the disk stays on this side.
 */

/** The file's name inside the project's config directory. Undotted: nothing here is hidden from anything. */
export const DEV_PREFERENCES_FILE_NAME = "dev.json";

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
 *
 * **The project segment is {@link projectConfigDir}'s to join, and its rule to state (#212).** This
 * function used to join the name itself, with the rule that it was safe to put in a path living at every
 * call site — safe every time, because each caller had been through `requireProjectName`, and safe by a
 * property of the call graph rather than of the value.
 */
export function devPreferencesPath(project: string, options: StatePathOptions = {}): string {
  return join(projectConfigDir(project, options), DEV_PREFERENCES_FILE_NAME);
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
 * The one environment whose secrets are on the operator's disk. Everything else is a managed environment
 * and gets its secrets from its own store — see {@link devSecretReader}.
 */
const LOCAL_ENVIRONMENT = "dev";

/** What a prepared set needs to build a dev-only reader: the project, its registry, and the environment. */
export interface DevSecretReaderOptions {
  /**
   * The project's **name** — what resolves the dev secrets file, exactly as it resolves `dev.json`
   * one directory over. Not the project root: since #156 the file is at `<config>/<project>/`, so a
   * directory is no longer an answer to where a secret is.
   */
  project: string;
  /**
   * The environment this seed run is writing to. **Required, and that is the structural half of the rule
   * (#159).** A caller cannot build a dev-secrets reader without stating where the rows are going, so
   * there is no signature left that reads dev secrets for an environment nobody named.
   */
  env: string;
  /**
   * The project's aggregate secret registry — the authority on whether a name is a secret at all, and
   * on the shape its value must have. Required for the same reason `env` is: a reader that guesses
   * either one is a reader nobody can audit.
   */
  registry: SecretRegistry;
  /** Where the Pithy config directory is. Defaults to the real one — a seam, so a test reads its own. */
  paths?: StatePathOptions;
}

/**
 * Read a named secret out of the project's **dev secrets file** — **in `dev`, and in no other environment.**
 *
 * That is where local dev's secrets live: `<config>/<project>/secrets.jsonc`, the same file `pithy seed`
 * has just minted into and seeded from, two steps before a prepared set runs. It needs no D1 and no
 * master key, so it answers at the point in the pipeline where seeds happen.
 *
 * **This read `.dev.vars` until #176, and that was the whole defect.** #153 moved every `d1` secret out
 * of that file and #154 made each Worker's copy a generated artifact; the reader was not moved with
 * them. So `pithy seed` on a project composing auth's dev-session seed printed two lines that
 * contradicted each other — the secret was seeded, and the seed that needs it could not see it — and
 * the fix it suggested was to undo #153.
 *
 * **One source, whatever the backend, and so no branch.** `.dev.vars` is not the other half of this
 * question any more: it is a *destination* now, generated per Worker from this same file, and a
 * `cf-secrets-store` value written there is this file's value encoded for a binding. Reading it back
 * would be reading a copy — and a run-wide reader cannot even say *which* Worker's copy, because since
 * #154 there are as many as there are Workers. A `cf-secrets-store` secret therefore resolves here too,
 * from the one place its dev value is stated. What is given up is narrow and deliberate: a value
 * supplied only through a hand-written `.dev.vars.local` override is not visible to a prepared set. It
 * is an override of what the Worker reads, not a statement of what the secret is.
 *
 * **Through the registry, and through `storedSecretValue`, so this is the value the Worker gets.** The
 * registry says whether a `text` secret's version really is a string and validates a `json` one against
 * its schema; the conversion is the same one the seeder uses to fill the store. So a prepared set is
 * handed exactly the bytes `secretsStore` will resolve at runtime — not a near-miss parsed a second way
 * by a second reader. A name the registry does not declare answers `undefined`: nothing declares it, so
 * the running Worker cannot resolve it either. A keyspace answers `undefined` for the same reason
 * `get(name)` refuses one — it has no single value.
 *
 * **The environment gate is structural, not a caller's courtesy (#159).** An older doc said a deployed
 * environment's secrets are not on the operator's disk, so a read would answer `undefined` there. That
 * was never true of the operator's *own* machine: the dev secrets file sits under `~/.config` whatever
 * `--env` says, so `pithy seed --env prod` handed a prepared set a live local dev secret and wrote it
 * into production rows. #159's rule is absolute and the adopter cannot opt out — dev secrets never reach
 * a managed environment — and a reader that leaks them is the same hole as a writer that plants them. So
 * outside `dev` the reading closure is never built: the caller gets a reader that refuses, and the file
 * is never opened at all.
 *
 * **Provably dev, not merely not-prod.** An unknown, misspelled, or empty environment refuses too. The
 * permissive default is the entire bug.
 *
 * **Read at most once per run.** The file is hand-edited, and two Workers in one fan-out must not observe
 * it in two states — the same rule, for the same reason, that `preparedRun` applies to `dev.json`. A run
 * with no prepared set never opens it at all. And an absent file is `{}` while an unreadable one throws:
 * `readDevSecrets` owns that distinction, because answering "empty" for `EACCES` is how a set writes a
 * row against a secret it never got.
 */
export function devSecretReader(options: DevSecretReaderOptions): (name: string) => Promise<string | undefined> {
  const path = devSecretsFile(options.project, options.paths ?? {});
  if (options.env !== LOCAL_ENVIRONMENT) return refuseOutsideDev(options.env, path);
  let pending: Promise<DevSecretsFile> | undefined;
  return async (name: string) => {
    // `Object.hasOwn`, never a bare index: a prepared set asking for `constructor` or `toString` would
    // otherwise reach an `Object.prototype` member and be handed something that is not a secret at all.
    if (!Object.hasOwn(options.registry, name)) return undefined;
    const entry = options.registry[name];
    if (!entry || entry.keyed) return undefined;
    if (pending === undefined) pending = readDevSecrets(path);
    const file = await pending;
    const envelope = file[name];
    if (!envelope) return undefined;
    return currentValue(storedSecretValue(entry, name, envelope, path));
  };
}

/**
 * The reader a managed environment gets: one that refuses by name and reads nothing.
 *
 * It refuses when a set *asks*, not when the run starts — `pithy seed --env prod` is a legitimate command,
 * and a set that never wants a secret is none of this rule's business. A set that does want one is a
 * `dev`-only set, and this is where it finds that out, loudly, before a row is written.
 *
 * The secret's name is in the message because it is a registry key an adopter wrote; its value never is,
 * in `message` or in `detail`, because this function has not read one and never will.
 */
function refuseOutsideDev(env: string, path: string): (name: string) => Promise<string | undefined> {
  return async (name: string) => {
    throw new ConflictError({
      message: `Refusing to read the dev secret "${name}" while seeding ${env}.`,
      action:
        "Dev secrets are local only. Mark this set dev-only, or set the value for that environment with pithy secrets set.",
      detail: `devSecretReader refused ${path} for env "${env}"; only "${LOCAL_ENVIRONMENT}" resolves secrets from the dev secrets file`,
    });
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
