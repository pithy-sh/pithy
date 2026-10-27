// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { MAX_BOUND_PARAMETERS, recordBoundParameters } from "@pithy-sh/core/src/data/boundParameters";
import { encodeCursor } from "@pithy-sh/core/src/data/cursor";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { rating_0001_rating } from "../migrations/0001_rating";
import { rating_0002_outcome_log } from "../migrations/0002_outcome_log";
import { RatingAdjustment, type RatingAdjustmentAct } from "./adjustment";
import { outcomeLog } from "./log";
import { RatingOutcome, RatingOutcomePlayer } from "./outcome";
import {
  RATING_ADJUSTMENTS_TABLE,
  RATING_OUTCOME_PLAYERS_TABLE,
  RATING_OUTCOMES_TABLE,
  type RatingDatabase,
  ratingDatabase,
} from "./tables";

/**
 * The outcome log's reads, directly, against real D1 — the unit every replay, void and management read
 * stands on. Rows are written here by hand through each table's schema, so what is under test is the read
 * alone: which rows it picks, in which order, and that a long `IN` list is chunked rather than refused.
 */

beforeEach(async () => {
  for (const table of [
    "pithy_rating_ratings",
    "pithy_rating_outcomes",
    "pithy_rating_outcome_players",
    "pithy_rating_adjustments",
  ]) {
    await env.DB.exec(`DROP TABLE IF EXISTS ${table}`);
  }
  const db = createDatabase(env.DB, {}) as unknown as Kysely<unknown>;
  await rating_0001_rating.up(db);
  await rating_0002_outcome_log.up(db);
});

const db = (): RatingDatabase => ratingDatabase(env.DB);
const at = new Date("2026-10-20T12:00:00.000Z");
const later = new Date("2026-10-21T12:00:00.000Z");

/** Encode a value through its table's schema and insert it without its surrogate key; returns the new id. */
async function insertOutcome(value: Partial<RatingOutcome> = {}): Promise<number> {
  const row = RatingOutcome.encode({
    id: 0,
    pool: "duel",
    game: "duel",
    resultId: null,
    ranks: { ada: 1, bob: 2 },
    teams: null,
    sharedRoom: false,
    voidedAt: null,
    at,
    ...value,
  }) as Record<string, unknown>;
  delete row.id;
  const inserted = await db()
    .insertInto(RATING_OUTCOMES_TABLE)
    .values(row as never)
    .returning("id")
    .executeTakeFirstOrThrow();
  return inserted.id;
}

async function insertPlayer(outcomeId: number, userId: string, pool = "duel"): Promise<number> {
  const row = RatingOutcomePlayer.encode({
    id: 0,
    outcomeId,
    pool,
    userId,
    stateBefore: { rating: 1500 },
    xpBefore: 0,
    gamesBefore: 0,
    xpGained: 10,
  }) as Record<string, unknown>;
  delete row.id;
  const inserted = await db()
    .insertInto(RATING_OUTCOME_PLAYERS_TABLE)
    .values(row as never)
    .returning("id")
    .executeTakeFirstOrThrow();
  return inserted.id;
}

const SNAPSHOT = { algorithm: "elo", state: { rating: 1500 }, skill: 1500, xp: 0, games: 0 };

async function insertAdjustment(
  act: RatingAdjustmentAct,
  floorEntry: number,
  extra: { userId?: string; pool?: string; idempotencyKey?: string } = {},
): Promise<string> {
  const idempotencyKey = extra.idempotencyKey ?? crypto.randomUUID();
  const row = RatingAdjustment.encode({
    id: 0,
    idempotencyKey,
    act,
    pool: extra.pool ?? "duel",
    userId: extra.userId ?? "ada",
    reason: "Test.",
    before: SNAPSHOT,
    after: SNAPSHOT,
    floorEntry,
    at,
  }) as Record<string, unknown>;
  delete row.id;
  await db()
    .insertInto(RATING_ADJUSTMENTS_TABLE)
    .values(row as never)
    .execute();
  return idempotencyKey;
}

/** One outcome with ada and bob in it; returns ada's entry id. */
async function game(pool = "duel"): Promise<{ outcome: number; entry: number }> {
  const outcome = await insertOutcome({ pool });
  const entry = await insertPlayer(outcome, "ada", pool);
  await insertPlayer(outcome, "bob", pool);
  return { outcome, entry };
}

describe("playerEntries", () => {
  test("one player's rows in one pool, oldest first", async () => {
    const first = await game();
    await game("other");
    const second = await game();

    const entries = await outcomeLog(db()).playerEntries("duel", "ada");

    expect(entries.map((entry) => entry.id)).toEqual([first.entry, second.entry]);
    expect(entries.every((entry) => entry.userId === "ada" && entry.pool === "duel")).toBe(true);
  });
});

describe("playerPage", () => {
  test("pages one player's outcomes newest first, joined to the outcome, with no repeat and no gap", async () => {
    const games: { outcome: number; entry: number }[] = [];
    for (let index = 0; index < 5; index++) {
      games.push(await game());
      await game("other");
    }
    const log = outcomeLog(db());

    const seen: { entry: number; outcome: number }[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await log.playerPage("duel", "ada", { cursor, limit: 2 });
      for (const item of page.items) {
        expect(item.entry.userId).toBe("ada");
        expect(item.outcome.id).toBe(item.entry.outcomeId);
        seen.push({ entry: item.entry.id, outcome: item.outcome.id });
      }
      cursor = page.nextCursor ?? undefined;
      pages++;
    } while (cursor && pages < 10);

    expect(pages).toBe(3);
    expect(seen).toEqual(games.reverse());
  });

  test("the last page says it is the last", async () => {
    await game();
    const page = await outcomeLog(db()).playerPage("duel", "ada", { limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeNull();
  });

  test("a cursor that is not one of ours reads as the first page", async () => {
    for (let index = 0; index < 3; index++) await game();
    const log = outcomeLog(db());
    const first = await log.playerPage("duel", "ada", { limit: 2 });

    // A string id is a foreign cursor even when it spells a number: SQLite would compare it with the integer
    // column numerically, and resume part-way through instead of at the top.
    for (const cursor of ["garbage", encodeCursor({ sort: "x", id: "y" }), encodeCursor({ sort: 2, id: "2" })]) {
      expect(await log.playerPage("duel", "ada", { cursor, limit: 2 }), cursor).toEqual(first);
    }
  });
});

describe("latestReset", () => {
  test("the newest reset, past a recalculation between two resets", async () => {
    const log = outcomeLog(db());
    await insertAdjustment("reset", 1);
    await insertAdjustment("recalculate", 2);
    const second = await insertAdjustment("reset", 3);
    // Every act stores a floor, a recalculation included. Only a reset's is a floor a replay starts from.
    await insertAdjustment("recalculate", 4);

    const found = await log.latestReset("duel", "ada");

    expect(found?.idempotencyKey).toBe(second);
    expect(found?.act).toBe("reset");
    expect(found?.floorEntry).toBe(3);
  });

  test("a recalculation alone is no floor", async () => {
    await insertAdjustment("recalculate", 5);
    expect(await outcomeLog(db()).latestReset("duel", "ada")).toBeUndefined();
  });

  test("another player's reset, or a reset in another pool, is not this player's floor", async () => {
    await insertAdjustment("reset", 1, { userId: "bob" });
    await insertAdjustment("reset", 2, { pool: "other" });
    expect(await outcomeLog(db()).latestReset("duel", "ada")).toBeUndefined();
  });
});

describe("byResult", () => {
  test("every outcome with the result id, voided or not, oldest first", async () => {
    const voided = await insertOutcome({ resultId: "r-1", voidedAt: later });
    await insertOutcome({ resultId: "r-2" });
    const counting = await insertOutcome({ resultId: "r-1" });
    await insertOutcome();

    const found = await outcomeLog(db()).byResult("r-1");

    expect(found.map((outcome) => [outcome.id, outcome.voidedAt])).toEqual([
      [voided, later],
      [counting, null],
    ]);
  });

  test("a result rating never saw has no outcomes", async () => {
    await insertOutcome({ resultId: "r-1" });
    expect(await outcomeLog(db()).byResult("r-unknown")).toEqual([]);
  });
});

describe("adjustment", () => {
  test("finds the act a key was spent on, and nothing for an unspent key", async () => {
    const key = await insertAdjustment("reset", 0);
    const log = outcomeLog(db());
    expect((await log.adjustment(key))?.act).toBe("reset");
    expect(await log.adjustment("unspent")).toBeUndefined();
  });
});

describe("participants and outcomes past one bound-parameter chunk", () => {
  const COUNT = MAX_BOUND_PARAMETERS * 2 + 50;

  async function many(): Promise<number[]> {
    const ids: number[] = [];
    for (let index = 0; index < COUNT; index++) {
      const outcome = await insertOutcome();
      await insertPlayer(outcome, `p${index}`);
      ids.push(outcome);
    }
    return ids;
  }

  test("participants returns every row of every outcome, once, in id order", { timeout: 60_000 }, async () => {
    const ids = await many();
    const rows = await outcomeLog(db()).participants(ids);
    expect(rows).toHaveLength(COUNT);
    expect(rows.map((row) => row.outcomeId)).toEqual(ids);
  });

  test("outcomes returns each outcome once, drops a missing id, and folds duplicates", {
    timeout: 60_000,
  }, async () => {
    const ids = await many();
    const rows = await outcomeLog(db()).outcomes([...ids, ...ids.slice(0, 10), 999_999]);
    expect(rows.map((row) => row.id)).toEqual(ids);
  });

  test("no statement binds more than D1 accepts", { timeout: 60_000 }, async () => {
    const ids = await many();
    const { counts, error } = await recordBoundParameters(env.DB, async (d1) => {
      const log = outcomeLog(ratingDatabase(d1));
      await log.participants(ids);
      await log.outcomes(ids);
    });
    if (error) throw error;
    expect(counts.length).toBeGreaterThan(2);
    expect(Math.max(...counts)).toBeLessThanOrEqual(MAX_BOUND_PARAMETERS);
  });
});
