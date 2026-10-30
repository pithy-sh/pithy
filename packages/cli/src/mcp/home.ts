// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { homedir as osHomedir } from "node:os";
import { join, resolve } from "node:path";
import { ConflictError } from "@pithy-sh/core/src/error/pithyError";

/**
 * Where another tool keeps its configuration, resolved per operating system.
 *
 * **This is not {@link import("../notifier/state").stateDir} and must not become it.** That resolver
 * answers *where Pithy's own config lives* — one directory, one override, one rule. This one answers
 * *where ten other programs keep theirs*, and the answer is whatever each of them documented: Cursor
 * puts a dotfile in `$HOME`, Zed and Goose follow XDG on both Unixes, Claude Desktop uses Apple's
 * Application Support on macOS and XDG on Linux, and everyone spells Windows differently. There is no
 * single rule to share, so what is shared is the *shape* — the same three seams, injected the same way.
 *
 * **Four bases, because four is what the ten clients between them actually use.** A row names the base
 * its path hangs off per platform, so the platform switch lives here once rather than in ten rows.
 *
 * **Two of them let their operator move the whole directory with one variable** — Claude Code's
 * `CLAUDE_CONFIG_DIR`, Codex's `CODEX_HOME` — and {@link movedDirectory} is the one place that reads it.
 *
 * **Under vitest it refuses to answer with the operator's own home (#200).** `stateDir` earned that rule
 * guarding minted dev keys; the files here are lower stakes and the accident is worse, because a test
 * that forgets the seam does not write to a Pithy directory it could clean up — it writes into the
 * developer's real `~/.cursor/mcp.json`, which is a file Pithy does not own and a change they did not
 * ask for. A test answers with `homedir`, never with `os.homedir()`.
 */

/** The directory a client's path hangs off, per platform. */
export type PathBase =
  /** The home directory itself — a dotfile or dot-directory under `~`. */
  | "home"
  /** XDG config: `$XDG_CONFIG_HOME` when exported, else `~/.config`. Unix only. */
  | "config"
  /** macOS `~/Library/Application Support`. */
  | "appSupport"
  /** Windows `%APPDATA%`, defaulting to `~\AppData\Roaming`. */
  | "appData";

/** One resolved location: a base, and the segments under it. */
export interface BasedPath {
  /** Which base directory the segments hang off. */
  readonly base: PathBase;
  /** The path under that base, one segment per element. */
  readonly segments: readonly string[];
}

/** The environment a resolution reads, every term injectable so a test never reaches the real machine. */
export interface HomeOptions {
  /** Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Defaults to `os.homedir()` — and under vitest, an absent one is refused rather than defaulted. */
  homedir?: string;
}

/** True while the suite is running, by either of the two signals vitest sets. */
function underVitest(): boolean {
  if ((process.env.VITEST ?? "").length > 0) return true;
  return "__vitest_worker__" in globalThis;
}

/**
 * The home directory to resolve against, refusing the operator's own under vitest.
 *
 * The refusal names the seam rather than an environment variable, because unlike `stateDir` there is no
 * override to set: these paths belong to other programs, so the only honest answer a test can give is
 * a directory it built.
 */
function homeDirectory(options: HomeOptions): string {
  if (options.homedir !== undefined) return options.homedir;
  if (underVitest()) {
    throw new ConflictError({
      message: "A test asked for the real home directory, where other tools keep their MCP configuration.",
      action: "Pass `homedir` (and `env`) in `HomeOptions` at the call site, pointing at a throwaway directory.",
      detail:
        "mcp/home.ts refused under vitest: a resolution with no injected homedir would name files this " +
        "developer's own editors read, and Pithy does not own them — #200.",
    });
  }
  return osHomedir();
}

/** The platform a resolution is for. Anything that is not macOS or Windows resolves the way Linux does. */
function platformOf(options: HomeOptions): NodeJS.Platform {
  return options.platform ?? process.platform;
}

/** A shell variable the operator exported, or `undefined` when it is unset or blank. */
function exported(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  return value !== undefined && value.trim().length > 0 ? value : undefined;
}

/**
 * One base directory, resolved.
 *
 * `config` is XDG on macOS as well as Linux, deliberately: Zed and Goose both document
 * `~/.config/<tool>` for both Unixes, and a row that wanted Apple's convention says `appSupport`.
 * Guessing per platform rather than per tool is how a writer lands a file no editor reads.
 */
export function baseDirectory(base: PathBase, options: HomeOptions = {}): string {
  const env = options.env ?? process.env;
  switch (base) {
    case "home":
      return homeDirectory(options);
    case "config":
      // **XDG is consulted on Linux only, and that is not an oversight.** Zed and Goose both document a
      // literal `~/.config/<tool>` for macOS, and neither reads `XDG_CONFIG_HOME` there. A macOS operator
      // who exports it — dotfile managers routinely do — would otherwise have the entry written to a path
      // their editor never reads, and the command would report `added` while nothing was connected. A
      // write nobody reads is worse than a refusal, because nothing ever says so.
      if (platformOf(options) === "linux") {
        const xdg = exported(env, "XDG_CONFIG_HOME");
        if (xdg !== undefined) return xdg;
      }
      return join(homeDirectory(options), ".config");
    case "appSupport":
      return join(homeDirectory(options), "Library", "Application Support");
    case "appData":
      return exported(env, "APPDATA") ?? join(homeDirectory(options), "AppData", "Roaming");
  }
}

/**
 * The directory a tool's own variable moved its configuration to, absolute, or `undefined` when the shell
 * exports none — an empty value moves nothing, exactly as an unset one.
 *
 * **Under vitest it refuses an environment nobody injected, even with a home that was.** This is the one
 * term that can carry a write out of a test's throwaway home altogether: a developer running a second
 * Claude Code profile exports `CLAUDE_CONFIG_DIR`, and a test that fell through to `process.env` would
 * write the file that profile's agent reads.
 */
export function movedDirectory(variable: string, options: HomeOptions = {}): string | undefined {
  if (options.env === undefined && underVitest()) {
    throw new ConflictError({
      message: `A test asked for ${variable} from the real environment, where it names the operator's own profile.`,
      action: "Pass `env` (and `homedir`) in `HomeOptions` at the call site.",
      detail: `mcp/home.ts refused under vitest: ${variable} moves a client's configuration out of any home a test built — #900.`,
    });
  }
  const moved = exported(options.env ?? process.env, variable);
  return moved === undefined ? undefined : resolve(moved);
}

/** A based path, resolved to an absolute path. */
export function resolveUnder(path: BasedPath, options: HomeOptions = {}): string {
  return join(baseDirectory(path.base, options), ...path.segments);
}
