// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { formatDevLogRecord, isOutputRecord, parseDevLogRecord } from "./devLogRecord";

const at = "2026-07-27T00:00:00.000Z";

describe("parseDevLogRecord", () => {
  test("an output record is {ts, stream, text}", () => {
    expect(parseDevLogRecord(`{"ts":"${at}","stream":"stdout","text":"hello"}`)).toEqual({
      ts: at,
      stream: "stdout",
      text: "hello",
    });
  });

  test("a lifecycle record is {ts, event, …} for spawned, ready and exited", () => {
    expect(parseDevLogRecord(`{"ts":"${at}","event":"spawned","port":8787}`)).toEqual({
      ts: at,
      event: "spawned",
      port: 8787,
    });
    expect(parseDevLogRecord(`{"ts":"${at}","event":"ready"}`)).toEqual({ ts: at, event: "ready" });
    expect(parseDevLogRecord(`{"ts":"${at}","event":"exited","code":0}`)).toEqual({
      ts: at,
      event: "exited",
      code: 0,
    });
  });

  test("a signaled child's exit code is null, as it is everywhere else in the session", () => {
    expect(parseDevLogRecord(`{"ts":"${at}","event":"exited","code":null}`)).toEqual({
      ts: at,
      event: "exited",
      code: null,
    });
  });

  /** A file written by a later `pithy` is read by whatever is installed, so an unknown key is not a fault. */
  test("an unknown key is tolerated and dropped, never refused", () => {
    expect(parseDevLogRecord(`{"ts":"${at}","event":"ready","somethingNew":1}`)).toEqual({ ts: at, event: "ready" });
  });

  test("a session-scoped event has no shape here, so it does not parse", () => {
    expect(parseDevLogRecord(`{"ts":"${at}","event":"session-ready"}`)).toBeNull();
    expect(parseDevLogRecord(`{"ts":"${at}","event":"waiting","workers":["web"]}`)).toBeNull();
  });

  test("half a line, a blank line and a non-object are all nothing", () => {
    expect(parseDevLogRecord('{"ts":"2026-07')).toBeNull();
    expect(parseDevLogRecord("   ")).toBeNull();
    expect(parseDevLogRecord("[1,2]")).toBeNull();
  });
});

describe("formatDevLogRecord", () => {
  test("round-trips through the parse, which is the whole contract of the file", () => {
    const record = { ts: at, stream: "stderr", text: 'a "quoted" line\twith a tab' } as const;
    expect(parseDevLogRecord(formatDevLogRecord(record))).toEqual(record);
  });

  test("is one line, so a newline in the text cannot split a record", () => {
    expect(formatDevLogRecord({ ts: at, stream: "stdout", text: "a\nb" })).not.toContain("\n");
  });
});

describe("isOutputRecord", () => {
  test("tells the child's own line from its lifecycle", () => {
    expect(isOutputRecord({ ts: at, stream: "stdout", text: "x" })).toBe(true);
    expect(isOutputRecord({ ts: at, event: "ready" })).toBe(false);
  });
});
