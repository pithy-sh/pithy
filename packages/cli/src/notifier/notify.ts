import { saffron } from "../terminal/style";
import { type FetchLike, refreshCliState } from "./check";
import { type Installer, upgradeCommandFor } from "./installer";
import { readState, stateFilePath, writeState } from "./state";
import { type Bump, classifyBump, parseVersion } from "./version";

/**
 * The end-of-command update notice (docs/CLI.md §5.2): its suppression rules, its exact stderr strings, and
 * {@link runUpdateNotifier} — the fire-and-forget entry point `bin.ts` calls after a command's primary work.
 * The check is `setImmediate`-scheduled so it never blocks the command, silent on every failure, and the
 * notice prints to stderr only when every suppression rule holds.
 */

/** The inputs the four suppression rules read. All must hold for the notice to print. */
export interface SuppressionInput {
  /** `process.stderr.isTTY` — piped/CI output suppresses the whole notice. */
  isTTY: boolean;
  /** Environment map — `PITHY_NO_UPDATE_NOTIFIER` (any value) suppresses. */
  env: NodeJS.ProcessEnv;
  /** The state opt-out flag: `false` suppresses. */
  notifierEnabled: boolean;
  /** The version gap. */
  bump: Bump;
  /** Whether the latest release is security-flagged (lets a patch bump through). */
  securityFlagged: boolean;
}

/**
 * Whether the update notice may print. Every rule must hold: stderr is a TTY, `PITHY_NO_UPDATE_NOTIFIER`
 * is unset, the state flag is enabled, and the bump is minor/major (or a security-flagged patch). A plain
 * patch is suppressed — patch noise trains users to ignore the surface. `NO_COLOR` is deliberately not a
 * rule here: it only drops the accent (handled by the `saffron` seam), never suppresses.
 */
export function shouldNotify(input: SuppressionInput): boolean {
  if (!input.isTTY) return false;
  if (input.env.PITHY_NO_UPDATE_NOTIFIER) return false;
  if (!input.notifierEnabled) return false;
  if (input.bump === "minor" || input.bump === "major") return true;
  if (input.bump === "patch" && input.securityFlagged) return true;
  return false;
}

/** Parameters for the notice string. `accent` is the saffron seam, injectable so tests can assert placement. */
export interface NoticeInput {
  installed: string;
  latest: string;
  installer: Installer;
  bump: Bump;
  accent?: (text: string) => string;
}

/**
 * Build the stderr notice. Starts with a blank line (it follows the command's `Done.`). The new version and
 * the word `available` carry the accent; a major bump adds the `(Major release — see changelog.)` note and a
 * `Changelog:` line pointing at `https://pithy.sh/changelog/<newMajor>.0`.
 */
export function formatUpdateNotice(input: NoticeInput): string {
  const accent = input.accent ?? saffron;
  const command = upgradeCommandFor(input.installer);
  const major = parseVersion(input.latest)?.major ?? 0;

  const lead = `pithy ${accent(input.latest)} ${accent("available")}. You have ${input.installed}.`;
  const lines = [""];
  if (input.bump === "major") {
    lines.push(`${lead} (Major release — see changelog.)`);
    lines.push(`Update: ${command}`);
    lines.push(`Changelog: https://pithy.sh/changelog/${major}.0`);
  } else {
    lines.push(lead);
    lines.push(`Update: ${command}`);
  }
  return lines.join("\n");
}

/** Options for {@link runUpdateNotifier} — every side-effecting dependency is injectable for tests. */
export interface RunUpdateNotifierOptions {
  /** The currently-running CLI version (from the CLI's own package.json). */
  installedVersion: string;
  /** Injected `fetch`; defaults to the global. */
  fetch?: FetchLike;
  /** The clock; defaults to `Date.now`. */
  now?: () => number;
  /** Override the state file path (defaults to the resolved `~/.config/pithy/state.json`). */
  stateFile?: string;
  /** `process.argv[1]`, for one-time installer detection. */
  argv1?: string;
  /** Environment map; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Whether stderr is a TTY; defaults to `process.stderr.isTTY`. */
  isTTY?: boolean;
  /** stderr writer; defaults to writing to `process.stderr`. */
  stderr?: (text: string) => void;
  /** Scheduler; defaults to `setImmediate` — the notice fires after the command's work. */
  schedule?: (fn: () => void) => void;
  /** The accent seam; defaults to `saffron`. */
  accent?: (text: string) => string;
}

/**
 * The background job: refresh the state within the 24-hour gate, persist it when a check succeeded, then
 * print the notice if every suppression rule holds. Every failure is swallowed by the caller's `.catch`.
 */
async function notifierJob(options: RunUpdateNotifierOptions): Promise<void> {
  const file = options.stateFile ?? stateFilePath();
  const now = options.now ?? Date.now;
  const env = options.env ?? process.env;
  const isTTY = options.isTTY ?? Boolean(process.stderr.isTTY);
  const write = options.stderr ?? ((text: string) => void process.stderr.write(text));

  const current = await readState(file);
  const { state, updated } = await refreshCliState(current, {
    fetch: options.fetch,
    now,
    argv1: options.argv1,
  });
  if (updated) await writeState(file, state);

  if (!state.latestVersion) return;
  const bump = classifyBump(options.installedVersion, state.latestVersion);
  const eligible = shouldNotify({
    isTTY,
    env,
    notifierEnabled: state.notifier,
    bump,
    securityFlagged: state.securityFlagged ?? false,
  });
  if (!eligible) return;

  const notice = formatUpdateNotice({
    installed: options.installedVersion,
    latest: state.latestVersion,
    installer: state.installer,
    bump,
    accent: options.accent,
  });
  write(`${notice}\n`);
}

/**
 * Fire the update notifier — the entry point `bin.ts` calls after the command's primary work. Returns
 * immediately: the check is scheduled via `setImmediate` (so the command's output, including `Done.`, is
 * already flushed) and runs fire-and-forget, with every error swallowed. It never blocks or delays exit.
 */
export function runUpdateNotifier(options: RunUpdateNotifierOptions): void {
  const schedule = options.schedule ?? setImmediate;
  schedule(() => {
    void notifierJob(options).catch(() => {});
  });
}
