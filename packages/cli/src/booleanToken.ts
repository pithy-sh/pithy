// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * **How a boolean flag reads off the raw tokens, in one place (#697 review).**
 *
 * `bin.ts` answers `--json`, `--events`, `--pretty` and `--no-input` before citty parses, because each decides
 * something that has to be settled before a command writes its first byte. Four readers grew for them and they
 * disagreed: `--json --no-json` read as JSON in one and not in another, and `--no-events=true` was invisible to the
 * reader that refused `--events` without `--json`. Whenever the bin's reading and citty's differ, the run renders
 * in one shape while the command parsed another. So there is one reader, and it is citty's.
 *
 * **citty 0.2.2's rule, measured rather than assumed** (`booleanToken.test.ts` compares it against citty's own
 * `parseArgs` over every sequence of spellings):
 *
 * - Only tokens before `--` count. After it is a child's argv.
 * - A bare `--no-<name>` anywhere sets it `false`, whatever comes before or after. It is not last-wins.
 * - Otherwise the last `--<name>` or `--<name>=<value>` decides: bare is `true`, and a value is `true` unless it is
 *   exactly `false`. So `--json=maybe` is on.
 *
 * **One spelling is read where citty does not read it: `--no-<name>=true|false`.** citty ignores it (it negates a
 * flag literally named `<name>=true`), and `--no-pretty=false` has meant pretty since #672, for a flag citty never
 * parses at all. So it is read as the double negative it spells, among the last-wins tokens, and reported as
 * {@link BooleanToken.negatedValue}. A flag citty parses refuses that token, because read here and ignored there
 * would be exactly the disagreement this module exists to close.
 *
 * A value that is neither `true` nor `false`, on either spelling, is reported as {@link BooleanToken.malformed}, and
 * each flag decides whether to refuse it. Dependency-free, like `rootFlags.ts`, so both it and `declaredFlags.ts` can
 * import it.
 */

/** Everything after this separator is payload for a child process, never a Pithy flag. */
const PASSTHROUGH = "--";

/** What the raw tokens say about one boolean flag. */
export interface BooleanToken {
  /** The flag's value as the tokens set it, or `undefined` when nothing set it and its default decides. */
  readonly value: boolean | undefined;
  /** The first token whose `=value` is neither `true` nor `false`, as typed, or `undefined`. */
  readonly malformed: string | undefined;
  /** The first `--no-<name>=<value>` token, as typed — the spelling citty ignores — or `undefined`. */
  readonly negatedValue: string | undefined;
}

/** Read the boolean flag `name` (no dashes, e.g. `"json"`) off `argv`, as citty parses a declared boolean. */
export function readBooleanToken(argv: readonly string[], name: string): BooleanToken {
  const separator = argv.indexOf(PASSTHROUGH);
  const flags = separator === -1 ? argv : argv.slice(0, separator);
  const positive = `--${name}`;
  const negative = `--no-${name}`;
  let negated = false;
  let value: boolean | undefined;
  let malformed: string | undefined;
  let negatedValue: string | undefined;
  for (const token of flags) {
    if (token === negative) {
      negated = true;
    } else if (token === positive) {
      value = true;
    } else if (token.startsWith(`${positive}=`)) {
      const typed = token.slice(positive.length + 1);
      if (typed !== "true" && typed !== "false") malformed ??= token;
      value = typed !== "false";
    } else if (token.startsWith(`${negative}=`)) {
      const typed = token.slice(negative.length + 1);
      negatedValue ??= token;
      if (typed !== "true" && typed !== "false") malformed ??= token;
      else value = typed === "false";
    }
  }
  return { value: negated ? false : value, malformed, negatedValue };
}
