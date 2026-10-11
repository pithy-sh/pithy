// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { EventEmitter } from "node:events";
import { describe, expect, test } from "vitest";
import { BROKEN_PIPE, exitQuietlyOnBrokenPipe } from "./brokenPipe";
import { EXIT } from "./exitClass";

/** An error as a stream raises it: an `Error` with an errno `code`. */
function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`write ${code}`), { code });
}

describe("exitQuietlyOnBrokenPipe", () => {
  test("EPIPE exits 141, the code SIGPIPE would leave", () => {
    const stream = new EventEmitter();
    const exits: number[] = [];
    exitQuietlyOnBrokenPipe(stream, (code) => {
      exits.push(code);
    });
    stream.emit("error", errno("EPIPE"));
    expect(exits).toEqual([141]);
  });

  test("any other stream error is not swallowed", () => {
    const stream = new EventEmitter();
    exitQuietlyOnBrokenPipe(stream, () => {});
    expect(() => stream.emit("error", errno("EIO"))).toThrow("write EIO");
  });

  test("is the code the exit table publishes", () => {
    expect(BROKEN_PIPE).toBe(128 + 13);
    expect(EXIT.brokenPipe).toBe(BROKEN_PIPE);
  });
});
