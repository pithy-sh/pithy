// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { encodeCursor } from "@pithy-sh/core/src/data/cursor";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import type { RatingRecord } from "../data/rating";
import { ratingStore } from "../data/store";
import { ratingDatabase } from "../data/tables";
import { rating_0001_rating } from "../migrations/0001_rating";
import { rating_0002_outcome_log } from "../migrations/0002_outcome_log";
import { listRatings } from "./read";

/**
 * `listRatings`' keyset, directly, against real D1. Skill is not unique, so the order is `(skill, id)`
 * descending and a page boundary that falls inside a run of equal skills is the case that loses or repeats
 * a row when the tie-break is wrong.
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

const db = () => ratingDatabase(env.DB);

function record(userId: string, skill: number, pool = "duel"): RatingRecord {
  return {
    id: 0,
    pool,
    userId,
    algorithm: "elo",
    state: { rating: skill },
    skill,
    xp: 0,
    games: 1,
    updatedAt: new Date("2026-10-20T12:00:00.000Z"),
  };
}

/** Inserted in this order, so ids 1..6: three players share 1500 between a higher and a lower one. */
async function seed(): Promise<void> {
  const store = ratingStore(db());
  for (const [userId, skill] of [
    ["ada", 1600],
    ["bob", 1500],
    ["cy", 1500],
    ["dan", 1500],
    ["eve", 1400],
    ["fay", 1500],
  ] as const) {
    await store.upsert(record(userId, skill));
  }
  await store.upsert(record("other", 1550, "elsewhere"));
}

/** Skill descending, then id descending: fay (6), dan (4), cy (3), bob (2) for the 1500s. */
const ORDER = ["ada", "fay", "dan", "cy", "bob", "eve"];

async function walk(limit: number): Promise<{ users: string[]; pages: number }> {
  const users: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = await listRatings(db(), "duel", { cursor, limit });
    users.push(...page.items.map((row) => row.userId));
    cursor = page.nextCursor ?? undefined;
    pages++;
  } while (cursor && pages < 20);
  return { users, pages };
}

describe("listRatings", () => {
  test("highest skill first, equal skills by id descending, one pool only", async () => {
    await seed();
    const page = await listRatings(db(), "duel", { limit: 100 });
    expect(page.items.map((row) => row.userId)).toEqual(ORDER);
    expect(page.nextCursor).toBeNull();
  });

  test("one row a page crosses every tie with no repeat and no gap", async () => {
    await seed();
    expect(await walk(1)).toEqual({ users: ORDER, pages: 6 });
  });

  test("two rows a page splits the run of equal skills and still resumes exactly", async () => {
    await seed();
    expect(await walk(2)).toEqual({ users: ORDER, pages: 3 });
  });

  test("a cursor that is not one of ours reads as the first page", async () => {
    await seed();
    const first = await listRatings(db(), "duel", { limit: 2 });
    // A string where the column is a number is foreign even when it spells one: SQLite would coerce it to
    // the column's affinity and resume part-way down the list instead of at the top.
    for (const cursor of [
      "garbage",
      encodeCursor({ sort: "1500", id: 4 }),
      encodeCursor({ sort: 1500, id: "x" }),
      encodeCursor({ sort: "x", id: "y" }),
    ]) {
      expect(await listRatings(db(), "duel", { cursor, limit: 2 }), cursor).toEqual(first);
    }
  });
});
