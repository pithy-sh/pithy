// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { spawn } from "node:child_process";
import { InternalError, messageOf, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { type KeyReader, readKeys as readKeysDefault } from "../terminal/keys";

/**
 * Open a URL in whatever browser the machine already prefers, and the one way the CLI offers to.
 *
 * **The default browser, and nothing cleverer.** No browser automation, no CDP, no launching a
 * controlled profile — because the thing being opened sets a cookie, and a cookie is only useful in the
 * browser the developer is actually looking at. Handing the OS a URL is also the only approach that
 * works from a second profile or an incognito window, which is precisely the case that made pasting a
 * cookie tedious in the first place.
 *
 * Detached and unref'd: the browser is not a child of the command. `pithy dev` exiting must not close a
 * window someone is reading, and a browser that stays open must not keep the supervisor alive.
 *
 * **This lives in `platform/` because the machine outside this process is what it talks to** — beside
 * `editor.ts`, which spawns `$EDITOR`. It spent its first life under `dev/`, which is why
 * `pithy dashboard` could not reach it and a second opener was nearly written (#607). One opener, and
 * `ci/opener.test.ts` says so.
 *
 * **http and https, and nothing else.** {@link openUrl} refuses every other scheme before it spawns
 * anything. That is a trust boundary rather than a nicety: a `verificationUri` arrives over the wire
 * from whatever origin `--origin` pointed at, and `file:`, `javascript:` and `vscode:` all satisfy a
 * bare `z.url()`. Handing one of those to the platform opener hands an untrusted string to the desktop.
 */

/** The spawn seam — narrow to what this module drives, so a test asserts the argv rather than a browser. */
export type OpenSpawn = (command: string, args: string[], options: { detached: boolean; stdio: "ignore" }) => OpenChild;

/** The two events that settle an open: the child started, or it never did. */
export interface OpenChild {
  once: (event: "spawn" | "error", listener: (error: Error) => void) => unknown;
  unref: () => unknown;
}

/** Everything {@link openUrl} needs. Both default to the real platform and the real `spawn`. */
export interface OpenUrlOptions {
  platform?: NodeJS.Platform;
  spawn?: OpenSpawn;
}

/** Whether this is an address a browser should be handed. Unparseable is not, and nor is any other scheme. */
function isWebAddress(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * The opener for one platform. macOS and Windows ship their own; everything else is `xdg-open`, which
 * is the freedesktop standard and present on any Linux with a desktop session.
 *
 * The empty string on Windows is not noise: `start` reads its first quoted argument as the *window
 * title*, so a URL passed without it is consumed as a title and nothing opens.
 */
export function openCommand(url: string, platform: NodeJS.Platform): { command: string; args: string[] } {
  if (platform === "darwin") return { command: "open", args: [url] };
  if (platform === "win32") return { command: "cmd", args: ["/c", "start", "", url] };
  return { command: "xdg-open", args: [url] };
}

/**
 * Hand the URL to the platform opener.
 *
 * **Argv, never a shell.** {@link openCommand} returns a command and an array, and that array is what is
 * spawned. Nothing here interpolates a URL into a command string.
 *
 * Settles on `spawn` or `error` — the child started, or it never did — and **not** on anything about
 * what the browser then did. There is no signal for "a page rendered", and waiting for one would hang
 * the caller. A spawn failure (no `xdg-open` on a headless box, most often) becomes a refusal
 * carrying the URL, so the answer to "it did not open" is a line the developer can click.
 */
export function openUrl(url: string, options: OpenUrlOptions = {}): Promise<void> {
  if (!isWebAddress(url)) {
    return Promise.reject(
      new ValidationError({
        message: "That link isn't a web address.",
        action: "Only http and https links are opened.",
        detail: `refused to open ${url}`,
      }),
    );
  }

  const platform = options.platform ?? process.platform;
  const spawnChild = options.spawn ?? ((command, args, opts) => spawn(command, args, opts));
  const { command, args } = openCommand(url, platform);

  return new Promise<void>((resolve, reject) => {
    const child = spawnChild(command, args, { detached: true, stdio: "ignore" });
    child.once("spawn", () => resolve());
    child.once("error", (error) => {
      reject(
        new InternalError({
          message: "Could not open a browser.",
          action: `Open ${url} yourself.`,
          detail: `${command} failed: ${error.message}`,
        }),
      );
    });
    child.unref();
  });
}

/** The four terms that decide whether an open is offered at all. Every one must be clear. */
export interface OpeningIsOfferedInput {
  /** `--json`. A machine-readable run has a caller that parses one line, and a key is not it. */
  json: boolean;
  /** Whether both ends of the terminal are real. The command's own interactive gate answers this. */
  isTTY: boolean;
  /** `--no-open`, already read off the command's args. */
  noOpen: boolean;
  /** The environment: `PITHY_NO_OPEN` at any value suppresses, as `PITHY_NO_UPDATE_NOTIFIER` does. */
  env: NodeJS.ProcessEnv;
}

/**
 * Whether the CLI may offer to open a link. Every rule must hold, and each suppresses **the offer line
 * as well as the open** — a stated key nobody can press is worse than no line at all.
 *
 * Modeled on `notifier/notify.ts`'s `shouldNotify`, for the same reason: suppression written as one
 * function is suppression a second command inherits rather than re-derives.
 */
export function openingIsOffered(input: OpeningIsOfferedInput): boolean {
  if (input.json) return false;
  if (!input.isTTY) return false;
  if (input.noOpen) return false;
  if (input.env.PITHY_NO_OPEN) return false;
  return true;
}

/** The key. Stated, never prompted for — `pithy dev`'s `l` is the precedent and the reason. */
const OPEN_KEY = "o";

/**
 * The sentence. One constant, so no command writes a second phrasing of the same offer.
 *
 * **A stated key, not a prompt.** A blocking yes/no confirm cannot work here: `pithy dashboard connect`
 * is already polling for an approval and has to finish whether or not anybody touches the keyboard.
 */
export const OPEN_PROMPT = "Press o to open the link in the browser.";

/** Everything {@link offerToOpen} needs. Only `url` and `write` are the caller's own. */
export interface OfferToOpenOptions {
  /** What to open. Refused, silently and offerlessly, if it is not http(s). */
  url: string;
  /** Where the offer line and any failure go — stderr in `dashboard`, the log line in `dev`. */
  write: (line: string) => void;
  /** The key reader seam. Defaults to the real one over `process.stdin`. */
  readKeys?: typeof readKeysDefault;
  /** The opener seam. Defaults to {@link openUrl}. */
  openUrl?: (url: string) => Promise<void>;
  /** What Ctrl-C means once the terminal no longer raises it. Default: re-raise `SIGINT` on this process. */
  onInterrupt?: () => void;
}

/** A live offer. */
export interface OpenOffer {
  /** True only if raw mode was entered and the key is live. False means nothing was written either. */
  offered: boolean;
  /** Restore the terminal, stop listening, drop the exit hook. Idempotent. */
  stop: () => void;
}

/** An offer that never touched the terminal — what a non-TTY and a refused URL both get. */
const INERT: OpenOffer = { offered: false, stop: () => {} };

/** A reader that is not listening yet. Held so `stop` can be defined before the reader exists. */
const NOT_LISTENING: KeyReader = { active: false, stop: () => {} };

/**
 * State the key, listen for it, and get out of the way.
 *
 * **Non-blocking.** It returns immediately, never awaits a keypress and never resolves on one. The
 * caller keeps working — polling, waiting, printing — and calls `stop()` in a `finally`.
 *
 * **Raw mode is restored on every exit path, and that is this function's job rather than the caller's.**
 * Three of them: `stop()` from the caller's `finally`, which covers a normal return *and* a throw; a
 * `process.once("exit")` hook, the backstop for `bin.ts`'s error reporter calling `process.exit`; and
 * Ctrl-C, which raw mode has turned into a `\x03` byte, so the terminal is given back and the signal
 * re-raised by hand. A command that skipped the last one would be unkillable from the keyboard.
 *
 * **A failed open is one line, never the caller's failure.** Nothing thrown by the opener propagates:
 * a connect that was waiting for an approval must not die because a headless box has no `xdg-open`.
 * Nor does a terminal that refuses raw mode: `setRawMode` throws on a stream that only looks like a TTY,
 * and a sign-in must not fail because a convenience could not be offered.
 */
export function offerToOpen(options: OfferToOpenOptions): OpenOffer {
  if (!isWebAddress(options.url)) return INERT;

  const read = options.readKeys ?? readKeysDefault;
  const open = options.openUrl ?? ((url: string) => openUrl(url));
  const interrupt = options.onInterrupt ?? (() => void process.kill(process.pid, "SIGINT"));

  let reader: KeyReader = NOT_LISTENING;
  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    process.off("exit", stop);
    reader.stop();
  };

  try {
    reader = read({
      bindings: [
        {
          key: OPEN_KEY,
          run: async () => {
            try {
              await open(options.url);
            } catch (error) {
              options.write(messageOf(error));
            }
          },
        },
      ],
      onInterrupt: () => {
        stop();
        interrupt();
      },
      onError: (error) => options.write(messageOf(error)),
    });
  } catch {
    return INERT;
  }
  if (!reader.active) return INERT;

  process.once("exit", stop);
  options.write(OPEN_PROMPT);
  return { offered: true, stop };
}
