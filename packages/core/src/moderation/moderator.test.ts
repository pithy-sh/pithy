// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { createLogger } from "../logger/logger";
import type { LogRecord } from "../logger/record";
import { guardModerator, type ModerationContext, type ModerationVerdict, type TextModerator } from "./moderator";

function capture(): { log: ReturnType<typeof createLogger>; records: LogRecord[] } {
  const records: LogRecord[] = [];
  return { log: createLogger({ level: "debug", sink: (record) => records.push(record) }), records };
}

describe("guardModerator", () => {
  test("passes a verdict through, and the text and context reach the moderator", async () => {
    const seen: [string, ModerationContext][] = [];
    const inner: TextModerator = {
      async check(text, context) {
        seen.push([text, context]);
        return { verdict: "reject", reason: "classifier" };
      },
    };
    const guarded = guardModerator(inner, { timeoutMs: 1000, log: capture().log });
    expect(await guarded.check("Cave of Echoes", "title")).toEqual({ verdict: "reject", reason: "classifier" });
    expect(seen).toEqual([["Cave of Echoes", "title"]]);
  });

  test("a moderator that throws is review, never allow, and the log never holds the text", async () => {
    const { log, records } = capture();
    const inner: TextModerator = {
      check() {
        throw new TypeError("could not classify secret words");
      },
    };
    const guarded = guardModerator(inner, { timeoutMs: 1000, log });
    expect(await guarded.check("secret words", "handle")).toEqual({ verdict: "review", reason: "moderator_failed" });
    expect(records).toHaveLength(1);
    expect(records[0]?.level).toBe("warn");
    expect(JSON.stringify(records)).not.toContain("secret words");
  });

  test("a moderator whose promise rejects is review", async () => {
    const inner: TextModerator = { check: () => Promise.reject(new Error("upstream down")) };
    const guarded = guardModerator(inner, { timeoutMs: 1000, log: capture().log });
    expect(await guarded.check("x", "free_text")).toEqual({ verdict: "review", reason: "moderator_failed" });
  });

  test("a moderator that answers something that is not a verdict is review", async () => {
    const inner = { check: async () => ({ verdict: "maybe" }) } as unknown as TextModerator;
    const guarded = guardModerator(inner, { timeoutMs: 1000, log: capture().log });
    expect(await guarded.check("x", "title")).toEqual({ verdict: "review", reason: "moderator_failed" });
  });

  test("a moderator that does not answer in time is review", async () => {
    const { log, records } = capture();
    const inner: TextModerator = { check: () => new Promise<ModerationVerdict>(() => {}) };
    const guarded = guardModerator(inner, { timeoutMs: 5, log });
    expect(await guarded.check("x", "title")).toEqual({ verdict: "review", reason: "moderator_timeout" });
    expect(records[0]?.fields).toMatchObject({ context: "title", timeoutMs: 5 });
  });
});
