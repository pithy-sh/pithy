import { ConflictError, InternalError, NotFoundError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, describe, expect, test, vi } from "vitest";
import { formatDone, formatError, formatErrorJson, formatJsonLine, formatList, withErrorReporting } from "./output";

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
  test("wraps the public payload under `error`, matching the HTTP surface", () => {
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
