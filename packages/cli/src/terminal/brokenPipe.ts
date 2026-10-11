// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * **A reader that closes the pipe early ends the run quietly (#697).**
 *
 * `pithy schema --json | head` printed an unhandled `EPIPE` stack trace, under Node and under Bun: the write
 * that found the pipe shut raised an `error` event on the stream, and nothing listened. The reader took what
 * it wanted, so there is nothing to report and nobody left to report it to.
 *
 * **Exit 141, as `SIGPIPE` would have left it** (128 + 13), on the precedent of 130 for an interrupt that
 * arrived as something other than a signal (`exitClass.ts`). Node ignores `SIGPIPE`, so a write sees the
 * error instead of the process dying of it — this is the exit a shell would otherwise have reported. Not 0:
 * the output was cut short, and `set -o pipefail` should say so, as it does for any other program.
 *
 * Dependency-free on purpose: `bin.ts` installs it before anything else is imported.
 */

/** The exit a broken pipe ends the run with: `SIGPIPE`'s, 128 + 13. `docs/CLI.md` §3.8. */
export const BROKEN_PIPE = 141;

/** The part of a stream this listens to. */
export interface ErrorEmitter {
  on(event: "error", listener: (error: NodeJS.ErrnoException) => void): unknown;
}

/**
 * Exit {@link BROKEN_PIPE}, silently, when `stream` reports `EPIPE`. Any other error is thrown, exactly as an
 * unheard `error` event would have been: a disk that failed under a redirect is a fault, not a reader that
 * stopped.
 */
export function exitQuietlyOnBrokenPipe(
  stream: ErrorEmitter,
  exit: (code: number) => void = (code) => process.exit(code),
): void {
  stream.on("error", (error) => {
    if (error.code === "EPIPE") {
      exit(BROKEN_PIPE);
      return;
    }
    throw error;
  });
}
