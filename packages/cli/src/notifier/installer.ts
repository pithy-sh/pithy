// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * Detect which package manager installed the `pithy` binary and, from that, the exact upgrade command to
 * offer. Ships docs/CLI.md §5.3 verbatim: path-based detection over `process.argv[1]`, order-sensitive so
 * the `.bun`/`.deno` install roots win before the generic `node_modules` npm test. Detection runs once and
 * is cached in the notifier state file — a binary's install location doesn't change under it.
 */

/**
 * Every installer Pithy recognizes, in one runtime list. `Installer` is derived from it rather than written
 * beside it, so a seventh installer cannot join the type without joining this array — which is what lets the
 * gate in `installer.test.ts` iterate the whole union instead of a list somebody remembered to extend.
 */
export const INSTALLERS = ["npm", "pnpm", "yarn", "bun", "deno", "brew", "unknown"] as const;

/** The package managers Pithy recognizes, plus `unknown` for anything unmatched (which falls back to npm). */
export type Installer = (typeof INSTALLERS)[number];

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

/**
 * The upgrade command for an installer. `npm`/`unknown` fall back to a global npm install — anyone with Node
 * has npm.
 *
 * **The invariant every row here must hold: the command resolves the registry's `latest` tag, rather than a
 * version range an earlier global install recorded.** The notifier prints this only when a newer version
 * exists, so a command that re-resolves the old range is advice that cannot do its one job. That is why the
 * package-manager rows say `install`/`add` rather than `update`/`upgrade`: the update verbs honor the range
 * in the global manifest — which for a 0.x caret is the minor, and may be an exact pin — while the install
 * verbs name no range, resolve `latest`, and rewrite what is recorded. See #577.
 *
 * The gate for this lives in `installer.test.ts`, held over the whole `INSTALLERS` union rather than over a
 * remembered list of rows.
 */
export function upgradeCommandFor(installer: Installer): string {
  switch (installer) {
    case "bun":
      return "bun install -g @pithy-sh/cli";
    case "pnpm":
      return "pnpm add -g @pithy-sh/cli";
    // Yarn 1 spelling, and the only one there is: Yarn 2+ removed `yarn global` outright, so a binary that
    // came from `yarn global add` is on Yarn 1 by construction and there is no modern spelling to prefer.
    case "yarn":
      return "yarn global add @pithy-sh/cli";
    // `-f` is not optional: without it deno exits 1 with "Existing installation found. Aborting (Use -f to
    // overwrite)" — and an upgrade always runs against an existing installation.
    case "deno":
      return "deno install --reload -f -g -A -n pithy npm:@pithy-sh/cli";
    // Homebrew and npm record no range to respect — brew has a formula, and npm's global prefix has no
    // package.json — so their upgrade verbs already land `latest`. Left alone on purpose.
    case "brew":
      return "brew upgrade pithy";
    case "npm":
    case "unknown":
      return "npm i -g @pithy-sh/cli";
    default: {
      // Enrollment, enforced by the compiler rather than by memory: with every member cased above,
      // `installer` is `never` here. Add an installer to INSTALLERS without giving it a command and this
      // line stops compiling — you cannot quietly inherit the npm fallback, which would sail past the gate
      // in `installer.test.ts` by being accidentally right. The runtime answer stays, because `installer`
      // is read back off a state file and may be anything.
      installer satisfies never;
      return "npm i -g @pithy-sh/cli";
    }
  }
}

// NOTE: `detectInstaller` may never actually return "deno" — a deno-installed shim can resolve under DENO_DIR
// and match the generic npm `node_modules` test first. That is a detection defect, separate from this one,
// and is filed on its own. The deno row is fixed here regardless; being unreachable is not being right.
