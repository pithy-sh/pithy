// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import type { KeyStream, ReadKeysOptions } from "../terminal/keys";
import { readKeys } from "../terminal/keys";
import { OPEN_PROMPT, offerToOpen, openCommand, openingIsOffered, openUrl } from "./browser";

const URL = "http://localhost:8787/__pithy/dev-login";

/** A spawn that never starts anything, so "nothing was spawned" is an assertion rather than a hope. */
function countingSpawn(): { calls: number; spawn: NonNullable<Parameters<typeof openUrl>[1]>["spawn"] } {
  const state = { calls: 0 };
  return {
    get calls() {
      return state.calls;
    },
    spawn: () => {
      state.calls += 1;
      return {
        once: (event: "spawn" | "error", listener: (error: Error) => void) => {
          if (event === "spawn") queueMicrotask(() => listener(new Error("unused")));
        },
        unref: () => {},
      };
    },
  };
}

/** A stdin double that records every mode change — the same shape `terminal/keys.test.ts` drives. */
function fakeStdin(isTTY: boolean): KeyStream & { rawModes: boolean[]; listeners: number; send: (c: string) => void } {
  const listeners: ((chunk: string) => void)[] = [];
  const stream = {
    isTTY,
    rawModes: [] as boolean[],
    get listeners() {
      return listeners.length;
    },
    setRawMode(mode: boolean) {
      stream.rawModes.push(mode);
    },
    setEncoding() {},
    resume() {},
    pause() {},
    on(_event: "data", listener: (chunk: string) => void) {
      listeners.push(listener);
    },
    off(_event: "data", listener: (chunk: string) => void) {
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
    },
    send(chunk: string) {
      for (const listener of [...listeners]) listener(chunk);
    },
  };
  return stream as unknown as KeyStream & { rawModes: boolean[]; listeners: number; send: (c: string) => void };
}

/** The real reader over a fake terminal — so raw mode is exercised rather than stubbed out. */
function over(stdin: KeyStream): (options: ReadKeysOptions) => ReturnType<typeof readKeys> {
  return (options) => readKeys({ ...options, stdin });
}

/** Every suppressor clear: the one combination that offers. */
const CLEAR = { json: false, isTTY: true, noOpen: false, env: {} as NodeJS.ProcessEnv };

describe("openCommand", () => {
  test("uses each platform's own opener, and hands the URL over as one argument", () => {
    expect(openCommand(URL, "darwin")).toEqual({ command: "open", args: [URL] });
    expect(openCommand(URL, "win32")).toEqual({ command: "cmd", args: ["/c", "start", "", URL] });
    expect(openCommand(URL, "linux")).toEqual({ command: "xdg-open", args: [URL] });
    expect(openCommand(URL, "freebsd")).toEqual({ command: "xdg-open", args: [URL] });
  });
});

describe("openUrl", () => {
  test("spawns the platform opener detached, so the browser outlives pithy dev", async () => {
    const calls: { command: string; args: string[]; detached: boolean }[] = [];
    await openUrl(URL, {
      platform: "linux",
      spawn: (command, args, options) => {
        calls.push({ command, args, detached: options.detached });
        return {
          once: (event: "spawn" | "error", listener: (error: Error) => void) => {
            if (event === "spawn") queueMicrotask(() => listener(new Error("unused")));
          },
          unref: () => {},
        };
      },
    });
    expect(calls).toEqual([{ command: "xdg-open", args: [URL], detached: true }]);
  });

  test("a missing opener is an actionable refusal carrying the URL to open by hand", async () => {
    const failure = openUrl(URL, {
      platform: "linux",
      spawn: () => ({
        once: (event: "spawn" | "error", listener: (error: Error) => void) => {
          if (event === "error") queueMicrotask(() => listener(new Error("spawn xdg-open ENOENT")));
        },
        unref: () => {},
      }),
    });

    const error: unknown = await failure.then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    if (!(error instanceof PithyError)) throw new Error("expected a PithyError");
    expect(error.payload.message).toContain("Could not open a browser");
    expect(error.payload.action).toContain(URL);
  });

  /**
   * The trust boundary. `verificationUri` comes back over the wire from an origin `--origin` pointed at,
   * and `javascript:`, `file:` and `vscode:` all satisfy a bare `z.url()`. Handing one of those to the
   * platform opener is handing an untrusted string to the desktop.
   */
  test.each(["javascript:alert(1)", "file:///etc/passwd", "vscode://file/etc/passwd", "not a url at all", ""])(
    "refuses %j before it spawns anything",
    async (hostile) => {
      const spawn = countingSpawn();
      const error: unknown = await openUrl(hostile, { platform: "linux", spawn: spawn.spawn }).then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
      expect(error).toBeInstanceOf(PithyError);
      expect(spawn.calls).toBe(0);
    },
  );

  test("https is opened like http — both, so the refusal is about the scheme and not about TLS", async () => {
    const spawn = countingSpawn();
    await openUrl("https://app.pithy.sh/cli", { platform: "linux", spawn: spawn.spawn });
    expect(spawn.calls).toBe(1);
  });
});

describe("openingIsOffered", () => {
  test("offers only when every one of the four is clear", () => {
    expect(openingIsOffered(CLEAR)).toBe(true);
  });

  test("--json suppresses it — a machine-readable run has a caller, not a reader", () => {
    expect(openingIsOffered({ ...CLEAR, json: true })).toBe(false);
  });

  test("no terminal suppresses it — a key nobody can press is a line nobody can act on", () => {
    expect(openingIsOffered({ ...CLEAR, isTTY: false })).toBe(false);
  });

  test("--no-open suppresses it", () => {
    expect(openingIsOffered({ ...CLEAR, noOpen: true })).toBe(false);
  });

  test("PITHY_NO_OPEN suppresses it, at any value", () => {
    expect(openingIsOffered({ ...CLEAR, env: { PITHY_NO_OPEN: "1" } })).toBe(false);
    expect(openingIsOffered({ ...CLEAR, env: { PITHY_NO_OPEN: "no" } })).toBe(false);
    expect(openingIsOffered({ ...CLEAR, env: { PITHY_NO_OPEN: "" } })).toBe(true);
  });
});

describe("offerToOpen", () => {
  test("states the key, and opens the URL when it is pressed", async () => {
    const lines: string[] = [];
    const opened: string[] = [];
    const stdin = fakeStdin(true);
    const offer = offerToOpen({
      url: URL,
      write: (line) => void lines.push(line),
      readKeys: over(stdin),
      openUrl: async (url) => void opened.push(url),
    });

    expect(offer.offered).toBe(true);
    expect(lines).toEqual([OPEN_PROMPT]);
    expect(OPEN_PROMPT).toBe("Press o to open the link in the browser.");

    stdin.send("o");
    await Promise.resolve();
    expect(opened).toEqual([URL]);
    offer.stop();
  });

  test("returns at once — it never waits for the key", () => {
    const stdin = fakeStdin(true);
    const before = Date.now();
    const offer = offerToOpen({ url: URL, write: () => {}, readKeys: over(stdin), openUrl: async () => {} });
    expect(Date.now() - before).toBeLessThan(200);
    expect(offer.offered).toBe(true);
    offer.stop();
  });

  test("a non-TTY gets no offer and no line at all", () => {
    const lines: string[] = [];
    const stdin = fakeStdin(false);
    const offer = offerToOpen({ url: URL, write: (line) => void lines.push(line), readKeys: over(stdin) });

    expect(offer.offered).toBe(false);
    expect(lines).toEqual([]);
    expect(stdin.rawModes).toEqual([]);
    offer.stop();
  });

  test("a stream with no setRawMode at all gets no offer", () => {
    const bare = { isTTY: true, resume() {}, pause() {}, setEncoding() {}, on() {}, off() {} };
    const offer = offerToOpen({
      url: URL,
      write: () => {},
      readKeys: over(bare as unknown as KeyStream),
    });
    expect(offer.offered).toBe(false);
  });

  test("a terminal that refuses raw mode gets no offer, and no throw", () => {
    // `setRawMode` throws on a stream that only looks like a TTY. A sign-in must not fail because a
    // convenience could not be offered.
    const hostile = fakeStdin(true);
    (hostile as unknown as { setRawMode: () => void }).setRawMode = () => {
      throw new Error("ENOTTY");
    };
    const lines: string[] = [];
    const offer = offerToOpen({ url: URL, write: (line) => void lines.push(line), readKeys: over(hostile) });

    expect(offer.offered).toBe(false);
    expect(lines).toEqual([]);
    offer.stop();
  });

  test("a URL that is not http(s) produces no offer, so no key fails when it is pressed", () => {
    const lines: string[] = [];
    const stdin = fakeStdin(true);
    const offer = offerToOpen({
      url: "javascript:alert(1)",
      write: (line) => void lines.push(line),
      readKeys: over(stdin),
    });

    expect(offer.offered).toBe(false);
    expect(lines).toEqual([]);
    expect(stdin.rawModes).toEqual([]);
  });

  test("stop restores the terminal, is idempotent, and drops its exit hook", () => {
    const stdin = fakeStdin(true);
    const hooks = process.listenerCount("exit");
    const offer = offerToOpen({ url: URL, write: () => {}, readKeys: over(stdin), openUrl: async () => {} });

    expect(stdin.rawModes).toEqual([true]);
    expect(process.listenerCount("exit")).toBe(hooks + 1);

    offer.stop();
    expect(stdin.rawModes).toEqual([true, false]);
    expect(stdin.listeners).toBe(0);
    expect(process.listenerCount("exit")).toBe(hooks);

    offer.stop();
    expect(stdin.rawModes).toEqual([true, false]);
    expect(process.listenerCount("exit")).toBe(hooks);
  });

  test("a caller that throws still gives the terminal back, through its own finally", () => {
    const stdin = fakeStdin(true);
    const offer = offerToOpen({ url: URL, write: () => {}, readKeys: over(stdin), openUrl: async () => {} });

    expect(() => {
      try {
        throw new Error("the poll expired");
      } finally {
        offer.stop();
      }
    }).toThrow("the poll expired");
    expect(stdin.rawModes).toEqual([true, false]);
  });

  test("Ctrl-C gives the terminal back and then re-raises — raw mode is what takes that away", () => {
    const interrupts: boolean[] = [];
    const stdin = fakeStdin(true);
    const offer = offerToOpen({
      url: URL,
      write: () => {},
      readKeys: over(stdin),
      openUrl: async () => {},
      // The terminal must already be restored when this runs: it is the last thing before the signal.
      onInterrupt: () => void interrupts.push(stdin.rawModes.at(-1) === false),
    });

    stdin.send("\x03");
    expect(interrupts).toEqual([true]);
    offer.stop();
  });

  test("an opener that fails is one line, and never the caller's failure", async () => {
    const lines: string[] = [];
    const stdin = fakeStdin(true);
    const offer = offerToOpen({
      url: URL,
      write: (line) => void lines.push(line),
      readKeys: over(stdin),
      openUrl: () => Promise.reject(new Error("spawn xdg-open ENOENT")),
    });

    stdin.send("o");
    await Promise.resolve();
    await Promise.resolve();

    expect(lines).toEqual([OPEN_PROMPT, "spawn xdg-open ENOENT"]);
    offer.stop();
  });
});
