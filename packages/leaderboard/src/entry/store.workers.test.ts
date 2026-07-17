import { env } from "cloudflare:test";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { rollbackMigration, runMigrations } from "@pithy-sh/core/src/migrations/runner";
import type { MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import { LEADERBOARD_MIGRATION_ORDER } from "../capability";
import type { LeaderboardBoard } from "../config/config";
import { leaderboardDatabase } from "../data/tables";
import { leaderboard_0001_entries } from "../migrations/0001_entries";
import { entryStore } from "./store";

const WINDOW = "2026-07-13T00:00:00.000Z";
const T0 = new Date(1_700_000_000_000);
const later = (ms: number) => new Date(T0.getTime() + ms);

const board = (overrides: Partial<LeaderboardBoard> = {}): LeaderboardBoard =>
  ({
    key: "b1",
    store: "d1",
    direction: "desc",
    aggregation: "best",
    retain: 12,
    trackActivity: false,
    ...overrides,
  }) as LeaderboardBoard;

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

async function tables(): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'pithy_leaderboard_%' ORDER BY name",
  ).all<{ name: string }>();
  return results.map((row) => row.name);
}

const store = () => entryStore(leaderboardDatabase(env.DB));

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

describe("leaderboard_0001_entries", () => {
  test("up creates the tables", async () => {
    expect(await tables()).toEqual([
      "pithy_leaderboard_boards",
      "pithy_leaderboard_entries",
      "pithy_leaderboard_locks",
    ]);
  });

  test("down drops every table", async () => {
    const p = provider();
    const results = await rollbackMigration(env.DB, p);
    expect(results.map((r) => [r.migrationName, r.direction, r.status])).toEqual([
      ["0400_leaderboard_0001_entries", "Down", "Success"],
    ]);
    expect(await tables()).toEqual([]);
  });
});

describe("entryStore.submit — aggregation", () => {
  test("best keeps the higher score on a desc board", async () => {
    const s = store();
    await s.submit(board(), WINDOW, "u1", 10, T0, true);
    await s.submit(board(), WINDOW, "u1", 50, later(1000), true);
    await s.submit(board(), WINDOW, "u1", 20, later(2000), true);
    expect((await s.get("b1", WINDOW, "u1"))?.score).toBe(50);
  });

  test("best keeps the lower score on an asc board — direction-aware, not hardcoded", async () => {
    const s = store();
    const asc = board({ direction: "asc" });
    await s.submit(asc, WINDOW, "u1", 50, T0, true);
    await s.submit(asc, WINDOW, "u1", 10, later(1000), true);
    await s.submit(asc, WINDOW, "u1", 30, later(2000), true);
    expect((await s.get("b1", WINDOW, "u1"))?.score).toBe(10);
  });

  test("best moves achievedAt forward only when the score actually improves", async () => {
    const s = store();
    await s.submit(board(), WINDOW, "u1", 10, T0, true);
    await s.submit(board(), WINDOW, "u1", 50, later(1000), true);
    await s.submit(board(), WINDOW, "u1", 20, later(9000), true);
    expect((await s.get("b1", WINDOW, "u1"))?.achievedAt).toEqual(later(1000));
  });

  test("best does not reset achievedAt when the same score is submitted again", async () => {
    // First-to-reach wins, so a replay of an equal score must not cost the player their tiebreak.
    const s = store();
    await s.submit(board(), WINDOW, "u1", 50, T0, true);
    await s.submit(board(), WINDOW, "u1", 50, later(9000), true);
    expect((await s.get("b1", WINDOW, "u1"))?.achievedAt).toEqual(T0);
  });

  test("latest overwrites with the newest score even when it is worse", async () => {
    const s = store();
    const latest = board({ aggregation: "latest" });
    await s.submit(latest, WINDOW, "u1", 50, T0, true);
    await s.submit(latest, WINDOW, "u1", 10, later(1000), true);
    const entry = await s.get("b1", WINDOW, "u1");
    expect(entry?.score).toBe(10);
    expect(entry?.achievedAt).toEqual(later(1000));
  });

  test("sum accumulates every submission", async () => {
    const s = store();
    const sum = board({ aggregation: "sum" });
    await s.submit(sum, WINDOW, "u1", 10, T0, true);
    await s.submit(sum, WINDOW, "u1", 5, later(1000), true);
    await s.submit(sum, WINDOW, "u1", 7, later(2000), true);
    expect((await s.get("b1", WINDOW, "u1"))?.score).toBe(22);
  });

  test("keeps each window's aggregation state separate", async () => {
    const s = store();
    await s.submit(board(), WINDOW, "u1", 50, T0, true);
    await s.submit(board(), "2026-07-20T00:00:00.000Z", "u1", 5, later(1000), true);
    expect((await s.get("b1", WINDOW, "u1"))?.score).toBe(50);
    expect((await s.get("b1", "2026-07-20T00:00:00.000Z", "u1"))?.score).toBe(5);
  });

  test("keeps each board's state separate", async () => {
    const s = store();
    await s.submit(board(), WINDOW, "u1", 50, T0, true);
    await s.submit(board({ key: "b2" }), WINDOW, "u1", 5, later(1000), true);
    expect((await s.get("b1", WINDOW, "u1"))?.score).toBe(50);
    expect((await s.get("b2", WINDOW, "u1"))?.score).toBe(5);
  });

  test("advances submittedAt on an improving submission", async () => {
    const s = store();
    await s.submit(board(), WINDOW, "u1", 10, T0, true);
    await s.submit(board(), WINDOW, "u1", 50, later(9000), true);
    expect((await s.get("b1", WINDOW, "u1"))?.submittedAt).toEqual(later(9000));
  });

  test("does NOT advance submittedAt on a non-improving submission by default (the guarded no-op)", async () => {
    // trackActivity: false skips a non-improving `best` submission entirely — 0 rows written — so
    // submittedAt reflects the last *improving* submission, not the last submission.
    const s = store();
    await s.submit(board(), WINDOW, "u1", 50, T0, true);
    await s.submit(board(), WINDOW, "u1", 1, later(9000), true);
    const entry = await s.get("b1", WINDOW, "u1");
    expect(entry?.submittedAt).toEqual(T0);
    expect(entry?.score).toBe(50);
  });

  test("advances submittedAt on every submission when trackActivity is true", async () => {
    const s = store();
    const tracked = board({ trackActivity: true });
    await s.submit(tracked, WINDOW, "u1", 50, T0, true);
    await s.submit(tracked, WINDOW, "u1", 1, later(9000), true);
    const entry = await s.get("b1", WINDOW, "u1");
    expect(entry?.submittedAt).toEqual(later(9000));
    // The score is still the best — trackActivity changes the write policy, not the aggregation.
    expect(entry?.score).toBe(50);
  });

  test("honours the configured default visibility on a new entry", async () => {
    const s = store();
    await s.submit(board(), WINDOW, "u1", 50, T0, false);
    expect((await s.get("b1", WINDOW, "u1"))?.visible).toBe(false);
  });

  test("does not reset a player's visibility choice on a later submission", async () => {
    const s = store();
    await s.submit(board(), WINDOW, "u1", 10, T0, true);
    await s.setVisibility("b1", WINDOW, "u1", false);
    await s.submit(board(), WINDOW, "u1", 50, later(1000), true);
    expect((await s.get("b1", WINDOW, "u1"))?.visible).toBe(false);
  });
});

describe("entryStore — moderation and consent", () => {
  test("hide marks an entry hidden without deleting the score", async () => {
    const s = store();
    await s.submit(board(), WINDOW, "u1", 50, T0, true);
    expect(await s.hide("b1", WINDOW, "u1", true)).toBe(true);
    const entry = await s.get("b1", WINDOW, "u1");
    expect(entry?.hidden).toBe(true);
    expect(entry?.score).toBe(50);
  });

  test("hide reports false for a player with no entry", async () => {
    expect(await store().hide("b1", WINDOW, "ghost", true)).toBe(false);
  });

  test("remove deletes the entry outright", async () => {
    const s = store();
    await s.submit(board(), WINDOW, "u1", 50, T0, true);
    expect(await s.remove("b1", WINDOW, "u1")).toBe(true);
    expect(await s.get("b1", WINDOW, "u1")).toBeUndefined();
  });

  test("remove reports false for a player with no entry", async () => {
    expect(await store().remove("b1", WINDOW, "ghost")).toBe(false);
  });

  test("setVisibility reports false for a player with no entry", async () => {
    expect(await store().setVisibility("b1", WINDOW, "ghost", false)).toBe(false);
  });
});

describe("entryStore.pruneWindowsBefore", () => {
  test("deletes entries in windows chronologically before the cutoff, keeps the cutoff and newer", async () => {
    const s = store();
    await s.submit(board(), "2026-07-13T00:00:00.000Z", "u1", 1, T0, true);
    await s.submit(board(), "2026-07-12T00:00:00.000Z", "u1", 1, T0, true);
    await s.submit(board(), "2026-07-11T00:00:00.000Z", "u1", 1, T0, true);
    const deleted = await s.pruneWindowsBefore("b1", "2026-07-12T00:00:00.000Z");
    expect(deleted).toBe(1);
    expect(await s.get("b1", "2026-07-11T00:00:00.000Z", "u1")).toBeUndefined();
    expect(await s.get("b1", "2026-07-12T00:00:00.000Z", "u1")).toBeDefined();
    expect(await s.get("b1", "2026-07-13T00:00:00.000Z", "u1")).toBeDefined();
  });

  test("never touches another board's entries", async () => {
    const s = store();
    await s.submit(board({ key: "b2" }), "2026-07-11T00:00:00.000Z", "u1", 1, T0, true);
    await s.pruneWindowsBefore("b1", "2026-07-13T00:00:00.000Z");
    expect(await s.get("b2", "2026-07-11T00:00:00.000Z", "u1")).toBeDefined();
  });

  test("never deletes an all-time window — `all` sorts after every date key", async () => {
    const s = store();
    await s.submit(board(), "all", "u1", 1, T0, true);
    expect(await s.pruneWindowsBefore("b1", "2026-07-13T00:00:00.000Z")).toBe(0);
    expect(await s.get("b1", "all", "u1")).toBeDefined();
  });
});
