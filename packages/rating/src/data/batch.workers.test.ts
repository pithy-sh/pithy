// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { rating_0001_rating } from "../migrations/0001_rating";
import { rating_0002_outcome_log } from "../migrations/0002_outcome_log";
import { RatingAdjustment } from "./adjustment";
import { isUniqueViolation, runBatch } from "./batch";
import { RATING_ADJUSTMENTS_TABLE, type RatingDatabase, ratingDatabase } from "./tables";

/**
 * `runBatch` and `isUniqueViolation`, directly, against real D1. The second is what tells a lost
 * idempotency race — answered as a replay — from a real failure, which is rethrown; so it is held to the
 * error D1 itself raises, not to a string somebody typed.
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

const SNAPSHOT = { algorithm: "elo", state: { rating: 1500 }, skill: 1500, xp: 0, games: 0 };

function insertAct(db: RatingDatabase, idempotencyKey: string) {
  const row = RatingAdjustment.encode({
    id: 0,
    idempotencyKey,
    act: "reset",
    pool: "duel",
    userId: "ada",
    reason: "Test.",
    before: null,
    after: SNAPSHOT,
    floorEntry: 0,
    at: new Date("2026-10-20T12:00:00.000Z"),
  }) as Record<string, unknown>;
  delete row.id;
  return db.insertInto(RATING_ADJUSTMENTS_TABLE).values(row as never);
}

async function count(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM pithy_rating_adjustments").first<{ n: number }>();
  return row?.n ?? 0;
}

/** The error D1 raises when a batch repeats a unique key. */
async function uniqueViolation(): Promise<unknown> {
  const db = ratingDatabase(env.DB);
  await runBatch(db, [insertAct(db, "k-1")]);
  try {
    await runBatch(db, [insertAct(db, "k-1")]);
  } catch (error) {
    return error;
  }
  throw new Error("D1 accepted a repeated idempotency key");
}

describe("runBatch", () => {
  test("lands every statement, or none of them", async () => {
    const db = ratingDatabase(env.DB);
    await runBatch(db, [insertAct(db, "a"), insertAct(db, "b")]);
    expect(await count()).toBe(2);

    await expect(runBatch(db, [insertAct(db, "c"), insertAct(db, "a")])).rejects.toThrow();
    expect(await count()).toBe(2);
  });

  test("refuses a database ratingDatabase did not build, before writing anything", async () => {
    const foreign = createDatabase(env.DB, {}) as unknown as RatingDatabase;
    const attempt = runBatch(foreign, [insertAct(foreign, "a")]);
    await expect(attempt).rejects.toBeInstanceOf(InternalError);
    await expect(attempt).rejects.toMatchObject({ payload: { code: "core/internal" } });
    expect(await count()).toBe(0);
  });
});

describe("isUniqueViolation", () => {
  test("recognizes the error D1 raises for a repeated key, and its string form", async () => {
    const error = await uniqueViolation();
    expect(isUniqueViolation(error)).toBe(true);
    expect(isUniqueViolation(String(error))).toBe(true);
  });

  test("recognizes it wrapped as another error's cause", async () => {
    const error = await uniqueViolation();
    expect(isUniqueViolation(new Error("The batch failed.", { cause: error }))).toBe(true);
  });

  test("is false for any other failure", async () => {
    const db = ratingDatabase(env.DB);
    await env.DB.exec("DROP TABLE pithy_rating_adjustments");
    let other: unknown;
    try {
      await runBatch(db, [insertAct(db, "a")]);
    } catch (error) {
      other = error;
    }
    expect(other).toBeDefined();
    expect(isUniqueViolation(other)).toBe(false);
    expect(isUniqueViolation(new Error("NOT NULL constraint failed: pithy_rating_adjustments.reason"))).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
  });
});
