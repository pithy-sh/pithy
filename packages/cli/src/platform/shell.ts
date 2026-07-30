// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { existsSync } from "node:fs";
import { homedir as osHomedir } from "node:os";
import { basename, join } from "node:path";

/** The shells whose alias syntax and rc-file location we know how to write. */
export type ShellKind = "bash" | "zsh" | "fish" | "powershell" | "nushell";

/** A resolved shell: which one, where its config lives, and the exact line that defines `p.`. */
export interface ShellInfo {
  /** The detected shell family. */
  kind: ShellKind;
  /** Absolute path to the rc/profile file the alias line belongs in. */
  rcPath: string;
  /** The shell-specific line that defines the `p.` alias (no markers). */
  aliasSyntax: string;
}

/** Injectable seams so detection is testable without touching the real environment. */
export interface DetectShellOptions {
  /** The shell path, defaulting to `process.env.SHELL` (e.g. `/bin/zsh`). */
  shell?: string;
  /** The platform, defaulting to `process.platform`. */
  platform?: NodeJS.Platform;
  /** The user's home directory, defaulting to `os.homedir()`. */
  homedir?: string;
  /** Existence probe, defaulting to `fs.existsSync` — used for the macOS `.bash_profile` preference. */
  fileExists?: (path: string) => boolean;
}

/** The bash/zsh single-quoted form; also the fallback we print for an unknown shell. */
const POSIX_ALIAS = "alias p.='pithy'";

/**
 * Detect the current shell and resolve where its `p.` alias belongs.
 *
 * Detection is `basename($SHELL)` plus platform checks, per docs/CLI.md §2.4. bash on macOS prefers
 * `.bash_profile` (the platform convention) and falls back to `.bashrc` only when it is absent. Windows
 * with no unix shell resolves to PowerShell — whose alias MUST be a function, not `Set-Alias` (that
 * rejects a `.` in the name). An unrecognized shell returns `null`: the caller prints manual instructions
 * and writes nothing. We never guess an rc file.
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
  if (platform === "win32" || base.endsWith("pwsh") || base.endsWith("powershell")) {
    const rcPath = join(home, "Documents", "PowerShell", "Microsoft.PowerShell_profile.ps1");
    return { kind: "powershell", rcPath, aliasSyntax: "function p. { pithy @args }" };
  }

  return null;
}
