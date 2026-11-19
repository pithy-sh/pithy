// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { PithyError } from "../error/pithyError";
import { resolveModeration } from "./config";
import { DEFAULT_MODERATION_TIMEOUT_MS, type TextModerator } from "./moderator";

describe("resolveModeration", () => {
  test("with no config, checks the shipped list", async () => {
    const { moderator, timeoutMs } = resolveModeration(undefined);
    expect(timeoutMs).toBe(DEFAULT_MODERATION_TIMEOUT_MS);
    expect(await moderator.check("shit", "handle")).toEqual({ verdict: "reject", reason: "blocklist" });
    expect(await moderator.check("crate", "handle")).toEqual({ verdict: "allow" });
  });

  test("words extend the shipped list", async () => {
    const { moderator } = resolveModeration({ words: ["crate"] });
    expect(await moderator.check("A Crate", "title")).toEqual({ verdict: "reject", reason: "blocklist" });
    expect(await moderator.check("shit", "title")).toEqual({ verdict: "reject", reason: "blocklist" });
  });

  test("includeShipped: false makes words the whole list", async () => {
    const { moderator } = resolveModeration({ words: ["crate"], includeShipped: false });
    expect(await moderator.check("crate", "title")).toEqual({ verdict: "reject", reason: "blocklist" });
    expect(await moderator.check("shit", "title")).toEqual({ verdict: "allow" });
  });

  test("a moderator of your own replaces the default", async () => {
    const own: TextModerator = { check: async () => ({ verdict: "review", reason: "classifier_unsure" }) };
    const { moderator } = resolveModeration({ moderator: own, timeoutMs: 500 });
    expect(moderator).toBe(own);
    expect(resolveModeration({ moderator: own, timeoutMs: 500 }).timeoutMs).toBe(500);
  });

  test("refuses a moderator beside a list, which it would never read", () => {
    const own: TextModerator = { check: async () => ({ verdict: "allow" }) };
    expect(() => resolveModeration({ moderator: own, words: ["crate"] })).toThrow(PithyError);
    try {
      resolveModeration({ moderator: own, includeShipped: false });
      expect.unreachable();
    } catch (error) {
      expect((error as PithyError).payload.action).toMatch(/blocklistModerator/);
    }
  });

  test.each([
    [{ words: ["--"] }],
    [{ words: ["cr*ate"] }],
    [{ moderator: { inspect: () => null } }],
    [{ timeoutMs: 0 }],
    [{ timeoutMs: 60_000 }],
    [{ blocklist: ["crate"] }],
  ])("refuses %j", (config) => {
    expect(() => resolveModeration(config)).toThrow(/moderation block/);
  });
});
