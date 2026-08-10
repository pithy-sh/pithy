// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { type KeyStream, readKeys } from "./keys";

/** A stdin double that records every mode change, so "never entered raw mode" is an assertion. */
function fakeStdin(isTTY: boolean): KeyStream & { rawModes: boolean[]; listeners: number; resumed: number } {
  const listeners: ((chunk: string) => void)[] = [];
  const stream = {
    isTTY,
    rawModes: [] as boolean[],
    resumed: 0,
    get listeners() {
      return listeners.length;
    },
    setRawMode(mode: boolean) {
      stream.rawModes.push(mode);
    },
    setEncoding() {},
    resume() {
      stream.resumed += 1;
    },
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
  return stream as unknown as KeyStream & { rawModes: boolean[]; listeners: number; resumed: number } & {
    send: (chunk: string) => void;
  };
}

describe("a terminal", () => {
  test("runs the binding for its key and ignores every other one", async () => {
    const pressed: string[] = [];
    const stdin = fakeStdin(true);
    const reader = readKeys({
      stdin,
      bindings: [{ key: "l", run: () => void pressed.push("l") }],
      onInterrupt: () => void pressed.push("interrupt"),
    });

    (stdin as unknown as { send: (c: string) => void }).send("l");
    (stdin as unknown as { send: (c: string) => void }).send("q");
    await Promise.resolve();

    expect(reader.active).toBe(true);
    expect(pressed).toEqual(["l"]);
    reader.stop();
  });

  test("enters raw mode and leaves it again on stop", () => {
    const stdin = fakeStdin(true);
    const reader = readKeys({ stdin, bindings: [], onInterrupt: () => {} });
    expect(stdin.rawModes).toEqual([true]);
    expect(stdin.listeners).toBe(1);

    reader.stop();
    expect(stdin.rawModes).toEqual([true, false]);
    expect(stdin.listeners).toBe(0);

    // Idempotent: the orchestrator stops on shutdown, and shutdown can be reached twice.
    reader.stop();
    expect(stdin.rawModes).toEqual([true, false]);
  });

  test("Ctrl-C still interrupts — raw mode is what takes that away", () => {
    const interrupts: number[] = [];
    const stdin = fakeStdin(true);
    readKeys({ stdin, bindings: [], onInterrupt: () => void interrupts.push(1) });

    (stdin as unknown as { send: (c: string) => void }).send("\x03");

    expect(interrupts).toEqual([1]);
  });

  test("a paste of several characters runs each binding it names, in order", () => {
    const pressed: string[] = [];
    const stdin = fakeStdin(true);
    readKeys({
      stdin,
      bindings: [
        { key: "l", run: () => void pressed.push("l") },
        { key: "r", run: () => void pressed.push("r") },
      ],
      onInterrupt: () => {},
    });

    (stdin as unknown as { send: (c: string) => void }).send("lxr");

    expect(pressed).toEqual(["l", "r"]);
  });

  test("a binding that throws is reported, not left to crash the supervisor", async () => {
    const errors: unknown[] = [];
    const stdin = fakeStdin(true);
    readKeys({
      stdin,
      bindings: [{ key: "l", run: () => Promise.reject(new Error("no browser")) }],
      onInterrupt: () => {},
      onError: (error) => void errors.push(error),
    });

    (stdin as unknown as { send: (c: string) => void }).send("l");
    await Promise.resolve();
    await Promise.resolve();

    expect(errors).toHaveLength(1);
  });
});

describe("no terminal", () => {
  test("never enters raw mode, never listens, and never waits for input", () => {
    const stdin = fakeStdin(false);
    const reader = readKeys({ stdin, bindings: [{ key: "l", run: () => {} }], onInterrupt: () => {} });

    // CI and a piped `pithy dev` land here. Raw mode on a non-TTY throws; a listener on stdin would hold
    // the process open after every worker had exited.
    expect(reader.active).toBe(false);
    expect(stdin.rawModes).toEqual([]);
    expect(stdin.listeners).toBe(0);
    expect(stdin.resumed).toBe(0);
    reader.stop();
  });

  test("a stream with no setRawMode at all is treated as no terminal", () => {
    const bare = { isTTY: true, resume() {}, pause() {}, setEncoding() {}, on() {}, off() {} };
    const reader = readKeys({
      stdin: bare as unknown as KeyStream,
      bindings: [],
      onInterrupt: () => {},
    });
    expect(reader.active).toBe(false);
  });
});
