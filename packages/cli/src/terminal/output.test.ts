// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { HttpError } from "@pithy-sh/core/src/error/http";
import { ConflictError, InternalError, NotFoundError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  formatDone,
  formatError,
  formatErrorJson,
  formatJsonLine,
  formatJsonStreamLine,
  formatList,
  latchJsonFormat,
  withErrorReporting,
} from "./output";

describe("formatDone", () => {
  test("is exactly Done. — the period is the brand", () => {
    // Non-TTY test env: saffron degrades to plain text.
    expect(formatDone()).toBe("Done.");
  });
});

describe("formatJsonLine", () => {
  test("one machine-readable line", () => {
    expect(formatJsonLine({ command: "init", appName: "x" })).toBe('{"command":"init","appName":"x"}');
  });
});

/**
 * **Latched once, so no `formatJsonLine` call site gains a parameter.** `bin.ts` decides
 * both modes from the environment, the flags and each stream's `isTTY`, then sets them here — the way
 * `style.ts` latches color at import, the difference being an explicit setter because argv is not
 * available at import time.
 *
 * **Unlatched stays compact.** A test importing this module directly, and anything that reaches a
 * formatter without going through the bin, gets the byte-identical line it always got.
 */
const COMPACT = {
  stdout: { mode: "compact", color: false },
  stderr: { mode: "compact", color: false },
} as const;

describe("latchJsonFormat", () => {
  afterEach(() => {
    latchJsonFormat(COMPACT);
  });

  test("unlatched, both formatters emit one compact line", () => {
    expect(formatJsonLine({ a: 1 })).toBe('{"a":1}');
    expect(formatErrorJson(new ConflictError({ message: "Taken." }).payload)).not.toContain("\n");
  });

  test("pretty on stdout indents the payload line", () => {
    latchJsonFormat({ stdout: { mode: "pretty", color: false }, stderr: { mode: "compact", color: false } });
    expect(formatJsonLine({ command: "doctor", ok: true })).toBe(
      JSON.stringify({ command: "doctor", ok: true }, null, 2),
    );
  });

  /**
   * `pithy <failing> --json > out.json` at a terminal. The file wants the parseable line and the screen
   * wants the readable one, and before this the run had to pick one.
   */
  test("each stream answers for its own reader — a compact file and a readable screen", () => {
    latchJsonFormat({ stdout: { mode: "compact", color: false }, stderr: { mode: "pretty", color: false } });
    expect(formatJsonLine({ a: 1 })).toBe('{"a":1}');
    const rendered = formatErrorJson(new ConflictError({ message: "Taken.", action: "Pick another." }).payload);
    expect(rendered).toContain("\n");
    expect(JSON.parse(rendered)).toEqual({
      error: { code: "core/conflict", status: 409, message: "Taken.", action: "Pick another." },
    });
  });

  test("and the other way round — a readable payload and a compact error", () => {
    latchJsonFormat({ stdout: { mode: "pretty", color: false }, stderr: { mode: "compact", color: false } });
    expect(formatJsonLine({ a: 1 })).toContain("\n");
    expect(formatErrorJson(new ConflictError({ message: "Taken." }).payload)).not.toContain("\n");
  });

  test("pretty output still parses — indenting changes bytes, never the document", () => {
    latchJsonFormat({ stdout: { mode: "pretty", color: false }, stderr: { mode: "pretty", color: false } });
    const payload = { command: "doctor", findings: [{ code: "node/old" }], count: 1 };
    expect(JSON.parse(formatJsonLine(payload))).toEqual(payload);
  });
});

/**
 * The error line a `--json` caller parses is written to stderr, so it is `process.stderr.isTTY` that
 * decides it. Asserted through `withErrorReporting`, which is the only path that writes it.
 */
describe("withErrorReporting under a pretty stderr", () => {
  afterEach(() => {
    latchJsonFormat(COMPACT);
  });

  test("writes the indented envelope, and it parses", async () => {
    latchJsonFormat({ stdout: { mode: "compact", color: false }, stderr: { mode: "pretty", color: false } });
    const written: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    await withErrorReporting(true, async () => {
      throw new ConflictError({ message: "Taken.", action: "Pick another." });
    });
    const rendered = written.join("");
    expect(rendered).toContain("\n  ");
    expect(JSON.parse(rendered)).toEqual({
      error: { code: "core/conflict", status: 409, message: "Taken.", action: "Pick another." },
    });
    vi.restoreAllMocks();
  });
});

describe("formatError", () => {
  test("problem line, then action line", () => {
    const error = new NotFoundError({ message: "No such thing.", action: "Try another." });
    expect(formatError(error.payload)).toBe("No such thing.\nTry another.");
  });

  test("a payload without an action is just the problem line", () => {
    const error = new InternalError({ message: "Broke." });
    expect(formatError(error.payload)).toBe("Broke.");
  });
});

describe("formatErrorJson", () => {
  test("wraps the operator payload under `error` — the remedy the terminal prints, in JSON", () => {
    const error = new ConflictError({ message: "Taken.", action: "Pick another." });
    expect(JSON.parse(formatErrorJson(error.payload))).toEqual({
      error: { code: "core/conflict", status: 409, message: "Taken.", action: "Pick another." },
    });
  });

  test("strips internal detail — the security boundary holds in --json too", () => {
    const error = new InternalError({ message: "Broke.", detail: "secret stack at db.ts:42" });
    const parsed = JSON.parse(formatErrorJson(error.payload)) as { error: Record<string, unknown> };
    expect(parsed.error.detail).toBeUndefined();
    expect(JSON.stringify(parsed)).not.toContain("secret stack");
  });

  test("keeps the operator remedy the HTTP surface refuses — this line has a different reader", () => {
    // Deliberately the opposite assertion to `audience.test.ts`, on the same payload. Whoever ran
    // the command can act on a wrangler binding; a browser is handed a description of a deployment.
    const error = new InternalError({
      message: "Broke.",
      action: "Bind a D1 database named DB in wrangler.jsonc.",
      detail: "secret stack at db.ts:42",
    });
    const parsed = JSON.parse(formatErrorJson(error.payload)) as { error: Record<string, unknown> };
    expect(parsed.error.action).toBe("Bind a D1 database named DB in wrangler.jsonc.");
    expect(JSON.stringify(HttpError.encode(error.payload))).not.toContain("wrangler.jsonc");
  });
});

describe("formatList", () => {
  test("aligns names into a column with two spaces before each description", () => {
    expect(
      formatList([
        { name: "auth", description: "Authentication and sessions." },
        { name: "storage", description: "R2-backed object storage." },
      ]),
    ).toBe(["auth     Authentication and sessions.", "storage  R2-backed object storage."].join("\n"));
  });

  test("an empty list is the empty string — the caller supplies any 'none' message", () => {
    expect(formatList([])).toBe("");
  });
});

describe("withErrorReporting", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function captureStderr() {
    const written: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    return written;
  }

  test("a PithyError prints the text problem/action lines and exits 1", async () => {
    const written = captureStderr();
    await withErrorReporting(false, async () => {
      throw new NotFoundError({ message: "Gone.", action: "Look elsewhere." });
    });
    expect(written.join("")).toBe("Gone.\nLook elsewhere.\n");
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  test("with json, a PithyError prints the envelope and exits 1", async () => {
    const written = captureStderr();
    await withErrorReporting(true, async () => {
      throw new ConflictError({ message: "Taken.", action: "Pick another." });
    });
    expect(JSON.parse(written.join("").trim())).toEqual({
      error: { code: "core/conflict", status: 409, message: "Taken.", action: "Pick another." },
    });
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  test("a non-PithyError is re-thrown — a CLI bug keeps its stack", async () => {
    captureStderr();
    await expect(
      withErrorReporting(false, async () => {
        throw new TypeError("boom");
      }),
    ).rejects.toThrow(TypeError);
    expect(process.exit).not.toHaveBeenCalled();
  });

  test("a clean run reports nothing and never exits", async () => {
    captureStderr();
    await withErrorReporting(false, async () => {});
    expect(process.exit).not.toHaveBeenCalled();
  });
});

/**
 * **`pithy dev --json` is a stream, and a stream's framing is not this feature's to change.**
 *
 * `docs/commands/dev.md` §`--json` promises one object per line for the life of a session, because a
 * session never ends and a consumer can only read it line by line. Indenting those objects would hand
 * that consumer `{` as its first line and break every one after it — at a terminal, and under exactly
 * the PTY-allocating agent harness `jsonMode.ts` exists to accommodate.
 *
 * So a stream line is compact, always, and says so at the call site rather than depending on how the
 * process happened to be latched.
 */
describe("formatJsonStreamLine", () => {
  afterEach(() => {
    latchJsonFormat(COMPACT);
  });

  test("is one compact line, whatever the latch says", () => {
    latchJsonFormat({ stdout: { mode: "pretty", color: false }, stderr: { mode: "pretty", color: false } });
    expect(formatJsonStreamLine({ command: "dev", event: "still-waiting", waiting: ["api"] })).toBe(
      '{"command":"dev","event":"still-waiting","waiting":["api"]}',
    );
  });

  test("is never painted, so a captured stream has no escape byte in it", () => {
    latchJsonFormat({ stdout: { mode: "pretty", color: true }, stderr: { mode: "pretty", color: true } });
    const line = formatJsonStreamLine({ n: 1, s: "x" });
    expect(line).not.toContain("\u001b");
    expect(line).toBe('{"n":1,"s":"x"}');
  });

  test("agrees with the document formatter whenever that one is compact", () => {
    latchJsonFormat(COMPACT);
    const payload = { command: "dev", workers: { api: { port: 8787 } } };
    expect(formatJsonStreamLine(payload)).toBe(formatJsonLine(payload));
  });
});

/**
 * The corruption case, at the formatter rather than through a pty: pretty was asked for, but the stream
 * is a file, so nothing is painted and the document still parses.
 */
describe("a pretty stream that is not a terminal", () => {
  afterEach(() => {
    latchJsonFormat(COMPACT);
  });

  test("is indented and unpainted, so a redirected --json error still parses", () => {
    latchJsonFormat({ stdout: { mode: "pretty", color: true }, stderr: { mode: "pretty", color: false } });
    const rendered = formatErrorJson(new ConflictError({ message: "Taken." }).payload);
    expect(rendered).not.toContain("\u001b");
    expect(rendered).toContain("\n  ");
    expect(JSON.parse(rendered)).toMatchObject({ error: { code: "core/conflict" } });
  });
});
