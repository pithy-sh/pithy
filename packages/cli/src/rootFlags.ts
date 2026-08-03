// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * The root flags `bin.ts` answers before citty ever parses. Kept here, dependency-free, so the rule is a
 * pure function with its own tests — `bin.ts` is an entry script with top-level side effects and cannot
 * be imported.
 */

/** Everything after this separator is payload for a child process, never a Pithy flag. */
const PASSTHROUGH = "--";

const VERSION_FLAGS = new Set(["--version", "-v"]);
const HELP_FLAGS = new Set(["--help", "-h"]);

/**
 * Whether this invocation is asking for the version, on any command.
 *
 * citty ships a version builtin but answers it only when it is the **sole** argument
 * (`rawArgs.length === 1`), so `pithy add --version` runs `add` instead — it prints `add`'s "name a
 * capability" error and exits 1. docs/CLI.md §1.2 promises the flag works anywhere `--help` does, so the
 * bin answers it itself.
 *
 * **The rule is "anywhere before `--`", matching how citty already resolves `--help`.** The alternative —
 * root-level only, before the subcommand — cannot satisfy §1.2, since the flag's whole point is that it
 * follows a command. What keeps that from swallowing real input is that a caller always has two escapes,
 * and both are honored here: `--` for opaque payload, and the `--flag=--version` form for a value that is
 * literally the string. Only a bare, exactly-matching token counts, so `--set version=2`, `--versions`,
 * and a positional named `version` all pass through untouched.
 *
 * Help wins when both appear, because citty checks help first and this must not change that ordering.
 */
export function wantsVersion(argv: string[]): boolean {
  const separator = argv.indexOf(PASSTHROUGH);
  const flags = separator === -1 ? argv : argv.slice(0, separator);
  if (flags.some((arg) => HELP_FLAGS.has(arg))) return false;
  return flags.some((arg) => VERSION_FLAGS.has(arg));
}
