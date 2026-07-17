import { describe, expect, it } from "vitest";
import { LeaderboardBoardRecord } from "./boardRecord";
import { LeaderboardEntry } from "./entry";
import { LeaderboardLock } from "./lock";
import {
  LEADERBOARD_BOARDS_TABLE,
  LEADERBOARD_ENTRIES_TABLE,
  LEADERBOARD_LOCKS_TABLE,
  leaderboardTables,
} from "./tables";

/** camelCase here; `CamelCasePlugin` snake-cases it in the DDL. */
const toSnake = (name: string) => name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

describe("table prefixing (CLAUDE.md §Data layer)", () => {
  it("prefixes every provided table pithy_leaderboard_, so it can never clash with an adopter's own", () => {
    for (const name of Object.keys(leaderboardTables())) {
      expect(toSnake(name)).toMatch(/^pithy_leaderboard_/);
    }
  });

  it("names the tables the migration creates", () => {
    expect(Object.keys(leaderboardTables()).sort()).toEqual(
      [LEADERBOARD_BOARDS_TABLE, LEADERBOARD_ENTRIES_TABLE, LEADERBOARD_LOCKS_TABLE].sort(),
    );
  });
});

describe("LeaderboardLock codec round-trip", () => {
  it("encodes acquiredAt to ms-epoch and decodes it back to a Date", () => {
    const lock = { name: "rank-refresh", holder: "abc-123", acquiredAt: new Date(1_700_000_000_000) };
    const row = LeaderboardLock.encode(lock);
    expect(row.acquiredAt).toBe(1_700_000_000_000);
    expect(LeaderboardLock.parse(row)).toEqual(lock);
  });
});

describe("LeaderboardEntry codec round-trip", () => {
  const entry = {
    id: 7,
    boardId: "b1",
    windowKey: "2026-07-13T00:00:00.000Z",
    userId: "u1",
    score: 42.5,
    achievedAt: new Date(1_700_000_000_000),
    submittedAt: new Date(1_700_000_001_000),
    visible: true,
    hidden: false,
    rank: 3,
  };

  it("encodes dates to ms-epoch and booleans to 0|1, then decodes back", () => {
    const row = LeaderboardEntry.encode(entry);
    expect(row.achievedAt).toBe(1_700_000_000_000);
    expect(row.visible).toBe(1);
    expect(row.hidden).toBe(0);
    expect(LeaderboardEntry.parse(row)).toEqual(entry);
  });

  it("round-trips a null rank, the state of every entry before a refresh reaches it", () => {
    const withoutRank = { ...entry, rank: null };
    expect(LeaderboardEntry.parse(LeaderboardEntry.encode(withoutRank))).toEqual(withoutRank);
  });

  it("decodes the 0|1 a real D1 row actually carries", () => {
    const parsed = LeaderboardEntry.parse({ ...LeaderboardEntry.encode(entry), visible: 1, hidden: 0 });
    expect(parsed.visible).toBe(true);
    expect(parsed.hidden).toBe(false);
  });
});

describe("LeaderboardBoardRecord codec round-trip", () => {
  const record = {
    id: 1,
    boardKey: "b1",
    store: "d1" as const,
    direction: "desc" as const,
    aggregation: "best" as const,
    window: "0 0 * * 1",
    createdAt: new Date(1_700_000_000_000),
  };

  it("round-trips", () => {
    expect(LeaderboardBoardRecord.parse(LeaderboardBoardRecord.encode(record))).toEqual(record);
  });

  it("round-trips an all-time board's null window", () => {
    const allTime = { ...record, window: null };
    expect(LeaderboardBoardRecord.parse(LeaderboardBoardRecord.encode(allTime))).toEqual(allTime);
  });
});
