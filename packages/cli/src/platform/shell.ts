// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { existsSync } from "node:fs";
import { homedir as osHomedir } from "node:os";
import { basename, join, posix } from "node:path";
import { environmentValue, execCommand, resolveCommand } from "./command";
import { systemExecutable } from "./killTree";

/** The shells whose alias syntax and rc-file location we know how to write. */
export type ShellKind = "bash" | "zsh" | "fish" | "powershell" | "nushell";

/** A resolved shell: which one, where its config lives, and the exact line that defines `p.`. */
export interface ShellInfo {
  /** The detected shell family. */
  kind: ShellKind;
  /** Absolute path to the rc file the alias line belongs in. */
  rcPath: string;
  /**
   * Additional rc files that carry the same alias for the same user — non-empty only for
   * `powershell` (#701 item 6). Windows has two PowerShell families, 5.1 and 7, each auto-loading
   * its own `CurrentUserCurrentHost` profile from its own root (`Documents\WindowsPowerShell` and
   * `Documents\PowerShell`). There is no single file both read, so writing one leaves the other's
   * sessions without the alias — and the silent half is 5.1, which ships with Windows while `pwsh`
   * 7 must be installed. The alias block therefore lives in every family's profile, and install,
   * remove, status, and doctor treat the set as one logical location.
   */
  extraRcPaths?: string[];
  /** The shell-specific line that defines the `p.` alias (no markers). */
  aliasSyntax: string;
}

/** Every rc file that carries the alias: {@link ShellInfo.rcPath} first, then any extras. */
export function aliasRcPaths(shell: ShellInfo): string[] {
  return shell.extraRcPaths === undefined ? [shell.rcPath] : [shell.rcPath, ...shell.extraRcPaths];
}

/** Injectable seams so detection is testable without touching the real environment. */
export interface DetectShellOptions {
  /** The shell path, defaulting to `process.env.SHELL` (e.g. `/bin/zsh`). */
  shell?: string;
  /** The platform, defaulting to `process.platform`. */
  platform?: NodeJS.Platform;
  /**
   * The user's home directory, defaulting to `os.homedir()`. For PowerShell it feeds only the fallback:
   * an edition's own `$PROFILE` answer wins, and a real PowerShell answers for the real user, so a test
   * that fakes home also passes {@link askProfile}.
   */
  homedir?: string;
  /** Existence probe, defaulting to `fs.existsSync` — used for the macOS `.bash_profile` preference. */
  fileExists?: (path: string) => boolean;
  /** Seam: asks one PowerShell edition for `$PROFILE`, defaulting to running it ({@link askProfileOf}). */
  askProfile?: AskProfile;
}

/** The PowerShell editions the alias installs into: 7 (`pwsh`) anywhere, and 5.1 on Windows. */
export type PowerShellEdition = "pwsh" | "windows-powershell";

/**
 * Ask one edition where its profile is: resolves with what it printed, rejects when it cannot be run or
 * does not answer in time. Every rejection means the same thing to the caller, which falls back.
 */
export type AskProfile = (edition: PowerShellEdition) => Promise<string>;

/** The profile file both editions load for the current user and host. */
const PROFILE_FILE = "Microsoft.PowerShell_profile.ps1";

/**
 * Fixed argv, so nothing reaches PowerShell but its own variable. `-NoProfile` keeps the profile we
 * are asking about from running; `$PROFILE` is defined without it.
 */
export const PROFILE_ARGS = [
  "-NoLogo",
  "-NoProfile",
  "-NonInteractive",
  "-Command",
  // Piped output leaves PowerShell in the console's legacy code page, and Node reads it as UTF-8, so
  // `C:\Users\José` would arrive mangled. UTF-8 first, then the variable.
  "[Console]::OutputEncoding = [Text.Encoding]::UTF8; $PROFILE",
];

/** A cold PowerShell start on Windows takes a second or two; past this, the default is the answer. */
const PROFILE_TIMEOUT_MS = 10_000;

/**
 * The default {@link AskProfile}: run the edition and return what it printed.
 *
 * **Nothing runs from a guessed location.** `CreateProcess` looks a bare name up in the working
 * directory, which is the adopter's project, before `PATH`. So 5.1 runs from its full System32 path,
 * and `pwsh` on Windows runs only when `PATH` resolves it to a file; a `pwsh` found nowhere is not run,
 * and its edition falls back. Off Windows, `execvp` searches `PATH` alone. A short timeout, the output
 * collected, and no shell: the census bounds both calls in this module (`ci/narration.test.ts`).
 */
export function askProfileOf(
  platform: NodeJS.Platform,
  deps: { fileExists?: (path: string) => boolean } = {},
): AskProfile {
  return async (edition) => {
    const options = { timeout: PROFILE_TIMEOUT_MS, windowsHide: true, platform, fileExists: deps.fileExists };
    if (edition === "windows-powershell") {
      if (environmentValue(process.env, "SystemRoot") === undefined) {
        throw new Error("SystemRoot is not set, so Windows PowerShell has no System32 path to run from.");
      }
      return (await execCommand(systemExecutable("WindowsPowerShell/v1.0/powershell"), PROFILE_ARGS, options)).stdout;
    }
    if (platform === "win32") {
      const resolved = resolveCommand("pwsh", [], { platform, fileExists: deps.fileExists });
      if (resolved.command === "pwsh") throw new Error("pwsh is not on PATH.");
      // A batch shim runs through `cmd.exe`, and a timeout would end the wrapper and leave pwsh running.
      if (resolved.verbatim) throw new Error("pwsh resolves to a batch shim, which is not run.");
    }
    return (await execCommand("pwsh", PROFILE_ARGS, options)).stdout;
  };
}

/**
 * The profile path in what PowerShell printed for `$PROFILE`, or `null` when the output is not one.
 *
 * One line, absolute by the rules of the platform that printed it, naming a `.ps1`. Anything else, a
 * warning line before it included, is no answer: the caller falls back rather than write a startup file
 * somewhere it inferred.
 */
export function profileFromOutput(stdout: string, platform: NodeJS.Platform): string | null {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (lines.length !== 1) return null;
  const [path] = lines as [string];
  // On Windows: a drive (`C:\`) or a share (`\\server\…`, where folder redirection puts Documents).
  // `win32.isAbsolute` alone also accepts `\Users\…`, which names no drive and resolves against the cwd's.
  const absolute = platform === "win32" ? /^([a-z]:\\|\\\\[^\\])/i.test(path) : posix.isAbsolute(path);
  // U+FFFD is what a byte that did not decode becomes: the name is not the one on disk.
  return absolute && !path.includes("\uFFFD") && path.toLowerCase().endsWith(".ps1") ? path : null;
}

/** One edition's profile: its own answer when it gives one, else `fallback`. */
async function profileOf(
  edition: PowerShellEdition,
  fallback: string,
  ask: AskProfile,
  platform: NodeJS.Platform,
): Promise<string> {
  try {
    return profileFromOutput(await ask(edition), platform) ?? fallback;
  } catch {
    return fallback;
  }
}

/** The bash/zsh single-quoted form; also the fallback we print for an unknown shell. */
const POSIX_ALIAS = "alias p.='pithy'";

/**
 * Detect the current shell and resolve where its `p.` alias belongs.
 *
 * Detection is `basename($SHELL)` plus platform checks, per docs/CLI.md §2.4. bash on macOS prefers
 * `.bash_profile` (the platform convention) and falls back to `.bashrc` only when it is absent. Windows
 * with no unix shell resolves to PowerShell — whose alias MUST be a function, not `Set-Alias` (that
 * rejects a `.` in the name), and whose profiles are a **set** (#701: 5.1 and 7 auto-load different
 * files, verified on a Windows host 2026-10-11). An unrecognized shell returns `null`: the caller
 * prints manual instructions and writes nothing. We never guess an rc file.
 */
export async function detectShell(options: DetectShellOptions = {}): Promise<ShellInfo | null> {
  const shell = options.shell ?? process.env.SHELL ?? "";
  const platform = options.platform ?? process.platform;
  const home = options.homedir ?? osHomedir();
  const fileExists = options.fileExists ?? existsSync;
  const base = basename(shell).toLowerCase();

  if (base.endsWith("bash")) {
    // macOS ships the `.bash_profile` convention; prefer it when it exists, else `.bashrc`.
    const rcPath =
      platform === "darwin" && fileExists(join(home, ".bash_profile"))
        ? join(home, ".bash_profile")
        : join(home, ".bashrc");
    return { kind: "bash", rcPath, aliasSyntax: POSIX_ALIAS };
  }

  if (base.endsWith("zsh")) {
    return { kind: "zsh", rcPath: join(home, ".zshrc"), aliasSyntax: POSIX_ALIAS };
  }

  if (base.endsWith("fish")) {
    // fish has no `=` in its alias form.
    return { kind: "fish", rcPath: join(home, ".config", "fish", "config.fish"), aliasSyntax: "alias p. pithy" };
  }

  if (base.endsWith("nu")) {
    // nushell uses a spaced `=` form.
    return { kind: "nushell", rcPath: join(home, ".config", "nushell", "config.nu"), aliasSyntax: "alias p. = pithy" };
  }

  // PowerShell: a unix shell was not detected but we are on Windows (or the shell names PowerShell
  // explicitly). `Set-Alias` rejects a `.` in the name, so the alias must be a passthrough function.
  //
  // **Two families, two profiles, one logical location (#701 item 6).** Windows ships PowerShell
  // 5.1, and PowerShell 7 (`pwsh`) is installed beside it. Each auto-loads its own profile and no
  // file loads in both, so the alias is written to both. The family that is not installed simply
  // holds an inert block — and the day it is installed, the alias is already there, which is the
  // same reason a `.zshrc` sitting in the home directory costs nothing to a zsh user. The primary is
  // the 7 path; the 5.1 path rides in extras.
  //
  // **Where each profile lives is PowerShell's answer, not ours (#708).** OneDrive redirects
  // `Documents` on Windows and `$PROFILE` follows it; `pwsh` on macOS and Linux loads
  // `~/.config/powershell`. So each edition is asked for `$PROFILE`, and the platform default stands
  // only for an edition that cannot answer.
  if (platform === "win32" || base.endsWith("pwsh") || base.endsWith("powershell")) {
    const ask = options.askProfile ?? askProfileOf(platform);
    // The 5.1 profile is a Windows file: 5.1 ships with Windows, and `pwsh` on macOS or Linux is a
    // POSIX pwsh with no 5.1 sibling to top up — so only `pwsh` is asked there.
    const [seven, five] = await Promise.all([
      profileOf(
        "pwsh",
        platform === "win32"
          ? join(home, "Documents", "PowerShell", PROFILE_FILE)
          : join(home, ".config", "powershell", PROFILE_FILE),
        ask,
        platform,
      ),
      platform === "win32"
        ? profileOf("windows-powershell", join(home, "Documents", "WindowsPowerShell", PROFILE_FILE), ask, platform)
        : null,
    ]);
    return {
      kind: "powershell",
      rcPath: seven,
      extraRcPaths: five === null || five === seven ? [] : [five],
      aliasSyntax: "function p. { pithy @args }",
    };
  }

  return null;
}
