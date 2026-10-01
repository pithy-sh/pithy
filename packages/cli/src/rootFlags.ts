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

/** The two spellings that say who the `--json` line is for. Not a citty boolean, so both are written out. */
const PRETTY = "--pretty";
const NO_PRETTY = "--no-pretty";

/**
 * Every spelling this module answers to, for anything that has to enumerate the CLI's flags.
 *
 * Exported so `docs/catalog.ts` composes the docs catalog's `globalFlags` from the sets that decide,
 * rather than restating them. These six are in no command's `args` — citty answers one builtin and
 * this module answers the rest, all before a command is dispatched — so a walk of the command tree
 * finds none of them, and a check reading only that walk would call `pithy add --help` a typo.
 *
 * **`--no-pretty` is written out rather than derived.** citty gives every declared boolean a `--no-`
 * spelling for free; a flag answered before citty parses is not a citty boolean and gets nothing for
 * free, so the negation is a member of this list like any other.
 */
export const ROOT_FLAGS: readonly string[] = [...HELP_FLAGS, ...VERSION_FLAGS, PRETTY, NO_PRETTY];

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

/**
 * One pretty token, read: which spelling it is and what value it carries, or `null` if it is not one.
 *
 * **The `=value` spelling has to be read, because the parser already accepts it.** `scan()` in
 * `declaredFlags.ts` records Node `parseArgs`' `rawName`, which is `--pretty` for `--pretty=true`, so
 * the undeclared-flag check lets the token through. Matching only the bare spelling left
 * `--pretty=false` at a terminal accepted, ignored, and *indented* — the operator asked for compact and
 * got the opposite, which is the ambient surprise this whole feature exists to close. `asksForJson`
 * already reads `--json=false`, so mirroring that spelling onto `--pretty` is the expected path.
 *
 * A value that is neither `true` nor `false` is reported as `invalid` rather than guessed at, on the
 * same rule `PITHY_JSON` is held to.
 */
function readPretty(token: string): { pretty: boolean } | { invalid: true } | null {
  const equals = token.indexOf("=");
  const name = equals === -1 ? token : token.slice(0, equals);
  if (name !== PRETTY && name !== NO_PRETTY) return null;
  // The bare spelling means the flag's own polarity: `--pretty` on, `--no-pretty` off.
  const asserted = name === PRETTY;
  if (equals === -1) return { pretty: asserted };
  const value = token.slice(equals + 1);
  if (value !== "true" && value !== "false") return { invalid: true };
  // `--no-pretty=false` is a double negative and means pretty, which is what the parser would make of it.
  return { pretty: value === "true" ? asserted : !asserted };
}

/** The flag tokens of this invocation — everything before `--`, which is payload for a child process. */
function flagTokens(argv: readonly string[]): readonly string[] {
  const separator = argv.indexOf(PASSTHROUGH);
  return separator === -1 ? argv : argv.slice(0, separator);
}

/**
 * Whether this invocation asked for indented `--json`, on any command: `true` for `--pretty`, `false`
 * for `--no-pretty`, `undefined` when neither was typed and the ambient default should decide.
 *
 * Read off the raw tokens, like {@link wantsVersion} and `asksForJson`, because `bin.ts` answers this
 * before citty is handed the arguments — there is no parse yet to read it off, and the decision has to
 * be latched before the first byte a command writes.
 *
 * **Last wins.** A repeated flag resolves the way every parser resolves one, which is what lets a shell
 * alias carrying `--pretty` be overridden by `--no-pretty` typed after it.
 *
 * Both the bare and the `=true`/`=false` spellings count, for the reason in {@link readPretty}. A
 * malformed value is not an answer, so it is skipped here and refused by {@link malformedPrettyFlag}.
 * `--prettier`, a positional named `pretty`, and anything after `--` all pass through untouched.
 */
export function wantsPretty(argv: readonly string[]): boolean | undefined {
  let asked: boolean | undefined;
  for (const token of flagTokens(argv)) {
    const read = readPretty(token);
    if (read !== null && "pretty" in read) asked = read.pretty;
  }
  return asked;
}

/**
 * The first pretty flag carrying a value that is neither `true` nor `false`, as typed — or `undefined`.
 *
 * Refused rather than ignored, on the same rule as an unrecognized `PITHY_JSON`: a typo that reverts to
 * the ambient default is indistinguishable from the flag working, and that is the whole defect this
 * feature closes. `declaredFlags.ts` raises it; this only finds it, so the module stays dependency-free.
 */
export function malformedPrettyFlag(argv: readonly string[]): string | undefined {
  for (const token of flagTokens(argv)) {
    const read = readPretty(token);
    if (read !== null && "invalid" in read) return token;
  }
  return undefined;
}
