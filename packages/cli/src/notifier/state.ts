import { mkdir, readFile } from "node:fs/promises";
import { homedir as osHomedir } from "node:os";
import { dirname, join } from "node:path";
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
  /** Environment map, defaulting to `process.env` (read for `XDG_CONFIG_HOME` / `APPDATA`). */
  env?: NodeJS.ProcessEnv;
  /** The user's home directory, defaulting to `os.homedir()`. */
  homedir?: string;
}

/**
 * The Pithy config directory: `%APPDATA%\pithy` on Windows, `$XDG_CONFIG_HOME/pithy` when that is set,
 * else `~/.config/pithy`. This is the exact directory `pithy doctor` reports (tilde-abbreviated).
 */
export function stateDir(options: StatePathOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.homedir ?? osHomedir();

  if (platform === "win32") {
    const appData = env.APPDATA ?? join(home, "AppData", "Roaming");
    return join(appData, "pithy");
  }
  const xdg = env.XDG_CONFIG_HOME;
  return xdg ? join(xdg, "pithy") : join(home, ".config", "pithy");
}

/** The state file path: `<stateDir>/state.json`. */
export function stateFilePath(options: StatePathOptions = {}): string {
  return join(stateDir(options), "state.json");
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
