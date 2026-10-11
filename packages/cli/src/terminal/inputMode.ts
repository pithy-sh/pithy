// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { ValidationError } from "@pithy-sh/core/src/error/pithyError";

/**
 * Whether this run may ask anybody anything, and the one place every command finds out (#697).
 *
 * **A TTY does not prove a person is present.** That is why `PITHY_JSON` exists (`jsonMode.ts`), and it
 * is truer of input than of output: an agent harness that allocates a PTY and runs without `--json`
 * reached a prompt and waited for an answer nobody would give. So the run can say so outright —
 * `PITHY_NONINTERACTIVE=1` for a session, `--no-input` for one call — and `--json` says it implicitly,
 * because a caller parsing one line is not reading a question.
 *
 * **Two halves, on purpose.** {@link resolveInputForbidden} is pure: `bin.ts` reads the environment and
 * the flags and hands them over, the way it does for `jsonStreams`, since `bin.ts` cannot be imported by
 * a test. The latch below holds only the answer, *forbidden or not*. Whether a terminal is attached is
 * still read when a command asks, never latched, so a suite that attaches a fake terminal in-process
 * gets prompts exactly as it did before this module existed.
 *
 * Every command reads {@link mayPrompt} (or one of its two narrower siblings) in place of its own
 * `process.stdin.isTTY` check. `ci/interactiveGate.test.ts` holds the rest of `src/` to that.
 */

/** The variable that forbids every prompt for a whole session. */
export const NONINTERACTIVE_ENV = "PITHY_NONINTERACTIVE";

/** Everything {@link resolveInputForbidden} decides from. Each is optional; absent means "did not say". */
export interface ResolveInputModeOptions {
  /** `PITHY_NONINTERACTIVE`, verbatim. Absent or empty is unset. */
  env?: string;
  /** `--no-input` (`true`) or `--no-input=false` (`false`). Absent when it was not typed. */
  noInput?: boolean;
  /** Whether the invocation asked for `--json`. */
  json?: boolean;
}

/**
 * Whether prompts are forbidden for this run. Any one of the three forbids them; none of them can
 * grant what another forbade, so `--no-input=false` under `PITHY_NONINTERACTIVE=1` still asks nothing.
 *
 * **A value other than `1` is refused, never guessed at**, on the rule `PITHY_JSON` is held to.
 * `PITHY_NONINTERACTIVE=true` quietly meaning "unset" would leave an agent waiting on the very prompt it
 * set the variable to prevent, and `=0` quietly meaning "allowed" invites a reader to think the variable
 * takes a polarity. It takes one value.
 */
export function resolveInputForbidden({ env, noInput, json }: ResolveInputModeOptions): boolean {
  if (env !== undefined && env !== "" && env !== "1") {
    throw new ValidationError({
      message: `${NONINTERACTIVE_ENV} is set to ${JSON.stringify(env)}, and it takes 1.`,
      action: `Set ${NONINTERACTIVE_ENV}=1 to forbid prompts, or unset it.`,
      issues: [{ path: [NONINTERACTIVE_ENV], code: "invalid_value", message: `${NONINTERACTIVE_ENV} takes 1.` }],
    });
  }
  return env === "1" || noInput === true || json === true;
}

/**
 * The latched answer. Unlatched is *not forbidden*, so a test importing a command, and anything that
 * reaches a prompt without going through the bin, behaves as it always did: the terminal decides.
 */
let forbidden = false;

/** Latch whether prompts are forbidden. `bin.ts` calls this once, before any command runs. */
export function latchInputMode(value: boolean): void {
  forbidden = value;
}

/** Whether this run has forbidden prompts — the latched bit alone, with no terminal in it. */
export function inputForbidden(): boolean {
  return forbidden;
}

/** A stream as far as this module cares: whether it is a terminal. */
export interface TtyStream {
  isTTY?: boolean;
}

/** The streams a prompt needs. Defaults to `process`'s, read at the moment of asking. */
export interface PromptStreams {
  stdin: TtyStream;
  stdout: TtyStream;
}

/**
 * Whether stdin may be read for input at all: nothing forbade it and it is a terminal. The narrowest
 * question, for a reader that asks nothing on any other stream — `pithy dev`'s renderer, deciding
 * whether to offer its keys, and the base of {@link mayPrompt}.
 */
export function stdinTakesInput(stdin: TtyStream = process.stdin): boolean {
  return !forbidden && Boolean(stdin.isTTY);
}

/**
 * Whether this run may open a prompt: nothing forbade it, the command is not answering `--json`, and a
 * terminal is attached on both ends a prompt uses — stdin for the answer, stdout for the question.
 *
 * `json` is still a parameter even though `--json` latches the bit too. A command handed `json` in a
 * test never passed through the bin, and the call site saying which run it is costs one argument.
 */
export function mayPrompt(json: boolean, streams: PromptStreams = process): boolean {
  return !json && stdinTakesInput(streams.stdin) && Boolean(streams.stdout.isTTY);
}

/**
 * Whether interactive UI may be drawn, with nothing said about stdin.
 *
 * `pithy secrets` asks two questions and keeps them apart (`capabilities/secretValue.ts`): whether a
 * prompt can be drawn, which is this, and whether a document is arriving on stdin, which is stdin's own
 * `isTTY` and stays with the reader. Folding stdin in here is what once made a redirected run look
 * like a terminal. Forbidding input does not turn a piped document off; it only means nobody is asked.
 */
export function mayDraw(json: boolean, stdout: TtyStream = process.stdout): boolean {
  return !forbidden && !json && Boolean(stdout.isTTY);
}

/** The streams a single-key offer needs. */
export interface KeyStreams {
  stdin: TtyStream;
  stderr: TtyStream;
}

/**
 * Whether a single-key offer may be made — the dashboard's `o` to open a browser, `pithy dev`'s keys.
 * Stdin for the key, stderr for the line that offers it, which is where those announcements go.
 */
export function mayReadKeys(json: boolean, streams: KeyStreams = process): boolean {
  return !json && stdinTakesInput(streams.stdin) && Boolean(streams.stderr.isTTY);
}
