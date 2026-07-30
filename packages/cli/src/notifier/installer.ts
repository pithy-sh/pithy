// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * Detect which package manager installed the `pithy` binary and, from that, the exact upgrade command to
 * offer. Ships docs/CLI.md §5.3 verbatim: path-based detection over `process.argv[1]`, order-sensitive so
 * the `.bun`/`.deno` install roots win before the generic `node_modules` npm test. Detection runs once and
 * is cached in the notifier state file — a binary's install location doesn't change under it.
 */

/** The package managers Pithy recognizes, plus `unknown` for anything unmatched (which falls back to npm). */
export type Installer = "npm" | "pnpm" | "yarn" | "bun" | "deno" | "brew" | "unknown";

/**
 * Detect the installer from a binary path (defaults to `process.argv[1]`). Backslashes are normalized to
 * forward slashes first so a Windows path matches the same tests. Order matters: `.bun`/`.deno` roots are
 * tested before the generic npm `node_modules` catch, and Homebrew before yarn.
 */
export function detectInstaller(argv1: string = process.argv[1] ?? ""): Installer {
  const binPath = argv1.replace(/\\/g, "/");

  if (binPath.includes("/.bun/")) return "bun";
  if (binPath.includes("/.deno/")) return "deno";
  if (/\/pnpm\/|\/\.pnpm\//.test(binPath)) return "pnpm";
  if (/\/(?:home|linux)brew\/|\/Cellar\//.test(binPath)) return "brew";
  if (/\/\.yarn\/|\/yarn\/global\//.test(binPath)) return "yarn";
  if (/\/npm\/|\/node_modules\//.test(binPath)) return "npm";

  return "unknown";
}

/** The upgrade command for an installer. `npm`/`unknown` fall back to a global npm install — anyone with Node has npm. */
export function upgradeCommandFor(installer: Installer): string {
  switch (installer) {
    case "bun":
      return "bun update -g @pithy-sh/cli";
    case "pnpm":
      return "pnpm update -g @pithy-sh/cli";
    case "yarn":
      return "yarn global upgrade @pithy-sh/cli";
    case "deno":
      return "deno install --reload -g -A -n pithy npm:@pithy-sh/cli";
    case "brew":
      return "brew upgrade pithy";
    default:
      return "npm i -g @pithy-sh/cli";
  }
}
