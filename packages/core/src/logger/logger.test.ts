// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { InternalError } from "../error/pithyError";
import { createLogger, type Logger, type LogSink, noopLogger } from "./logger";
import type { LogRecord } from "./record";

/** A sink that captures every record, plus a logger over it fixed at `time: 1`. */
function capture(level: Parameters<typeof createLogger>[0]["level"] = "debug"): {
  records: LogRecord[];
  log: Logger;
} {
  const records: LogRecord[] = [];
  const sink: LogSink = (record) => records.push(record);
  return { records, log: createLogger({ level, sink, now: () => 1 }) };
}

describe("createLogger — levels", () => {
  test("each level emits a record carrying its level, msg, and time", () => {
    const { records, log } = capture();
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    expect(records.map((r) => [r.level, r.msg])).toEqual([
      ["debug", "d"],
      ["info", "i"],
      ["warn", "w"],
      ["error", "e"],
    ]);
    expect(records.every((r) => r.time === 1)).toBe(true);
  });

  test("drops records below the configured threshold", () => {
    const { records, log } = capture("warn");
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    expect(records.map((r) => r.level)).toEqual(["warn", "error"]);
  });
});

describe("createLogger — fields", () => {
  test("attaches structured fields, and omits `fields` when there are none", () => {
    const { records, log } = capture();
    log.info("with", { userId: "u1", count: 3 });
    log.info("without");
    expect(records[0]?.fields).toEqual({ userId: "u1", count: 3 });
    expect(records[1]?.fields).toBeUndefined();
  });
});

describe("createLogger — error lifting", () => {
  test("lifts a carried PithyError into `error`, with its detail, and removes it from fields", () => {
    const { records, log } = capture();
    log.error("audit event dropped", {
      error: new InternalError({ message: "boom", detail: "SQLITE_BUSY" }),
      request: "r1",
    });
    expect(records[0]?.error).toMatchObject({ code: "core/internal", message: "boom", detail: "SQLITE_BUSY" });
    expect(records[0]?.fields).toEqual({ request: "r1" });
    expect(records[0]?.fields?.error).toBeUndefined();
  });

  test("lifts a raw ErrorPayload-shaped object too", () => {
    const { records, log } = capture();
    log.error("failed", { error: { code: "auth/forbidden", status: 403, message: "no" } });
    expect(records[0]?.error).toMatchObject({ code: "auth/forbidden", status: 403 });
    expect(records[0]?.fields).toBeUndefined();
  });

  test("a plain non-error `error`-keyed value stays an ordinary field", () => {
    const { records, log } = capture();
    log.info("ok", { error: "just a string" });
    expect(records[0]?.error).toBeUndefined();
    expect(records[0]?.fields).toEqual({ error: "just a string" });
  });

  test("an object named `error` that isn't a namespaced payload is NOT lifted (stays a field)", () => {
    const { records, log } = capture();
    // No `/` in code, status out of HTTP range — ordinary data that happens to be shaped like this.
    log.info("job", { error: { code: "retry", status: 3 } });
    expect(records[0]?.error).toBeUndefined();
    expect(records[0]?.fields).toEqual({ error: { code: "retry", status: 3 } });
  });
});

describe("createLogger — child", () => {
  test("child(name) namespaces the record; nesting composes as parent:child", () => {
    const { records, log } = capture();
    log.child("auth").info("a");
    log.child("auth").child("session").info("b");
    expect(records[0]?.name).toBe("auth");
    expect(records[1]?.name).toBe("auth:session");
  });

  test("child(undefined, fields) binds fields without renaming — the request-correlation form", () => {
    const { records, log } = capture();
    const bound = log.child(undefined, { request: "r1", method: "GET" });
    bound.info("in");
    bound.child("auth").info("sub");
    expect(records[0]?.name).toBeUndefined();
    expect(records[0]?.fields).toEqual({ request: "r1", method: "GET" });
    expect(records[1]?.name).toBe("auth");
    expect(records[1]?.fields).toEqual({ request: "r1", method: "GET" });
  });

  test("call fields override bound fields of the same name", () => {
    const { records, log } = capture();
    log.child(undefined, { env: "production" }).info("x", { env: "staging" });
    expect(records[0]?.fields).toEqual({ env: "staging" });
  });
});

describe("noopLogger", () => {
  test("drops everything and returns itself from child", () => {
    expect(() => {
      noopLogger.debug("d");
      noopLogger.error("e", { error: new InternalError({ message: "x" }) });
    }).not.toThrow();
    expect(noopLogger.child("x")).toBe(noopLogger);
  });
});
