import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import { createLineSplitter, normalizeNewlines, stripAnsi, teeStream } from "./logging";

describe("text transforms", () => {
  test("stripAnsi removes color codes", () => {
    expect(stripAnsi("\x1b[34m[api]\x1b[0m ready")).toBe("[api] ready");
  });

  test("normalizeNewlines collapses CRLF and bare CR to LF", () => {
    expect(normalizeNewlines("a\r\nb\rc\n")).toBe("a\nb\nc\n");
  });
});

describe("createLineSplitter", () => {
  test("assembles lines across chunk boundaries and flushes the tail", () => {
    const lines: string[] = [];
    const splitter = createLineSplitter((l) => lines.push(l));
    splitter.push("hel");
    splitter.push("lo\nwor");
    splitter.push("ld\r\ntail");
    expect(lines).toEqual(["hello", "world"]);
    splitter.flush();
    expect(lines).toEqual(["hello", "world", "tail"]);
  });
});

describe("teeStream", () => {
  test("ANSI-strips and CR-normalizes the log tee, colorizes the terminal, feeds raw lines", async () => {
    const stream = new PassThrough();
    const terminal: string[] = [];
    const log: string[] = [];
    const raw: string[] = [];

    const done = teeStream({
      stream,
      label: "api",
      paint: (t) => `<c>${t}</c>`,
      sinks: {
        terminal: (l) => terminal.push(l),
        log: (l) => log.push(l),
        line: (l) => raw.push(l),
      },
    });

    stream.write("\x1b[34mReady on http://localhost\x1b[0m\r\n");
    stream.end();
    await done;

    expect(terminal).toEqual(["<c>[api]</c> \x1b[34mReady on http://localhost\x1b[0m"]);
    expect(log).toEqual(["[api] Ready on http://localhost"]);
    expect(raw).toEqual(["\x1b[34mReady on http://localhost\x1b[0m"]);
  });
});
