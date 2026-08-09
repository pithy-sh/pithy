// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { spawn } from "node:child_process";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";

/**
 * Open a URL in whatever browser the machine already prefers.
 *
 * **The default browser, and nothing cleverer.** No browser automation, no CDP, no launching a
 * controlled profile — because the thing being opened sets a cookie, and a cookie is only useful in the
 * browser the developer is actually looking at. Handing the OS a URL is also the only approach that
 * works from a second profile or an incognito window, which is precisely the case that made pasting a
 * cookie tedious in the first place.
 *
 * Detached and unref'd: the browser is not a child of the dev session. `pithy dev` exiting must not
 * close a window someone is reading, and a browser that stays open must not keep the supervisor alive.
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
 * Settles on `spawn` or `error` — the child started, or it never did — and **not** on anything about
 * what the browser then did. There is no signal for "a page rendered", and waiting for one would hang
 * the supervisor. A spawn failure (no `xdg-open` on a headless box, most often) becomes a refusal
 * carrying the URL, so the answer to "it did not open" is a line the developer can click.
 */
export function openUrl(url: string, options: OpenUrlOptions = {}): Promise<void> {
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
