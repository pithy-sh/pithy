// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { rating_0001_rating } from "../migrations/0001_rating";
import type { RatingRecord } from "./rating";
import { ratingStore } from "./store";
import { ratingDatabase } from "./tables";

beforeEach(async () => {
  await env.DB.exec("DROP TABLE IF EXISTS pithy_rating_ratings");
  await rating_0001_rating.up(createDatabase(env.DB, {}) as unknown as Kysely<unknown>);
});

function record(userId: string, skill: number, xp: number): RatingRecord {
  return {
    id: 0,
    pool: "demo",
    userId,
    algorithm: "elo",
    state: { rating: skill },
    skill,
    xp,
    games: 1,
    updatedAt: new Date("2026-07-25T00:00:00Z"),
  };
}

describe("ratingStore", () => {
  test("round-trips a record through D1 (decode equals what was encoded)", async () => {
    const store = ratingStore(ratingDatabase(env.DB));
    await store.upsert(record("ada", 1520, 40));
    const got = await store.get("demo", "ada");
    expect(got?.skill).toBe(1520);
    expect(got?.xp).toBe(40);
    expect(got?.state).toEqual({ rating: 1520 });
    expect(got?.updatedAt).toBeInstanceOf(Date);
  });

  test("upsert updates in place on (pool, userId) rather than duplicating", async () => {
    const store = ratingStore(ratingDatabase(env.DB));
    await store.upsert(record("ada", 1500, 10));
    await store.upsert(record("ada", 1540, 30));
    const rows = await store.getMany("demo", ["ada"]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.skill).toBe(1540);
    expect(rows[0]?.xp).toBe(30);
  });

  test("getMany returns only existing players in the pool", async () => {
    const store = ratingStore(ratingDatabase(env.DB));
    await store.upsert(record("ada", 1500, 10));
    await store.upsert(record("alan", 1450, 5));
    const rows = await store.getMany("demo", ["ada", "alan", "ghost"]);
    expect(rows.map((r) => r.userId).sort()).toEqual(["ada", "alan"]);
  });

  test("get returns undefined for an unrated player", async () => {
    const store = ratingStore(ratingDatabase(env.DB));
    expect(await store.get("demo", "nobody")).toBeUndefined();
  });
});
