// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, readFile } from "node:fs/promises";
import { homedir as osHomedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ConflictError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { assertValidProjectName, kebab } from "@pithy-sh/core/src/naming/resource";
import { z } from "zod";
import { writeFileAtomic } from "../project/atomic";

/**
 * The update-notifier state file (docs/CLI.md §5.1). One small JSON document under the user's config dir
 * that caches the last registry check so the notifier stays within its 24-hour cadence, remembers the
 * detected installer (so it isn't re-derived every run), and carries the opt-out flag. It is advisory,
 * never load-bearing: a missing or corrupt file resolves to a safe default rather than breaking the CLI.
 */
export const NotifierState = z
  .object({
    lastCheck: z
      .number()
      .int()
      .nonnegative()
      .describe("Epoch-ms timestamp of the last registry check — the 24-hour cache gate compares against it."),
    latestVersion: z
      .string()
      .nullable()
      .describe("The latest CLI version the last successful check saw, or null before any check succeeded."),
    installer: z
      .enum(["npm", "pnpm", "yarn", "bun", "deno", "brew", "unknown"])
      .describe("The package manager that installed the binary — detected once, cached, drives the upgrade command."),
    notifier: z
      .boolean()
      .describe("Notifier opt-out state: true is enabled, false suppresses the update notice (set via pithy doctor)."),
    securityFlagged: z
      .boolean()
      .optional()
      .describe("Whether the latest release carries a `pithy:security` marker — lets a patch bump notify anyway."),
  })
  .describe(
    "Cached update-notifier state (~/.config/pithy/state.json): last check, latest version, installer, opt-out.",
  );
export type NotifierState = z.output<typeof NotifierState>;

/** The safe default returned when the state file is missing, malformed, or fails validation. Never throws. */
export function defaultState(): NotifierState {
  return { lastCheck: 0, latestVersion: null, installer: "unknown", notifier: true };
}

/** Injectable environment seams so path resolution is testable without touching the real HOME/APPDATA. */
export interface StatePathOptions {
  /** The platform, defaulting to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Environment map, defaulting to `process.env` (read for `PITHY_CONFIG_DIR` / `XDG_CONFIG_HOME` / `APPDATA`). */
  env?: NodeJS.ProcessEnv;
  /** The user's home directory, defaulting to `os.homedir()`. */
  homedir?: string;
}

/**
 * The one environment variable that relocates everything Pithy keeps per machine — the notifier state,
 * `<project>/dev.json`, and `<project>/secrets.jsonc`.
 *
 * **Required, not a convenience (#156).** Dev secrets live under this directory now, so without an
 * override every test that scaffolds a project called `replay` writes to the operator's real file, and
 * CI — which has no home directory worth writing to — writes to whatever `$HOME` happens to be. One
 * variable moves the whole tree, which is also what makes per-worktree isolation a later configuration
 * change rather than a redesign.
 */
const CONFIG_DIR_ENV = "PITHY_CONFIG_DIR";

/**
 * The one way a test may resolve the operator's real config directory: say so, in the environment, and
 * mean it. Any non-blank value.
 *
 * It exists so {@link stateDir}'s refusal is a rule rather than a wall — a suite that genuinely needs the
 * real location has an answer, and it is one line a reviewer can see. Nothing in this repository sets it,
 * and `packages/cli/src/ci/testIsolation.test.ts` fails if a vitest config ever does: granting the
 * exemption to one suite is a decision, granting it to a whole package is an accident waiting.
 */
const ALLOW_REAL_ENV = "PITHY_ALLOW_REAL_CONFIG_DIR";

/**
 * Whether this process is a vitest run.
 *
 * Two signals, because either alone has a gap. `VITEST` is set in every worker and is inherited by a CLI
 * this suite spawns — which is the point, since a spawned `pithy` inherits `PITHY_CONFIG_DIR` with it.
 * `__vitest_worker__` is on the runner's `globalThis` and survives a test that hands product code a
 * curated environment, which the variable does not.
 */
function underVitest(): boolean {
  if ((process.env.VITEST ?? "").length > 0) return true;
  return "__vitest_worker__" in globalThis;
}

/**
 * Refuse to answer with the operator's own machine.
 *
 * Called at each point where the resolution is about to read something the caller did not choose:
 * `process.env` is the operator's shell, `os.homedir()` is their home directory. Outside vitest both are
 * exactly the right answer, so this returns and the resolver carries on.
 */
function refuseRealDirectory(env: NodeJS.ProcessEnv, detail: string): void {
  if (!underVitest()) return;
  const allowed = env[ALLOW_REAL_ENV];
  if (allowed !== undefined && allowed.trim().length > 0) return;
  throw new ConflictError({
    message: `A test asked for the real Pithy config directory. Set ${CONFIG_DIR_ENV} to a throwaway directory instead.`,
    action: `Pass \`paths\`/\`StatePathOptions\` at the call site, or let the repo-root \`vitest.setup.ts\` set ${CONFIG_DIR_ENV}. A suite that means the operator's own directory sets ${ALLOW_REAL_ENV}=1.`,
    detail: `stateDir() refused under vitest: ${detail}. That directory holds minted dev master keys and account credentials — #200.`,
  });
}

/** The home directory to resolve against. Refuses to hand back the operator's under vitest. */
function homeDirectory(options: StatePathOptions, env: NodeJS.ProcessEnv): string {
  if (options.homedir !== undefined) return options.homedir;
  refuseRealDirectory(env, "no injected homedir, so the answer would be the operator's home directory");
  return osHomedir();
}

/**
 * The Pithy config directory: `$PITHY_CONFIG_DIR` when set, else `%APPDATA%\pithy` on Windows,
 * `$XDG_CONFIG_HOME/pithy` when that is set, else `~/.config/pithy`. This is the exact directory
 * `pithy doctor` reports (tilde-abbreviated).
 *
 * **The override is the directory itself, with no `pithy` segment appended.** `XDG_CONFIG_HOME` names a
 * config *root* shared with every other program, so Pithy has to claim a subdirectory of it; this names
 * Pithy's own directory, so appending would make `PITHY_CONFIG_DIR=/tmp/x` resolve to `/tmp/x/pithy` and
 * every harness that reads `$PITHY_CONFIG_DIR/<project>/secrets.jsonc` back would find nothing.
 *
 * **Absolute, always.** A relative value is resolved against the cwd once, here — every error raised
 * about a file under this directory names its absolute path, and a relative root would make that path
 * mean a different place in each command that resolves its own working directory. Blank is no override:
 * an unset variable and one exported empty by a shell script are the same intention.
 *
 * **Under vitest it refuses rather than resolve the operator's own machine (#200).** This is the single
 * resolver — dev secrets, dev preferences, `cloudflare.json` and the notifier state all come through
 * here — which is what makes the invariant checkable in one place. A test may answer with
 * `PITHY_CONFIG_DIR`, or with seams that supply whatever the resolution needs; it may not answer with
 * `process.env` or `os.homedir()`, because a test chose neither. A suite that means the real directory
 * sets {@link ALLOW_REAL_ENV}. Outside vitest nothing changes, and a real `pithy` run never sees this.
 */
export function stateDir(options: StatePathOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;

  const override = env[CONFIG_DIR_ENV];
  if (override !== undefined && override.trim().length > 0) return resolve(override);

  // No override, and the environment about to decide the answer is the operator's shell rather than one
  // the caller built. Everything below this line would be their machine.
  if (options.env === undefined) {
    refuseRealDirectory(env, `${CONFIG_DIR_ENV} is unset and no environment was injected`);
  }

  if (platform === "win32") {
    const appData = env.APPDATA ?? join(homeDirectory(options, env), "AppData", "Roaming");
    return join(appData, "pithy");
  }
  const xdg = env.XDG_CONFIG_HOME;
  return xdg ? join(xdg, "pithy") : join(homeDirectory(options, env), ".config", "pithy");
}

/** The state file path: `<stateDir>/state.json`. */
export function stateFilePath(options: StatePathOptions = {}): string {
  return join(stateDir(options), "state.json");
}

/**
 * `<config>/<project>/` — **the one door a project name goes through to become a directory**, and the
 * one place the rule that it may is stated (#212).
 *
 * That directory holds every dev secret a project has: `secrets.jsonc`, `dev.json`, `tokens.json`, and
 * since #206 the account-scoped credentials sit beside it. The gates that guard project writes do not
 * reach it — `ensureScaffoldPath` guards writes *inside a project*, and this path is in the config
 * directory, outside every checkout. There is no second line of defence, so the join states its own.
 *
 * **It was safe before this, and that is the point.** Every caller passes a name already through
 * `requireProjectName` or `kebab`. What was missing is where the rule *lived*: at each call site, which
 * is the #183 shape — #171 narrowed a manifest's default values, #174 an option's key and describe, #183
 * the capability's own name, three rounds for one rule that was never stated where it belonged. A caller
 * that is safe because it happens to have normalised earlier is safe by a property of the call graph,
 * and #206 added a caller to this family within a day of the last one.
 *
 * **Two halves, because a name arrives two ways (#206).** {@link assertValidProjectName} is read *after*
 * kebabbing, deliberately: `Acme Corp` is a legal project name because it *becomes* `acme-corp`. So it
 * is a statement about the slug, not about the string in hand — `My/Project` passes it whole, and joined
 * verbatim it is two path segments. The second half is that the value **is** its own normalised form, so
 * the typed name and the slug are held to one rule rather than the rule being true of only one of them.
 */
export function projectConfigDir(project: string, options: StatePathOptions = {}): string {
  return join(stateDir(options), projectConfigSegment(project));
}

/**
 * The validator every config string passes before it is joined into the config directory.
 *
 * Separate from the join because that is what the gate in `./state.test.ts` can see: the invariant is
 * "no config string is joined into the config directory without passing a validator", stated that way
 * rather than as a list of the joiners known today — enumerating is what produced the second and third
 * instance of every other class of this in the tree.
 *
 * A `ValidationError`, and it names the value: a project name is something a human typed into
 * `pithy.config.ts`, and it is not a secret.
 */
export function projectConfigSegment(project: string): string {
  assertValidProjectName(project);
  if (project !== kebab(project)) {
    throw new ValidationError({
      message: `"${project}" can't be a directory name.`,
      action: "Use the normalized project name — lowercase letters, digits, and single hyphens.",
      detail: `"${project}" is a valid project name only after kebabbing to "${kebab(project)}", and it is joined into the Pithy config directory verbatim. Pass the name requireProjectName returns.`,
    });
  }
  return project;
}

/**
 * Read and validate the state file. A missing file, malformed JSON, or a payload that fails validation all
 * resolve to {@link defaultState} — a corrupt state file must never break the CLI (docs/CLI.md §5.1). A
 * hand-edited `"notifier": false` is honored, since it round-trips through the same schema.
 */
export async function readState(file: string): Promise<NotifierState> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return defaultState();
  }
  try {
    return NotifierState.parse(JSON.parse(raw));
  } catch {
    return defaultState();
  }
}

/** Write the state file atomically, creating its directory on first write. Validates before writing. */
export async function writeState(file: string, state: NotifierState): Promise<void> {
  const validated = NotifierState.parse(state);
  await mkdir(dirname(file), { recursive: true });
  await writeFileAtomic(file, `${JSON.stringify(validated, null, 2)}\n`);
}

/** Set the notifier opt-out flag in the state file, preserving every other field. Used by `pithy doctor`. */
export async function setNotifierFlag(file: string, enabled: boolean): Promise<void> {
  const state = await readState(file);
  await writeState(file, { ...state, notifier: enabled });
}
