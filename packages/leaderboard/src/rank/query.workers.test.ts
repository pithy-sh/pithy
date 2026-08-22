// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import {
  boundParameterBudget,
  MAX_BOUND_PARAMETERS,
  recordBoundParameters,
} from "@pithy-sh/core/src/data/boundParameters";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import type { MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import { LEADERBOARD_MIGRATION_ORDER } from "../capability";
import type { LeaderboardBoard } from "../config/config";
import { leaderboardDatabase } from "../data/tables";
import { entryStore } from "../entry/store";
import { leaderboard_0001_entries } from "../migrations/0001_entries";
import { entriesAround, rankOf, topEntries } from "./query";
import { MAX_SEGMENT_SIZE, SEGMENT_FIXED_PARAMETERS } from "./segment";

const WINDOW = "all";
const T0 = new Date(1_700_000_000_000);
const later = (ms: number) => new Date(T0.getTime() + ms);

const board = (overrides: Partial<LeaderboardBoard> = {}): LeaderboardBoard =>
  ({ key: "b1", direction: "desc", aggregation: "best", retain: 12, ...overrides }) as LeaderboardBoard;

function provider(): MigrationProvider {
  const registry = createMigrationRegistry([
    {
      database: "app",
      namespace: "leaderboard",
      order: LEADERBOARD_MIGRATION_ORDER,
      migrations: { "0001_entries": leaderboard_0001_entries },
    },
  ]);
  const found = registry.app;
  if (!found) throw new Error('expected a provider for database "app"');
  return found;
}

const db = () => leaderboardDatabase(env.DB);
const store = () => entryStore(db());

beforeEach(async () => {
  for (const t of [
    "pithy_leaderboard_entries",
    "pithy_leaderboard_boards",
    "pithy_leaderboard_locks",
    "pithy_migrations",
    "pithy_migrations_lock",
  ]) {
    await env.DB.exec(`DROP TABLE IF EXISTS ${t}`);
  }
  await runMigrations(env.DB, provider());
});

/** u1=30, u2=20, u3=10 on a desc board. */
async function seed(b = board()): Promise<void> {
  const s = store();
  await s.submit(b, WINDOW, "u1", 30, T0, true);
  await s.submit(b, WINDOW, "u2", 20, T0, true);
  await s.submit(b, WINDOW, "u3", 10, T0, true);
}

describe("topEntries", () => {
  test("orders a desc board highest first and numbers ranks from one", async () => {
    await seed();
    const top = await topEntries(db(), board(), WINDOW, 10);
    expect(top.map((e) => [e.userId, e.rank])).toEqual([
      ["u1", 1],
      ["u2", 2],
      ["u3", 3],
    ]);
  });

  test("orders an asc board lowest first", async () => {
    const asc = board({ direction: "asc" });
    await seed(asc);
    const top = await topEntries(db(), asc, WINDOW, 10);
    expect(top.map((e) => e.userId)).toEqual(["u3", "u2", "u1"]);
  });

  test("breaks a tie by earliest achievedAt — first to reach the score wins", async () => {
    const s = store();
    await s.submit(board(), WINDOW, "late", 30, later(5000), true);
    await s.submit(board(), WINDOW, "early", 30, T0, true);
    const top = await topEntries(db(), board(), WINDOW, 10);
    expect(top.map((e) => e.userId)).toEqual(["early", "late"]);
  });

  test("breaks a full tie by userId, so the ordering is total and no two entries can tie", async () => {
    const s = store();
    await s.submit(board(), WINDOW, "u-b", 30, T0, true);
    await s.submit(board(), WINDOW, "u-a", 30, T0, true);
    const top = await topEntries(db(), board(), WINDOW, 10);
    expect(top.map((e) => [e.userId, e.rank])).toEqual([
      ["u-a", 1],
      ["u-b", 2],
    ]);
  });

  test("numbers ranks from the offset on a later page", async () => {
    await seed();
    const page = await topEntries(db(), board(), WINDOW, 2, 1);
    expect(page.map((e) => [e.userId, e.rank])).toEqual([
      ["u2", 2],
      ["u3", 3],
    ]);
  });

  test("omits an entry the player has not consented to show", async () => {
    await seed();
    await store().setVisibility("b1", WINDOW, "u2", false);
    const top = await topEntries(db(), board(), WINDOW, 10);
    expect(top.map((e) => e.userId)).toEqual(["u1", "u3"]);
  });

  test("omits an entry a moderator has hidden", async () => {
    await seed();
    await store().hide("b1", WINDOW, "u1", true);
    expect((await topEntries(db(), board(), WINDOW, 10)).map((e) => e.userId)).toEqual(["u2", "u3"]);
  });

  test("restricts to a segment without becoming a second board", async () => {
    await seed();
    const top = await topEntries(db(), board(), WINDOW, 10, 0, { segment: ["u1", "u3"] });
    expect(top.map((e) => [e.userId, e.rank])).toEqual([
      ["u1", 1],
      ["u3", 2],
    ]);
  });

  test("returns nothing for an empty segment rather than the whole board", async () => {
    await seed();
    expect(await topEntries(db(), board(), WINDOW, 10, 0, { segment: [] })).toEqual([]);
  });

  test("classifies tiers on read", async () => {
    await seed();
    const tiered = board({
      tiers: [
        { key: "bronze", from: 0 },
        { key: "gold", from: 25 },
      ],
    });
    const top = await topEntries(db(), tiered, WINDOW, 10);
    expect(top.map((e) => e.tier)).toEqual(["gold", "bronze", "bronze"]);
  });

  test("keeps each window's board separate", async () => {
    await seed();
    await store().submit(board(), "2026-07-13T00:00:00.000Z", "u9", 999, T0, true);
    expect((await topEntries(db(), board(), WINDOW, 10)).map((e) => e.userId)).toEqual(["u1", "u2", "u3"]);
  });
});

describe("rankOf (live)", () => {
  test("counts the entries that beat the player, plus one", async () => {
    await seed();
    expect((await rankOf(db(), board(), WINDOW, "u3", false))?.rank).toBe(3);
    expect((await rankOf(db(), board(), WINDOW, "u1", false))?.rank).toBe(1);
  });

  test("agrees with the top-N ordering on a tie", async () => {
    const s = store();
    await s.submit(board(), WINDOW, "late", 30, later(5000), true);
    await s.submit(board(), WINDOW, "early", 30, T0, true);
    expect((await rankOf(db(), board(), WINDOW, "early", false))?.rank).toBe(1);
    expect((await rankOf(db(), board(), WINDOW, "late", false))?.rank).toBe(2);
  });

  test("ranks an asc board from the lowest score", async () => {
    const asc = board({ direction: "asc" });
    await seed(asc);
    expect((await rankOf(db(), asc, WINDOW, "u3", false))?.rank).toBe(1);
  });

  test("returns null for a player who has never submitted", async () => {
    await seed();
    expect(await rankOf(db(), board(), WINDOW, "ghost", false)).toBeNull();
  });

  test("returns the score with a null rank when the player has opted out", async () => {
    await seed();
    await store().setVisibility("b1", WINDOW, "u1", false);
    const own = await rankOf(db(), board(), WINDOW, "u1", false);
    expect(own?.rank).toBeNull();
    expect(own?.entry.score).toBe(30);
  });

  test("does not count hidden entries against a player's rank", async () => {
    await seed();
    await store().hide("b1", WINDOW, "u1", true);
    expect((await rankOf(db(), board(), WINDOW, "u2", false))?.rank).toBe(1);
  });

  test("ranks within a segment", async () => {
    await seed();
    expect((await rankOf(db(), board(), WINDOW, "u3", false, { segment: ["u2", "u3"] }))?.rank).toBe(2);
  });
});

describe("rankOf (materialized)", () => {
  test("reads the stored rank column instead of counting", async () => {
    await seed();
    await env.DB.prepare("UPDATE pithy_leaderboard_entries SET rank = 42 WHERE user_id = 'u1'").run();
    expect((await rankOf(db(), board(), WINDOW, "u1", true))?.rank).toBe(42);
  });

  test("reports a null rank for an entry the refresh pass has not reached yet", async () => {
    await seed();
    expect((await rankOf(db(), board(), WINDOW, "u1", true))?.rank).toBeNull();
  });

  test("still returns a live score beside a stale rank", async () => {
    await seed();
    await env.DB.prepare("UPDATE pithy_leaderboard_entries SET rank = 42 WHERE user_id = 'u1'").run();
    await store().submit(board(), WINDOW, "u1", 99, later(1000), true);
    const own = await rankOf(db(), board(), WINDOW, "u1", true);
    expect(own?.entry.score).toBe(99);
    expect(own?.rank).toBe(42);
  });

  test("counts a segment rank live, since the stored column ranks the whole board", async () => {
    await seed();
    await env.DB.prepare("UPDATE pithy_leaderboard_entries SET rank = 42").run();
    expect((await rankOf(db(), board(), WINDOW, "u3", true, { segment: ["u2", "u3"] }))?.rank).toBe(2);
  });
});

describe("entriesAround", () => {
  test("centers the page on the player", async () => {
    const s = store();
    for (let i = 1; i <= 9; i++) await s.submit(board(), WINDOW, `u${i}`, 100 - i, T0, true);
    const around = await entriesAround(db(), board(), WINDOW, "u5", 2);
    expect(around.map((e) => [e.userId, e.rank])).toEqual([
      ["u3", 3],
      ["u4", 4],
      ["u5", 5],
      ["u6", 6],
      ["u7", 7],
    ]);
  });

  test("keeps the page full at the top of the board by shifting it down, not truncating it", async () => {
    // The leader has nobody above them. Returning a short page would make the board look emptier the
    // better you do, so the window shifts and stays radius*2+1 wide.
    const s = store();
    for (let i = 1; i <= 5; i++) await s.submit(board(), WINDOW, `u${i}`, 100 - i, T0, true);
    const around = await entriesAround(db(), board(), WINDOW, "u1", 2);
    expect(around.map((e) => [e.userId, e.rank])).toEqual([
      ["u1", 1],
      ["u2", 2],
      ["u3", 3],
      ["u4", 4],
      ["u5", 5],
    ]);
  });

  test("returns a short page at the bottom of the board, where there is nothing left to shift to", async () => {
    const s = store();
    for (let i = 1; i <= 3; i++) await s.submit(board(), WINDOW, `u${i}`, 100 - i, T0, true);
    const around = await entriesAround(db(), board(), WINDOW, "u3", 2);
    expect(around.map((e) => e.userId)).toEqual(["u1", "u2", "u3"]);
  });

  test("returns nothing for a player with no entry", async () => {
    await seed();
    expect(await entriesAround(db(), board(), WINDOW, "ghost", 2)).toEqual([]);
  });

  test("returns nothing for a player who has opted out", async () => {
    await seed();
    await store().setVisibility("b1", WINDOW, "u1", false);
    expect(await entriesAround(db(), board(), WINDOW, "u1", 2)).toEqual([]);
  });
});

/**
 * A segment is a caller-supplied list, so it is a bound-parameter producer like any other.
 *
 * The HTTP boundary already refuses one over {@link MAX_SEGMENT_SIZE}, and that is why this was never a
 * live defect. It is still a rule living at one call site: `topEntries` and `rankOf` are exported, an
 * adopter calls them directly, and a 120-friend segment reached D1 with 124 parameters. The library says
 * no now, with the same number the route says no with — found sweeping for a sixth producer of #250.
 */
describe("a segment and D1's bound-parameter ceiling", () => {
  test("the cap sits inside core's budget, with the margin its author left on purpose", () => {
    // Four filters plus the six the tiebreak predicate binds — the tightest of the segment queries.
    expect(MAX_SEGMENT_SIZE).toBeLessThanOrEqual(boundParameterBudget(SEGMENT_FIXED_PARAMETERS));
  });

  test("topEntries refuses a segment it cannot bind, naming the cap", async () => {
    await seed();
    const segment = Array.from({ length: MAX_SEGMENT_SIZE + 1 }, (_, index) => `u${index}`);

    const failure = await topEntries(db(), board(), WINDOW, 10, 0, { segment }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(PithyError);
    expect((failure as PithyError).payload.detail).toContain(String(MAX_SEGMENT_SIZE));
  });

  test("rankOf refuses one too", async () => {
    await seed();
    const segment = Array.from({ length: MAX_SEGMENT_SIZE + 1 }, (_, index) => `u${index}`);

    await expect(rankOf(db(), board(), WINDOW, "u1", false, { segment })).rejects.toBeInstanceOf(PithyError);
  });

  test("a segment at exactly the cap still reads, and binds no more than D1 accepts", async () => {
    await seed();
    const segment = ["u1", ...Array.from({ length: MAX_SEGMENT_SIZE - 1 }, (_, index) => `absent-${index}`)];

    const { counts, error } = await recordBoundParameters(env.DB, async (d1) => {
      await topEntries(leaderboardDatabase(d1), board(), WINDOW, 10, 0, { segment });
      await rankOf(leaderboardDatabase(d1), board(), WINDOW, "u1", false, { segment });
    });

    if (error) throw error;
    const worst = Math.max(...counts, 0);
    expect(
      worst,
      `one statement bound ${worst} parameters, over D1's cap of ${MAX_BOUND_PARAMETERS}`,
    ).toBeLessThanOrEqual(MAX_BOUND_PARAMETERS);
  });
});
