// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { ValidationError } from "@pithy-sh/core/src/error/pithyError";

/**
 * Who the `--json` line is being formatted for, and how that is decided.
 *
 * `--json` has always emitted one compact line, which is right for the reader it was designed for and
 * wrong for the person who typed it. This module is the rule that tells them apart — the same three-step
 * shape `style.ts` already uses for color (an explicit override, a forcing override, then the ambient
 * default), because it is the same shape of question.
 *
 * **Pure, and it takes every input as a parameter.** `process` does not appear: `bin.ts` reads the
 * environment, the flags and each stream's `isTTY` and hands them over, the way `notify.ts`'s
 * `shouldNotify` takes `isTTY` rather than reaching for it. That is what lets the whole matrix be asked
 * in a test runner, which has no terminal and would otherwise only ever exercise one row of it.
 */

/** Compact is one line; pretty is two-space indented. Nothing else is a mode. */
export type JsonMode = "compact" | "pretty";

/** The environment variable that overrides both the flag and the terminal, for a whole session. */
export const JSON_MODE_ENV = "PITHY_JSON";

/** Everything {@link resolveJsonMode} decides from. Each is optional; absent means "did not say". */
export interface ResolveJsonModeOptions {
  /** `PITHY_JSON`, verbatim. Absent or empty is unset. */
  env?: string;
  /** `--pretty` (`true`) or `--no-pretty` (`false`). Absent when neither was typed. */
  pretty?: boolean;
  /** Whether the stream being written to is an interactive terminal. */
  isTTY?: boolean;
}

/**
 * The mode one stream's reader gets. First match wins:
 *
 * 1. `PITHY_JSON` — the session override.
 * 2. `--pretty` / `--no-pretty` — the explicit flag.
 * 3. `isTTY` — the ambient default.
 *
 * **The variable is first because a TTY is not a reliable "a person is reading this" signal.** Agent
 * harnesses, tmux-backed runners and some CI images allocate a PTY, and every one of them would start
 * receiving multi-line JSON with no way to stop it short of rewriting each invocation. One variable
 * settles it for the session.
 *
 * **An unrecognized value is refused, never ignored.** `PITHY_JSON=prety` quietly reverting to the
 * ambient default is exactly the surprise this feature exists to close, and it would be indistinguishable
 * from the variable working. A `ValidationError`, so it reaches the operator through `withErrorReporting`
 * as the problem/action lines or, under `--json`, as the one `{ "error": … }` line.
 */
export function resolveJsonMode({ env, pretty, isTTY }: ResolveJsonModeOptions): JsonMode {
  if (env !== undefined && env !== "") {
    if (env === "compact" || env === "pretty") return env;
    throw new ValidationError({
      message: `${JSON_MODE_ENV} is set to ${JSON.stringify(env)}, which is not a JSON output mode.`,
      action: `Set ${JSON_MODE_ENV} to compact or pretty, or unset it and let --pretty and the terminal decide.`,
      issues: [
        {
          path: [JSON_MODE_ENV],
          code: "invalid_value",
          message: `${JSON_MODE_ENV} takes compact or pretty.`,
        },
      ],
    });
  }
  if (pretty !== undefined) return pretty ? "pretty" : "compact";
  return isTTY === true ? "pretty" : "compact";
}

/** One stream's answer: how to shape the document, and whether to paint it. */
export interface JsonStream {
  mode: JsonMode;
  /** Whether this stream takes syntax color. Always false for a stream that is not a terminal. */
  color: boolean;
}

/** Whether each stream is a terminal, plus the inputs that apply to both. */
export interface JsonStreamsOptions extends Omit<ResolveJsonModeOptions, "isTTY"> {
  /** `colorEnabled()` — the `style.ts` seam's latched answer. */
  color?: boolean;
  /** `colorForced()` — whether that answer came from `FORCE_COLOR` rather than from a TTY. */
  forced?: boolean;
  /** `process.stdout.isTTY`. */
  stdout?: boolean;
  /** `process.stderr.isTTY`. */
  stderr?: boolean;
}

/**
 * How to write each stream — because each stream has its own reader.
 *
 * `pithy doctor --json > out.json` at a terminal is the case that forced the split: the file wants the
 * parseable line, the screen wants the readable one, and a single answer has to disappoint one of them.
 * The variable and the flag are the operator speaking about the run, so they apply to both; only the
 * ambient default is per-stream, which is precisely the part that was reading the wrong stream.
 *
 * **Color is split for a sharper reason than the mode is.** An indent in a captured document still
 * parses; an escape sequence does not. The seam latches on stdout alone, so
 * `pithy … --json --pretty 2> err.txt` at a terminal had `colorEnabled()` true while stderr was a file,
 * and painted a `{ "error": … }` line straight into it — unparseable, silently (#666). So a stream is
 * painted only when the seam says yes **and** the bytes are going to a screen.
 *
 * **`FORCE_COLOR` still overrides that**, which is what forcing means: an operator capturing colored
 * output has said so, and this is not the place to second-guess them. That is the whole reason `forced`
 * is a separate input rather than being folded into `color`.
 */
export function jsonStreams({ env, pretty, color, forced, stdout, stderr }: JsonStreamsOptions): {
  stdout: JsonStream;
  stderr: JsonStream;
} {
  const paints = (isTTY: boolean | undefined): boolean => color === true && (forced === true || isTTY === true);
  return {
    stdout: { mode: resolveJsonMode({ env, pretty, isTTY: stdout }), color: paints(stdout) },
    stderr: { mode: resolveJsonMode({ env, pretty, isTTY: stderr }), color: paints(stderr) },
  };
}
