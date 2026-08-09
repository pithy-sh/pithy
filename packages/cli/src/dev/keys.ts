// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * Single-keypress input for the dev supervisor — the smallest thing that can turn `l` into an action.
 *
 * A key has to be read in **raw mode**, because line mode does not deliver a character until Enter, and
 * the whole point of `l` is that it is one keystroke. Raw mode is also the reason this module is
 * careful: it takes the terminal's own handling away, so Ctrl-C stops generating `SIGINT` and becomes a
 * `` byte like any other. A key reader that forgot that would leave `pithy dev` unstoppable.
 *
 * **Non-TTY never enters raw mode, and never listens.** CI, a piped `pithy dev`, and `pithy dev --json`
 * consumed by a script all land there. `setRawMode` on a non-TTY throws, and a `data` listener on stdin
 * keeps the process alive after every worker has exited — a supervisor that will not exit is a worse
 * bug than a keypress that is missing. So the reader answers `active: false` and does nothing at all.
 *
 * One binding is registered today. The shape takes a list so a second is one line, and deliberately
 * offers no default set: `r` to restart and `o` to open the app are obvious neighbours and neither is
 * this issue.
 */

/** The `` byte Ctrl-C becomes once raw mode has taken the terminal's own handling away. */
const ETX = "";

/** The slice of `process.stdin` a key reader uses — an interface so a test can assert what it did *not* do. */
export interface KeyStream {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => unknown;
  setEncoding: (encoding: string) => unknown;
  resume: () => unknown;
  pause: () => unknown;
  on: (event: "data", listener: (chunk: string) => void) => unknown;
  off: (event: "data", listener: (chunk: string) => void) => unknown;
}

/** One key, and what it does. `key` is a single character, compared literally. */
export interface KeyBinding {
  /** The character that triggers it. */
  key: string;
  /** What to do. May be async; a rejection goes to `onError`, never to an unhandled rejection. */
  run: () => void | Promise<void>;
}

/** A live key reader. `active` says whether anything is listening at all. */
export interface KeyReader {
  /** Whether raw mode was entered and bindings are live. `false` on every non-TTY. */
  active: boolean;
  /** Restore the terminal and stop listening. Idempotent — shutdown can be reached more than once. */
  stop: () => void;
}

/** Everything {@link readKeys} needs. `onInterrupt` is not optional: raw mode is what makes it necessary. */
export interface ReadKeysOptions {
  stdin?: KeyStream;
  bindings: readonly KeyBinding[];
  /** What Ctrl-C means now that the terminal no longer raises `SIGINT` for it. */
  onInterrupt: () => void;
  /** Where a binding's failure is reported. Without one a rejection is swallowed rather than thrown. */
  onError?: (error: unknown) => void;
}

/** A reader that never touched the terminal — what every non-TTY gets. */
const inert: KeyReader = { active: false, stop: () => {} };

/**
 * Start reading single keypresses, or answer that there is no terminal to read from.
 *
 * A chunk can carry more than one character (a paste, or a fast repeat), so each is dispatched in turn
 * rather than the chunk being compared as a whole.
 */
export function readKeys(options: ReadKeysOptions): KeyReader {
  const stdin = options.stdin ?? (process.stdin as unknown as KeyStream);
  const setRawMode = stdin.setRawMode;
  if (!stdin.isTTY || typeof setRawMode !== "function") return inert;

  const onError = options.onError ?? (() => {});
  const bindings = new Map(options.bindings.map((binding) => [binding.key, binding.run]));

  const onData = (chunk: string): void => {
    for (const character of chunk) {
      if (character === ETX) {
        options.onInterrupt();
        return;
      }
      const run = bindings.get(character);
      if (!run) continue;
      try {
        void Promise.resolve(run()).catch(onError);
      } catch (error) {
        onError(error);
      }
    }
  };

  setRawMode.call(stdin, true);
  stdin.setEncoding("utf8");
  stdin.resume();
  stdin.on("data", onData);

  let stopped = false;
  return {
    active: true,
    stop: () => {
      if (stopped) return;
      stopped = true;
      stdin.off("data", onData);
      setRawMode.call(stdin, false);
      stdin.pause();
    },
  };
}
