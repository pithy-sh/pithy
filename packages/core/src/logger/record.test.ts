// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { InternalError } from "../error/pithyError";
import { createLocalLogger } from "./local";
import { createLogger } from "./logger";
import { type LogRecord, serializeLogValue, serializeRecord } from "./record";
import { createWorkerLogger } from "./worker";

/** Log one call through the engine and hand back the record serialized and parsed again. */
function roundTrip(fields: Record<string, unknown>): Record<string, unknown> & { fields?: Record<string, unknown> } {
  const records: LogRecord[] = [];
  createLogger({ level: "debug", sink: (record) => records.push(record), now: () => 1 }).error("failed", fields);
  const [record] = records;
  if (!record) throw new Error("expected one record");
  return JSON.parse(serializeRecord(record)) as Record<string, unknown> & { fields?: Record<string, unknown> };
}

describe("serializeRecord — an Error in a field", () => {
  test("writes its name, message and stack", () => {
    const { fields } = roundTrip({ error: new TypeError("boom") });
    expect(fields?.error).toMatchObject({ name: "TypeError", message: "boom" });
    expect((fields?.error as { stack?: unknown } | undefined)?.stack).toEqual(expect.stringContaining("boom"));
  });

  test("writes its cause, and the cause's cause", () => {
    const inner = new RangeError("too far");
    const outer = new Error("read failed", { cause: new Error("parse failed", { cause: inner }) });
    const { fields } = roundTrip({ error: outer });
    expect(fields?.error).toMatchObject({
      name: "Error",
      message: "read failed",
      cause: { name: "Error", message: "parse failed", cause: { name: "RangeError", message: "too far" } },
    });
  });

  test("writes an Error nested in an object or an array", () => {
    const { fields } = roundTrip({ attempt: { last: new TypeError("a") }, all: [new TypeError("b")] });
    expect(fields?.attempt).toMatchObject({ last: { name: "TypeError", message: "a" } });
    expect(fields?.all).toMatchObject([{ name: "TypeError", message: "b" }]);
  });

  test("keeps a PithyError's payload, code, message and detail, under any key", () => {
    const { fields } = roundTrip({ failure: new InternalError({ message: "Store failed.", detail: "SQLITE_BUSY" }) });
    expect(fields?.failure).toMatchObject({
      name: "PithyError",
      message: "Store failed.",
      payload: { code: "core/internal", status: 500, message: "Store failed.", detail: "SQLITE_BUSY" },
    });
  });

  test("keeps the cause of a PithyError lifted from the error field", () => {
    const lifted = roundTrip({
      error: new InternalError({ message: "Store failed." }, { cause: new TypeError("boom") }),
    });
    expect(lifted.error).toMatchObject({ code: "core/internal", message: "Store failed." });
    expect(lifted.fields?.cause).toMatchObject({ name: "TypeError", message: "boom" });
  });

  test("a caller's own cause field is not overwritten by a lifted PithyError's cause", () => {
    const lifted = roundTrip({
      error: new InternalError({ message: "Store failed." }, { cause: new TypeError("boom") }),
      cause: "quota",
    });
    expect(lifted.fields?.cause).toBe("quota");
  });

  test("an error that is its own cause still serializes", () => {
    const error = new Error("loop");
    (error as { cause?: unknown }).cause = error;
    const { fields } = roundTrip({ error });
    expect(fields?.error).toMatchObject({ name: "Error", message: "loop", cause: "[Circular]" });
  });

  test("a cycle and a BigInt beside an error still serialize", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const { fields } = roundTrip({ error: new TypeError("boom"), cyclic, big: 10n });
    expect(fields?.cyclic).toEqual({ self: "[Circular]" });
    expect(fields?.big).toBe("10");
    expect(fields?.error).toMatchObject({ message: "boom" });
  });
});

describe("serializeLogValue", () => {
  test("serializes one field value through the same rules", () => {
    expect(JSON.parse(serializeLogValue(new TypeError("boom")))).toMatchObject({ name: "TypeError", message: "boom" });
    expect(serializeLogValue(10n)).toBe('"10"');
    expect(serializeLogValue(undefined)).toBe("undefined");
  });
});

/**
 * Every sink a logger writes through, as the line it would write for `log.error("failed", fields)`. A new
 * sink belongs in this table: the assertion below is the invariant every one of them must hold.
 */
const SINKS: Record<string, (fields: Record<string, unknown>) => string> = {
  serializeRecord: (fields) => {
    const records: LogRecord[] = [];
    createLogger({ level: "debug", sink: (record) => records.push(record) }).error("failed", fields);
    return records.map(serializeRecord).join("\n");
  },
  "worker logger, default emit": (fields) => {
    const seen: string[] = [];
    const original = console.log;
    console.log = (line: string) => seen.push(line);
    try {
      createWorkerLogger().error("failed", fields);
    } finally {
      console.log = original;
    }
    return seen.join("\n");
  },
  "local logger, json": (fields) => {
    const out: string[] = [];
    createLocalLogger({ json: true, write: (line) => out.push(line) }).error("failed", fields);
    return out.join("\n");
  },
  "local logger, human": (fields) => {
    const out: string[] = [];
    createLocalLogger({ write: (line) => out.push(line) }).error("failed", fields);
    return out.join("\n");
  },
};

describe("no sink writes an Error field as {}", () => {
  for (const [name, write] of Object.entries(SINKS)) {
    test(name, () => {
      const line = write({ error: new TypeError("boom"), nested: { why: new RangeError("too far") } });
      expect(line).toContain("TypeError");
      expect(line).toContain("boom");
      expect(line).toContain("RangeError");
      expect(line).toContain("too far");
      expect(line).not.toMatch(/(?:error|why)["=:]+\{\}/);
    });
  }
});
