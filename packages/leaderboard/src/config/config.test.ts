// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { LeaderboardConfig, materializeSchedule, resolveBoard } from "./config";

const board = (overrides: Record<string, unknown> = {}) => ({
  key: "weekly-distance",
  direction: "desc" as const,
  ...overrides,
});

describe("LeaderboardConfig", () => {
  it("defaults a board to best-of aggregation, all-time window, and keep-all retention", () => {
    const config = LeaderboardConfig.parse({ boards: [board()] });
    const parsed = config.boards[0];
    expect(parsed?.aggregation).toBe("best");
    expect(parsed?.window).toBeUndefined();
    // Keep-all is the default: neither retention limit is set, so nothing is ever pruned.
    expect(parsed?.retain).toBeUndefined();
    expect(parsed?.retainDays).toBeUndefined();
  });

  it("accepts a window-count retention limit", () => {
    const config = LeaderboardConfig.parse({ boards: [board({ window: "0 0 * * *", retain: 12 })] });
    expect(config.boards[0]?.retain).toBe(12);
  });

  it("accepts an age-based retention limit", () => {
    const config = LeaderboardConfig.parse({ boards: [board({ window: "0 0 * * *", retainDays: 90 })] });
    expect(config.boards[0]?.retainDays).toBe(90);
  });

  it("rejects setting both retention limits on one board — their intents pull opposite ways", () => {
    expect(() =>
      LeaderboardConfig.parse({ boards: [board({ window: "0 0 * * *", retain: 12, retainDays: 90 })] }),
    ).toThrowError(/retain/i);
  });

  it("rejects retention on an all-time board, which has no window to expire", () => {
    expect(() => LeaderboardConfig.parse({ boards: [board({ retain: 12 })] })).toThrowError(/all-time|retention/i);
    expect(() => LeaderboardConfig.parse({ boards: [board({ retainDays: 30 })] })).toThrowError(/all-time|retention/i);
  });

  it("defaults rank to live — free and correct for the boards most adopters actually run", () => {
    expect(LeaderboardConfig.parse({ boards: [board()] }).rank).toBe("live");
  });

  it("defaults writes to server-authoritative, inverting the vendor norm", () => {
    expect(LeaderboardConfig.parse({ boards: [board()] }).serverAuthoritative).toBe(true);
  });

  it("defaults a board to the d1 store — the only value today, a seam for a future column store", () => {
    expect(LeaderboardConfig.parse({ boards: [board()] }).boards[0]?.store).toBe("d1");
  });

  it("rejects an unknown store value", () => {
    expect(() => LeaderboardConfig.parse({ boards: [board({ store: "clickhouse" })] })).toThrow();
  });

  it("defaults trackActivity off, so non-improving submissions are free", () => {
    expect(LeaderboardConfig.parse({ boards: [board()] }).boards[0]?.trackActivity).toBe(false);
  });

  it("accepts trackActivity true for a true last-seen timestamp", () => {
    expect(LeaderboardConfig.parse({ boards: [board({ trackActivity: true })] }).boards[0]?.trackActivity).toBe(true);
  });

  it("requires a direction — there is no sensible default for which way a score sorts", () => {
    expect(() => LeaderboardConfig.parse({ boards: [{ key: "distance" }] })).toThrow();
  });

  it("requires at least one board or family", () => {
    expect(() => LeaderboardConfig.parse({ boards: [] })).toThrow();
    expect(() => LeaderboardConfig.parse({ boards: [], families: [] })).toThrow();
  });

  it("rejects duplicate board keys, which would silently merge two boards' entries", () => {
    expect(() => LeaderboardConfig.parse({ boards: [board(), board()] })).toThrowError(/duplicate/i);
  });

  it("rejects a board key that is not URL-safe, since it is a path segment", () => {
    expect(() => LeaderboardConfig.parse({ boards: [board({ key: "Weekly Distance!" })] })).toThrow();
  });

  it("rejects a malformed window CRON at config time, not on the first submission", () => {
    expect(() => LeaderboardConfig.parse({ boards: [board({ window: "not a cron" })] })).toThrow();
  });

  it("accepts a calendar-month window", () => {
    expect(() => LeaderboardConfig.parse({ boards: [board({ window: "0 0 1 * *" })] })).not.toThrow();
  });

  it("rejects min above max, which would reject every possible score", () => {
    expect(() => LeaderboardConfig.parse({ boards: [board({ min: 100, max: 10 })] })).toThrowError(/min/i);
  });

  it("accepts min equal to max, a board with exactly one legal score", () => {
    expect(() => LeaderboardConfig.parse({ boards: [board({ min: 10, max: 10 })] })).not.toThrow();
  });

  it("rejects a materialize schedule that is not valid CRON", () => {
    expect(() => LeaderboardConfig.parse({ boards: [board()], rank: { materialize: "hourly" } })).toThrow();
  });

  it("accepts a materialize schedule", () => {
    const config = LeaderboardConfig.parse({ boards: [board()], rank: { materialize: "0 * * * *" } });
    expect(config.rank).toEqual({ materialize: "0 * * * *" });
  });

  it("rejects tiers that do not improve monotonically in the board's direction", () => {
    // On a `desc` board a later tier must require a higher score; 500 after 1000 is unreachable.
    expect(() =>
      LeaderboardConfig.parse({
        boards: [
          board({
            tiers: [
              { key: "silver", from: 1000 },
              { key: "gold", from: 500 },
            ],
          }),
        ],
      }),
    ).toThrowError(/tier/i);
  });

  it("accepts descending tier thresholds on an asc board, where a lower score is better", () => {
    expect(() =>
      LeaderboardConfig.parse({
        boards: [
          board({
            direction: "asc",
            tiers: [
              { key: "silver", from: 1000 },
              { key: "gold", from: 500 },
            ],
          }),
        ],
      }),
    ).not.toThrow();
  });
});

describe("resolveBoard", () => {
  it("returns the configured board", () => {
    const config = LeaderboardConfig.parse({ boards: [board()] });
    expect(resolveBoard(config, "weekly-distance")?.key).toBe("weekly-distance");
  });

  it("returns undefined for an unknown key rather than guessing", () => {
    const config = LeaderboardConfig.parse({ boards: [board()] });
    expect(resolveBoard(config, "nope")).toBeUndefined();
  });
});

const family = (overrides: Record<string, unknown> = {}) => ({
  pattern: "level/:levelId",
  direction: "asc" as const,
  ...overrides,
});

describe("board families", () => {
  it("accepts a family with no static boards beside it", () => {
    const config = LeaderboardConfig.parse({ boards: [], families: [family()] });
    expect(config.families[0]?.pattern).toBe("level/:levelId");
    expect(config.families[0]?.aggregation).toBe("best");
  });

  it("defaults to no families, so a board-only config parses as it always has", () => {
    expect(LeaderboardConfig.parse({ boards: [board()] }).families).toEqual([]);
  });

  it.each([
    "level",
    "level/abc",
    "level/:levelId/:variant",
    ":levelId",
    "Level/:levelId",
    "level/:",
    "level/:level-id",
  ])("rejects the pattern %s, which is not one static segment and one named id", (pattern) => {
    expect(() => LeaderboardConfig.parse({ boards: [], families: [family({ pattern })] })).toThrow();
  });

  it("holds a family to the same shape rules as a board", () => {
    expect(() => LeaderboardConfig.parse({ boards: [], families: [family({ min: 10, max: 1 })] })).toThrowError(
      /level\/:levelId/,
    );
    expect(() => LeaderboardConfig.parse({ boards: [], families: [family({ window: "nope" })] })).toThrow();
    expect(() => LeaderboardConfig.parse({ boards: [], families: [family({ retain: 3 })] })).toThrow();
  });

  it("rejects two families sharing a prefix", () => {
    expect(() =>
      LeaderboardConfig.parse({ boards: [], families: [family(), family({ pattern: "level/:other" })] }),
    ).toThrowError(/level/);
  });

  it("rejects a family prefix that is also a board key", () => {
    expect(() => LeaderboardConfig.parse({ boards: [board({ key: "level" })], families: [family()] })).toThrowError(
      /level/,
    );
  });

  it("accepts an allow hook and rejects anything else in its place", () => {
    const allow = () => true;
    expect(LeaderboardConfig.parse({ boards: [], families: [family({ allow })] }).families[0]?.allow).toBe(allow);
    expect(() => LeaderboardConfig.parse({ boards: [], families: [family({ allow: "yes" })] })).toThrow();
  });
});

describe("resolveBoard over families", () => {
  const config = LeaderboardConfig.parse({
    boards: [board()],
    families: [family({ window: "0 0 * * *", min: 0, tiers: [{ key: "fast", from: 60 }] })],
  });

  it("resolves a key matching a family to an instance carrying the family's shape", () => {
    const instance = resolveBoard(config, "level/abc");
    expect(instance).toMatchObject({
      key: "level/abc",
      direction: "asc",
      aggregation: "best",
      window: "0 0 * * *",
      min: 0,
      tiers: [{ key: "fast", from: 60 }],
    });
    expect(instance?.family?.pattern).toBe("level/:levelId");
  });

  it("accepts the ids real content uses: mixed case, digits, dashes and underscores", () => {
    expect(resolveBoard(config, "level/V1StGXR8_Z5jdHi6B-myT")?.key).toBe("level/V1StGXR8_Z5jdHi6B-myT");
  });

  it("leaves a static board without a family", () => {
    expect(resolveBoard(config, "weekly-distance")?.family).toBeUndefined();
  });

  it.each(["level", "level/", "levels/abc", "level/abc/def", "level/a b", "level/segment", `level/${"a".repeat(65)}`])(
    "does not resolve %s",
    (key) => {
      expect(resolveBoard(config, key)).toBeUndefined();
    },
  );
});

describe("materializeSchedule", () => {
  it("is undefined when rank is live", () => {
    expect(materializeSchedule(LeaderboardConfig.parse({ boards: [board()] }))).toBeUndefined();
  });

  it("is the cron when rank is materialized", () => {
    const config = LeaderboardConfig.parse({ boards: [board()], rank: { materialize: "0 * * * *" } });
    expect(materializeSchedule(config)).toBe("0 * * * *");
  });
});
