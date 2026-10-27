// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { rating_0001_rating } from "./0001_rating";
import { rating_0002_outcome_log } from "./0002_outcome_log";

// A bare Kysely over the D1 binding — the migration operates on raw DDL, so no schema is needed.
function db(): Kysely<unknown> {
  return createDatabase(env.DB, {}) as unknown as Kysely<unknown>;
}

/** Everything 0001 creates, as it appears in SQLite's catalog. */
async function catalog(): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE name LIKE 'pithy_rating_%' ORDER BY name",
  ).all<{ name: string }>();
  return results.map((r) => r.name);
}

beforeEach(async () => {
  for (const table of [
    "pithy_rating_ratings",
    "pithy_rating_outcomes",
    "pithy_rating_outcome_players",
    "pithy_rating_adjustments",
  ]) {
    await env.DB.exec(`DROP TABLE IF EXISTS ${table}`);
  }
});

describe("rating_0001_rating", () => {
  test("up creates the ratings table and its two indexes", async () => {
    await rating_0001_rating.up(db());
    expect(await catalog()).toEqual([
      "pithy_rating_ratings",
      "pithy_rating_ratings_player_idx",
      "pithy_rating_ratings_skill_idx",
    ]);
  });

  test("down is the exact inverse — nothing of the migration survives", async () => {
    await rating_0001_rating.up(db());
    await rating_0001_rating.down?.(db());
    expect(await catalog()).toEqual([]);
  });

  test("up then down then up again is clean (rollback is re-runnable)", async () => {
    await rating_0001_rating.up(db());
    await rating_0001_rating.down?.(db());
    await rating_0001_rating.up(db());
    expect(await catalog()).toContain("pithy_rating_ratings");
  });
});

describe("rating_0002_outcome_log", () => {
  test("up creates the outcome log, its participants, the adjustments, and their indexes", async () => {
    await rating_0001_rating.up(db());
    await rating_0002_outcome_log.up(db());
    expect(await catalog()).toEqual([
      "pithy_rating_adjustments",
      "pithy_rating_adjustments_key_idx",
      "pithy_rating_adjustments_player_idx",
      "pithy_rating_outcome_players",
      "pithy_rating_outcome_players_outcome_idx",
      "pithy_rating_outcome_players_player_idx",
      "pithy_rating_outcomes",
      "pithy_rating_outcomes_pool_idx",
      "pithy_rating_outcomes_result_idx",
      "pithy_rating_ratings",
      "pithy_rating_ratings_player_idx",
      "pithy_rating_ratings_skill_idx",
    ]);
  });

  test("down removes exactly what up added and leaves the ratings table standing", async () => {
    await rating_0001_rating.up(db());
    await rating_0002_outcome_log.up(db());
    await rating_0002_outcome_log.down?.(db());
    expect(await catalog()).toEqual([
      "pithy_rating_ratings",
      "pithy_rating_ratings_player_idx",
      "pithy_rating_ratings_skill_idx",
    ]);
  });

  test("an idempotency key is spent once, and a player appears once per outcome", async () => {
    await rating_0001_rating.up(db());
    await rating_0002_outcome_log.up(db());
    const adjustment =
      "INSERT INTO pithy_rating_adjustments (idempotency_key, act, pool, user_id, reason, before, after, floor_entry, at) VALUES ('k1', 'reset', 'duel', 'u1', 'why', NULL, '{}', 0, 1)";
    await env.DB.exec(adjustment);
    await expect(env.DB.exec(adjustment)).rejects.toThrow(/UNIQUE/);
    const player =
      "INSERT INTO pithy_rating_outcome_players (outcome_id, pool, user_id, state_before, xp_before, games_before, xp_gained) VALUES (1, 'duel', 'u1', '{}', 0, 0, 0)";
    await env.DB.exec(player);
    await expect(env.DB.exec(player)).rejects.toThrow(/UNIQUE/);
  });

  test("up then down then up again is clean (rollback is re-runnable)", async () => {
    await rating_0001_rating.up(db());
    await rating_0002_outcome_log.up(db());
    await rating_0002_outcome_log.down?.(db());
    await rating_0002_outcome_log.up(db());
    expect(await catalog()).toContain("pithy_rating_outcomes");
  });
});
